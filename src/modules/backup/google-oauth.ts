import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { CredentialRepository } from './credential.repository.js';

/** Só os arquivos que o próprio bot cria: o resto do seu Drive fica invisível para ele. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const REFRESH_TOKEN_KEY = 'google.drive.refreshToken';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Quanto tempo o link de autorização vale. */
export const AUTH_LINK_TTL_MS = 10 * 60 * 1000;

export type Fetch = typeof fetch;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Ex.: http://127.0.0.1:3000/oauth/google/callback (app para computador: retorno local). */
  redirectUri: string;
}

/**
 * - not_connected: ainda não autorizou;
 * - revoked: autorização removida ou vencida (reconectar com /backup);
 * - state: link de autorização inválido, já usado ou vencido;
 * - denied: você cancelou na tela do Google;
 * - failed: qualquer outra falha (rede, Google fora do ar).
 */
export type DriveAuthReason = 'not_connected' | 'revoked' | 'state' | 'denied' | 'failed';

export class DriveAuthError extends Error {
  constructor(
    readonly reason: DriveAuthReason,
    message: string,
  ) {
    super(message);
    this.name = 'DriveAuthError';
  }
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
});
type TokenResponse = z.infer<typeof tokenResponseSchema>;

/**
 * Autorização do Google Drive (OAuth de app para computador, com PKCE). O link é aberto
 * no navegador do computador do bot e o Google volta para o endereço local; o bot guarda
 * só o refresh token (tabela credentials) e renova o token de acesso sozinho.
 */
export class GoogleDriveAuth {
  /** Links gerados e ainda não usados: state → verificador PKCE. Só em memória. */
  private readonly pending = new Map<string, { verifier: string; expiresAt: number }>();
  private cached: { token: string; expiresAt: number } | null = null;
  private readonly fetch: Fetch;
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      config: GoogleOAuthConfig;
      credentials: CredentialRepository;
      fetch?: Fetch;
      now?: () => number;
    },
  ) {
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
  }

  async isConnected(): Promise<boolean> {
    return (await this.deps.credentials.get(REFRESH_TOKEN_KEY)) !== null;
  }

  /** Link para autorizar (vale 10 minutos e uma vez só). */
  authorizationUrl(): string {
    const now = this.now();
    for (const [state, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(state);
    }
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.pending.set(state, { verifier, expiresAt: now + AUTH_LINK_TTL_MS });
    const { clientId, redirectUri } = this.deps.config;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: DRIVE_SCOPE,
      // offline + consent: o Google devolve o refresh token (acesso sem você por perto).
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /** O retorno do Google: confere o state, troca o código e guarda o refresh token. */
  async finishAuthorization(params: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
  }): Promise<void> {
    const entry = params.state ? this.pending.get(params.state) : undefined;
    if (!params.state || !entry || entry.expiresAt <= this.now()) {
      throw new DriveAuthError('state', 'link de autorização inválido, já usado ou vencido');
    }
    this.pending.delete(params.state);
    if (params.error || !params.code) {
      throw new DriveAuthError('denied', `autorização cancelada (${params.error ?? 'sem código'})`);
    }

    let body: TokenResponse;
    try {
      body = await this.tokenRequest({
        grant_type: 'authorization_code',
        code: params.code,
        code_verifier: entry.verifier,
        redirect_uri: this.deps.config.redirectUri,
      });
    } catch (error) {
      // Aqui "invalid_grant" é código vencido, não autorização revogada.
      if (error instanceof DriveAuthError) throw new DriveAuthError('failed', error.message);
      throw error;
    }
    if (!body.refresh_token) {
      throw new DriveAuthError('failed', 'o Google não devolveu o refresh token');
    }
    await this.deps.credentials.set(REFRESH_TOKEN_KEY, body.refresh_token);
    this.remember(body);
  }

  /** Token de acesso válido, renovado quando falta menos de 1 minuto para vencer. */
  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) return this.cached.token;
    const refreshToken = await this.deps.credentials.get(REFRESH_TOKEN_KEY);
    if (!refreshToken) {
      throw new DriveAuthError('not_connected', 'Google Drive ainda não conectado');
    }
    try {
      const body = await this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      return this.remember(body);
    } catch (error) {
      // Autorização revogada: esquece a chave, e o /backup volta a mostrar o link.
      if (error instanceof DriveAuthError && error.reason === 'revoked') {
        await this.deps.credentials.delete(REFRESH_TOKEN_KEY);
        this.cached = null;
      }
      throw error;
    }
  }

  private remember(body: TokenResponse): string {
    this.cached = { token: body.access_token, expiresAt: this.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async tokenRequest(fields: Record<string, string>): Promise<TokenResponse> {
    const { clientId, clientSecret } = this.deps.config;
    let response: Response;
    try {
      response = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          ...fields,
        }).toString(),
      });
    } catch (error) {
      throw new DriveAuthError('failed', `sem conexão com o Google (${String(error)})`);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = (body as { error?: unknown } | null)?.error;
      if (code === 'invalid_grant') {
        throw new DriveAuthError('revoked', 'autorização do Google Drive removida ou vencida');
      }
      throw new DriveAuthError(
        'failed',
        `token do Google: HTTP ${String(response.status)}${typeof code === 'string' ? ` (${code})` : ''}`,
      );
    }
    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) throw new DriveAuthError('failed', 'resposta inesperada do Google');
    return parsed.data;
  }
}
