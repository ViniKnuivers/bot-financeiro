import { describe, expect, it, vi } from 'vitest';
import type { OutgoingMessage } from '../channels/message-channel.js';
import type { BackupResult, BackupStatus } from '../modules/backup/backup.service.js';
import { inMemoryJobState } from '../test/in-memory-repositories.js';
import { BACKUP_NOTIFIED_KEY, backupJob } from './backup.job.js';

function setup(isoNow: string, options: { connected?: boolean } = {}) {
  let now = new Date(isoNow);
  const status: BackupStatus = {
    connected: options.connected ?? true,
    lastSuccess: null,
    lastFailure: null,
    keep: 30,
    hour: 3,
  };
  let next: BackupResult | null = null;
  const run = vi.fn(() => {
    const at = now.toISOString();
    const result: BackupResult = next ?? {
      ok: true,
      record: { at, name: 'b.sql.gz', bytes: 1 },
      pruned: 0,
    };
    if (result.ok) status.lastSuccess = result.record;
    return Promise.resolve(result);
  });
  const jobState = inMemoryJobState();
  const notify = vi.fn<(message: OutgoingMessage) => Promise<void>>(() => Promise.resolve());
  const job = backupJob({
    backup: { run, status: () => Promise.resolve({ ...status }) },
    jobState,
    notifier: { notify },
    now: () => now,
    timeZone: 'America/Sao_Paulo',
    hour: 3,
  });
  return {
    job,
    run,
    notify,
    jobState,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
    failNext: (reason: 'failed' | 'revoked') => {
      next = { ok: false, failure: { at: now.toISOString(), reason, message: 'Drive: HTTP 503' } };
    },
    succeedNext: () => {
      next = null;
    },
  };
}

describe('backupJob', () => {
  it('nada antes das 3h; depois, um backup por dia', async () => {
    const { job, run, setNow } = setup('2026-09-30T05:50:00Z'); // 02:50

    await job.run();
    expect(run).not.toHaveBeenCalled();

    setNow('2026-09-30T06:10:00Z'); // 03:10
    await job.run();
    setNow('2026-09-30T20:00:00Z'); // 17:00, mesmo dia
    await job.run();
    expect(run).toHaveBeenCalledOnce();

    setNow('2026-10-01T06:00:00Z'); // dia seguinte, 03:00
    await job.run();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('bot desligado às 3h: faz quando ligar, no mesmo dia', async () => {
    const { job, run } = setup('2026-09-30T14:00:00Z'); // 11:00

    await job.run();

    expect(run).toHaveBeenCalledOnce();
  });

  it('sem Google Drive conectado, não tenta', async () => {
    const { job, run } = setup('2026-09-30T14:00:00Z', { connected: false });

    await job.run();

    expect(run).not.toHaveBeenCalled();
  });

  it('falhou: avisa uma vez, tenta de novo a cada hora e volta a avisar só depois de dar certo', async () => {
    const { job, run, notify, jobState, setNow, failNext, succeedNext } =
      setup('2026-09-30T06:00:00Z');
    failNext('failed');

    await job.run();
    setNow('2026-09-30T06:30:00Z'); // meia hora depois: ainda espera
    await job.run();
    setNow('2026-09-30T07:01:00Z'); // 1 hora depois: tenta de novo, sem avisar outra vez
    await job.run();

    expect(run).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0].text).toMatch(
      /^⚠️ O backup no Google Drive falhou: Drive: HTTP 503/,
    );

    succeedNext();
    setNow('2026-09-30T08:02:00Z');
    await job.run();
    expect(jobState.values.get(BACKUP_NOTIFIED_KEY)).toBe('');

    failNext('revoked');
    setNow('2026-10-01T06:00:00Z');
    await job.run();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]?.[0].text).toContain('Reconecte com /backup');
  });
});
