import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { inMemoryCredentials } from '../../test/in-memory-repositories.js';
import {
  AUTH_LINK_TTL_MS,
  DRIVE_SCOPE,
  GoogleDriveAuth,
  REFRESH_TOKEN_KEY,
} from './google-oauth.js';

const config = {
  clientId: 'cliente.apps.googleusercontent.com',
  clientSecret: 'segredo',
  redirectUri: 'http://127.0.0.1:3000/oauth/google/callback',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(responses: Response[] = []) {
  let now = 1_000_000;
  const credentials = inMemoryCredentials();
  const requests: URLSearchParams[] = [];
  const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    requests.push(new URLSearchParams(init?.body as string));
    return Promise.resolve(
      responses.shift() ?? json(200, { access_token: 'acesso', expires_in: 3600 }),
    );
  });
  const auth = new GoogleDriveAuth({ config, credentials, fetch, now: () => now });
  const stateOf = (url: string) => new URL(url).searchParams.get('state') ?? '';
  return {
    auth,
    credentials,
    requests,
    fetch,
    stateOf,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('GoogleDriveAuth', () => {
  it('o link pede só drive.file, acesso offline e PKCE', () => {
    const { auth } = setup();

    const url = new URL(auth.authorizationUrl());

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: DRIVE_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      response_type: 'code',
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{32}$/);
  });

  it('troca o código com o verificador do link e guarda o refresh token', async () => {
    const { auth, credentials, requests, stateOf } = setup([
      json(200, { access_token: 'acesso', expires_in: 3600, refresh_token: 'renovar' }),
    ]);
    const url = auth.authorizationUrl();

    await auth.finishAuthorization({ code: 'codigo', state: stateOf(url) });

    const sent = requests[0];
    expect(sent?.get('grant_type')).toBe('authorization_code');
    expect(sent?.get('code')).toBe('codigo');
    const challenge = createHash('sha256')
      .update(sent?.get('code_verifier') ?? '')
      .digest('base64url');
    expect(new URL(url).searchParams.get('code_challenge')).toBe(challenge);
    expect(credentials.values.get(REFRESH_TOKEN_KEY)).toBe('renovar');
    expect(await auth.isConnected()).toBe(true);
    expect(await auth.accessToken()).toBe('acesso'); // já em cache, sem nova chamada
    expect(requests).toHaveLength(1);
  });

  it('recusa state desconhecido, vencido ou já usado', async () => {
    const { auth, stateOf, advance } = setup([
      json(200, { access_token: 'a', expires_in: 3600, refresh_token: 'r' }),
    ]);

    await expect(auth.finishAuthorization({ code: 'c', state: 'inventado' })).rejects.toMatchObject(
      { reason: 'state' },
    );

    const expired = stateOf(auth.authorizationUrl());
    advance(AUTH_LINK_TTL_MS + 1);
    await expect(auth.finishAuthorization({ code: 'c', state: expired })).rejects.toMatchObject({
      reason: 'state',
    });

    const state = stateOf(auth.authorizationUrl());
    await auth.finishAuthorization({ code: 'c', state });
    await expect(auth.finishAuthorization({ code: 'c', state })).rejects.toMatchObject({
      reason: 'state',
    });
  });

  it('cancelado na tela do Google: denied, sem chamar o Google', async () => {
    const { auth, fetch, stateOf } = setup();

    await expect(
      auth.finishAuthorization({ error: 'access_denied', state: stateOf(auth.authorizationUrl()) }),
    ).rejects.toMatchObject({ reason: 'denied' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('renova o token de acesso quando está para vencer', async () => {
    const { auth, credentials, requests, advance } = setup([
      json(200, { access_token: 'primeiro', expires_in: 3600 }),
      json(200, { access_token: 'segundo', expires_in: 3600 }),
    ]);
    credentials.values.set(REFRESH_TOKEN_KEY, 'renovar');

    expect(await auth.accessToken()).toBe('primeiro');
    advance(3600_000 - 30_000);
    expect(await auth.accessToken()).toBe('segundo');
    expect(requests.map((r) => r.get('grant_type'))).toEqual(['refresh_token', 'refresh_token']);
    expect(requests[0]?.get('refresh_token')).toBe('renovar');
  });

  it('autorização revogada (invalid_grant): esquece a chave e avisa como revoked', async () => {
    const { auth, credentials } = setup([json(400, { error: 'invalid_grant' })]);
    credentials.values.set(REFRESH_TOKEN_KEY, 'renovar');

    await expect(auth.accessToken()).rejects.toMatchObject({ reason: 'revoked' });
    expect(await auth.isConnected()).toBe(false);
    await expect(auth.accessToken()).rejects.toMatchObject({ reason: 'not_connected' });
  });

  it('outras falhas do Google não apagam a chave', async () => {
    const { auth, credentials } = setup([json(503, { error: 'backend_error' })]);
    credentials.values.set(REFRESH_TOKEN_KEY, 'renovar');

    await expect(auth.accessToken()).rejects.toMatchObject({ reason: 'failed' });
    expect(await auth.isConnected()).toBe(true);
  });
});
