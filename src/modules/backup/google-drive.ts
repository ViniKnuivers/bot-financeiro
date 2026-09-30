import { randomBytes } from 'node:crypto';
import type { CredentialRepository } from './credential.repository.js';
import type { Fetch, GoogleDriveAuth } from './google-oauth.js';

export const FOLDER_NAME = 'Financeiro – backups';
export const FOLDER_ID_KEY = 'google.drive.folderId';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile {
  id: string;
  name: string;
  /** ISO 8601. */
  createdTime: string;
  bytes: number;
}

/** Onde os backups ficam guardados (o Google Drive; nos testes, um falso em memória). */
export interface BackupStorage {
  upload(name: string, data: Buffer): Promise<DriveFile>;
  /** Arquivos da pasta de backups, do mais novo para o mais velho. */
  list(): Promise<DriveFile[]>;
  /** Manda para a lixeira do Drive (que esvazia sozinha em 30 dias). */
  trash(id: string): Promise<void>;
}

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

interface RawFile {
  id?: string;
  name?: string;
  createdTime?: string;
  size?: string;
  trashed?: boolean;
}

/**
 * Corpo do upload "multipart/related" do Drive: os dados do arquivo (JSON) e o conteúdo,
 * numa requisição só.
 */
export function multipartBody(
  boundary: string,
  metadata: Record<string, unknown>,
  data: Buffer,
  mimeType: string,
): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

/**
 * Backups numa pasta do seu Google Drive ("Financeiro – backups"), criada pelo bot na
 * primeira vez. Com o acesso drive.file, o bot só enxerga essa pasta e o que ele criou.
 */
export class GoogleDriveStorage implements BackupStorage {
  private readonly fetch: Fetch;
  /** Pasta já conferida nesta execução do bot. */
  private folder: string | null = null;

  constructor(
    private readonly deps: {
      auth: Pick<GoogleDriveAuth, 'accessToken'>;
      credentials: CredentialRepository;
      fetch?: Fetch;
    },
  ) {
    this.fetch = deps.fetch ?? globalThis.fetch;
  }

  async upload(name: string, data: Buffer): Promise<DriveFile> {
    const folder = await this.folderId();
    const boundary = `financeiro-${randomBytes(12).toString('hex')}`;
    const mimeType = 'application/gzip';
    const file = await this.json(
      `${UPLOAD_API}/files?uploadType=multipart&fields=id,name,createdTime,size`,
      {
        method: 'POST',
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body: multipartBody(boundary, { name, parents: [folder], mimeType }, data, mimeType),
      },
    );
    return toDriveFile(file);
  }

  async list(): Promise<DriveFile[]> {
    const folder = await this.folderId();
    const params = new URLSearchParams({
      q: `'${folder}' in parents and trashed = false`,
      orderBy: 'createdTime desc',
      pageSize: '1000',
      fields: 'files(id,name,createdTime,size)',
    });
    const body = (await this.json(`${API}/files?${params.toString()}`)) as { files?: RawFile[] };
    return (body.files ?? []).map(toDriveFile);
  }

  async trash(id: string): Promise<void> {
    await this.json(`${API}/files/${encodeURIComponent(id)}?fields=id`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  }

  /** A pasta de backups: a guardada, se ainda existir (e não estiver na lixeira), ou uma nova. */
  private async folderId(): Promise<string> {
    if (this.folder) return this.folder;
    const saved = await this.deps.credentials.get(FOLDER_ID_KEY);
    if (saved) {
      try {
        const file = (await this.json(
          `${API}/files/${encodeURIComponent(saved)}?fields=id,trashed`,
        )) as RawFile;
        if (!file.trashed) return (this.folder = saved);
      } catch (error) {
        if (!(error instanceof DriveError && error.status === 404)) throw error;
      }
    }
    const created = (await this.json(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
    })) as RawFile;
    if (!created.id) throw new DriveError('Drive: a pasta de backups não foi criada', 500);
    await this.deps.credentials.set(FOLDER_ID_KEY, created.id);
    return (this.folder = created.id);
  }

  private async json(url: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.deps.auth.accessToken();
    let response: Response;
    try {
      response = await this.fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
      });
    } catch (error) {
      throw new DriveError(`sem conexão com o Google Drive (${String(error)})`, 0);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
      throw new DriveError(
        `Drive: HTTP ${String(response.status)}${typeof message === 'string' ? ` (${message})` : ''}`,
        response.status,
      );
    }
    return body;
  }
}

function toDriveFile(raw: unknown): DriveFile {
  const file = raw as RawFile;
  return {
    id: file.id ?? '',
    name: file.name ?? '',
    createdTime: file.createdTime ?? '',
    bytes: Number(file.size ?? 0),
  };
}
