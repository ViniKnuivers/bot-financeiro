import { describe, expect, it, vi } from 'vitest';
import { inMemoryCredentials } from '../../test/in-memory-repositories.js';
import { FOLDER_ID_KEY, FOLDER_NAME, GoogleDriveStorage, multipartBody } from './google-drive.js';

interface Call {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Drive falso: responde pela ordem da fila e anota as chamadas. */
function setup(responses: Response[]) {
  const calls: Call[] = [];
  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: url as string,
      body: Buffer.isBuffer(init?.body)
        ? init.body.toString('latin1')
        : typeof init?.body === 'string'
          ? init.body
          : '',
      headers: init?.headers as Record<string, string>,
    });
    return Promise.resolve(responses.shift() ?? json(500, {}));
  });
  const credentials = inMemoryCredentials();
  const storage = new GoogleDriveStorage({
    auth: { accessToken: () => Promise.resolve('token') },
    credentials,
    fetch,
  });
  return { storage, credentials, calls };
}

describe('multipartBody', () => {
  it('monta o upload em duas partes: dados do arquivo (JSON) e conteúdo', () => {
    const body = multipartBody(
      'xyz',
      { name: 'a.sql.gz' },
      Buffer.from('DADOS'),
      'application/gzip',
    );

    expect(body.toString()).toBe(
      '--xyz\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.sql.gz"}\r\n' +
        '--xyz\r\nContent-Type: application/gzip\r\n\r\nDADOS\r\n--xyz--\r\n',
    );
  });
});

describe('GoogleDriveStorage', () => {
  it('cria a pasta na primeira vez, guarda o id e envia o arquivo dentro dela', async () => {
    const { storage, credentials, calls } = setup([
      json(200, { id: 'pasta1' }),
      json(200, { id: 'arq1', name: 'b.sql.gz', createdTime: '2026-09-30T06:00:00Z', size: '42' }),
      json(200, { files: [] }),
    ]);

    const file = await storage.upload('b.sql.gz', Buffer.from('conteudo'));
    await storage.list(); // mesma pasta, sem conferir de novo

    expect(file).toEqual({
      id: 'arq1',
      name: 'b.sql.gz',
      createdTime: '2026-09-30T06:00:00Z',
      bytes: 42,
    });
    expect(credentials.values.get(FOLDER_ID_KEY)).toBe('pasta1');
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    });
    expect(calls[1]?.url).toContain('/upload/drive/v3/files?uploadType=multipart');
    expect(calls[1]?.headers['content-type']).toMatch(/^multipart\/related; boundary=financeiro-/);
    expect(calls[1]?.headers.authorization).toBe('Bearer token');
    expect(calls[1]?.body).toContain('"parents":["pasta1"]');
    expect(calls[1]?.body).toContain('conteudo');
    expect(calls).toHaveLength(3);
  });

  it('pasta guardada que foi apagada (404) ou para a lixeira: cria outra', async () => {
    for (const check of [
      json(404, { error: { message: 'File not found' } }),
      json(200, { id: 'velha', trashed: true }),
    ]) {
      const { storage, credentials, calls } = setup([
        check,
        json(200, { id: 'nova' }),
        json(200, { files: [] }),
      ]);
      credentials.values.set(FOLDER_ID_KEY, 'velha');

      await storage.list();

      expect(credentials.values.get(FOLDER_ID_KEY)).toBe('nova');
      expect(new URL(calls[2]?.url ?? '').searchParams.get('q')).toMatch(/^'nova' in parents/);
    }
  });

  it('lista do mais novo para o mais velho e manda para a lixeira pelo id', async () => {
    const { storage, credentials, calls } = setup([
      json(200, { id: 'pasta1', trashed: false }),
      json(200, { files: [{ id: 'f1', name: 'x', createdTime: 't', size: '7' }] }),
      json(200, { id: 'f1' }),
    ]);
    credentials.values.set(FOLDER_ID_KEY, 'pasta1');

    expect(await storage.list()).toEqual([{ id: 'f1', name: 'x', createdTime: 't', bytes: 7 }]);
    await storage.trash('f1');

    const listUrl = new URL(calls[1]?.url ?? '');
    expect(listUrl.searchParams.get('q')).toBe("'pasta1' in parents and trashed = false");
    expect(listUrl.searchParams.get('orderBy')).toBe('createdTime desc');
    expect(calls[2]).toMatchObject({ method: 'PATCH', body: '{"trashed":true}' });
  });

  it('erro do Drive vira DriveError com o status e a mensagem', async () => {
    const { storage } = setup([json(403, { error: { message: 'Insufficient permissions' } })]);

    await expect(storage.list()).rejects.toMatchObject({
      name: 'DriveError',
      status: 403,
      message: 'Drive: HTTP 403 (Insufficient permissions)',
    });
  });
});
