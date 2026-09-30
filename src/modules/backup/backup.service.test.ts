import { describe, expect, it, vi } from 'vitest';
import { inMemoryJobState } from '../../test/in-memory-repositories.js';
import { BACKUP_KEYS, backupFileName, BackupService } from './backup.service.js';
import type { BackupStorage, DriveFile } from './google-drive.js';
import { DriveAuthError } from './google-oauth.js';

/** Pasta do Drive em memória. */
function memoryStorage(initial: string[] = []): BackupStorage & { files: DriveFile[] } {
  const files: DriveFile[] = initial.map((name, i) => ({
    id: `id${String(i)}`,
    name,
    createdTime: '',
    bytes: 1,
  }));
  return {
    files,
    upload: (name, data) => {
      const file = { id: `id-${name}`, name, createdTime: '', bytes: data.length };
      files.push(file);
      return Promise.resolve(file);
    },
    list: () => Promise.resolve([...files].reverse()),
    trash: (id) => {
      files.splice(
        files.findIndex((f) => f.id === id),
        1,
      );
      return Promise.resolve();
    },
  };
}

function setup(
  options: { storage?: ReturnType<typeof memoryStorage>; connected?: boolean; keep?: number } = {},
) {
  const storage = options.storage ?? memoryStorage();
  const jobState = inMemoryJobState();
  const dump = vi.fn(() => Promise.resolve(Buffer.from('dump compactado')));
  let now = new Date('2026-09-30T06:00:00Z'); // 03:00 em São Paulo
  const service = new BackupService({
    dump,
    storage,
    auth: {
      isConnected: () => Promise.resolve(options.connected ?? true),
      authorizationUrl: () => 'https://link',
      finishAuthorization: () => Promise.resolve(),
    },
    jobState,
    keep: options.keep ?? 3,
    hour: 3,
    now: () => now,
    timeZone: 'America/Sao_Paulo',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return {
    service,
    storage,
    jobState,
    dump,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
  };
}

describe('backupFileName', () => {
  it('data e hora locais, que em ordem alfabética ficam em ordem de data', () => {
    expect(backupFileName(new Date('2026-09-30T06:05:00Z'), 'America/Sao_Paulo')).toBe(
      'financeiro-2026-09-30-0305.sql.gz',
    );
  });
});

describe('BackupService', () => {
  it('envia a cópia e guarda o resultado para o /backup', async () => {
    const { service, storage } = setup();

    const result = await service.run();

    expect(result).toEqual({
      ok: true,
      record: {
        at: '2026-09-30T06:00:00.000Z',
        name: 'financeiro-2026-09-30-0300.sql.gz',
        bytes: 15,
      },
      pruned: 0,
    });
    expect(storage.files.map((f) => f.name)).toEqual(['financeiro-2026-09-30-0300.sql.gz']);
    expect((await service.status()).lastSuccess?.name).toBe('financeiro-2026-09-30-0300.sql.gz');
  });

  it('guarda só as N mais recentes e não mexe em arquivos que não são backups', async () => {
    const storage = memoryStorage([
      'financeiro-2026-09-26-0300.sql.gz',
      'financeiro-2026-09-27-0300.sql.gz',
      'anotacoes.txt',
      'financeiro-2026-09-28-0300.sql.gz',
      'financeiro-2026-09-29-0300.sql.gz',
    ]);
    const { service } = setup({ storage, keep: 3 });

    const result = await service.run();

    expect(result.ok && result.pruned).toBe(2);
    expect(storage.files.map((f) => f.name).sort()).toEqual([
      'anotacoes.txt',
      'financeiro-2026-09-28-0300.sql.gz',
      'financeiro-2026-09-29-0300.sql.gz',
      'financeiro-2026-09-30-0300.sql.gz',
    ]);
  });

  it('sem conexão: falha not_connected, sem gerar a cópia', async () => {
    const { service, dump } = setup({ connected: false });

    const result = await service.run();

    expect(result).toMatchObject({ ok: false, failure: { reason: 'not_connected' } });
    expect(dump).not.toHaveBeenCalled();
  });

  it('autorização revogada vira revoked; a falha aparece no status até o próximo sucesso', async () => {
    const storage = memoryStorage();
    storage.upload = () => Promise.reject(new DriveAuthError('revoked', 'removida'));
    const { service, jobState, setNow } = setup({ storage });

    const failed = await service.run();
    expect(failed).toMatchObject({
      ok: false,
      failure: { reason: 'revoked', message: 'removida' },
    });
    expect((await service.status()).lastFailure?.reason).toBe('revoked');

    // Um sucesso depois apaga a falha do status (fica só no histórico).
    const working = memoryStorage();
    storage.upload = (name, data) => working.upload(name, data);
    setNow('2026-09-30T07:00:00Z');
    await service.run();
    expect((await service.status()).lastFailure).toBeNull();
    expect(jobState.values.get(BACKUP_KEYS.lastFailure)).toContain('revoked');
  });

  it('falha ao apagar as antigas não desfaz o backup', async () => {
    const storage = memoryStorage();
    storage.list = () => Promise.reject(new Error('Drive fora do ar'));
    const { service } = setup({ storage });

    expect(await service.run()).toMatchObject({ ok: true, pruned: 0 });
  });

  it('dois pedidos ao mesmo tempo fazem um backup só', async () => {
    const { service, dump } = setup();

    const [a, b] = await Promise.all([service.run(), service.run()]);

    expect(a).toBe(b);
    expect(dump).toHaveBeenCalledOnce();
  });
});
