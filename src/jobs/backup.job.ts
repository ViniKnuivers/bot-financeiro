import type { Notifier } from '../channels/message-channel.js';
import { localHour, toDateOnlyString } from '../lib/dates.js';
import { backupFailureNotice } from '../modules/backup/backup-messages.js';
import type { BackupService } from '../modules/backup/backup.service.js';
import type { JobStateRepository } from './job-state.repository.js';
import type { Job } from './scheduler.js';

/** Motivo da falha já avisada no chat (vazio depois de um backup que deu certo). */
export const BACKUP_NOTIFIED_KEY = 'backup.failureNotified';
export const BACKUP_RETRY_MS = 60 * 60 * 1000;

/**
 * Backup diário: a partir de `hour` (fuso do usuário), se o Drive está conectado e ainda
 * não houve backup hoje, faz. Com o bot desligado nesse horário, faz quando ligar. Se
 * falhar, tenta de novo a cada hora e avisa no chat uma vez só (até dar certo de novo).
 */
export function backupJob(deps: {
  backup: Pick<BackupService, 'run' | 'status'>;
  jobState: JobStateRepository;
  notifier: Notifier;
  now: () => Date;
  timeZone: string;
  hour: number;
}): Job {
  let lastAttempt = Number.NEGATIVE_INFINITY;
  return {
    name: 'backup',
    intervalMs: 10 * 60 * 1000,
    async run() {
      const now = deps.now();
      if (localHour(now, deps.timeZone) < deps.hour) return;
      const status = await deps.backup.status();
      if (!status.connected) return;
      const today = toDateOnlyString(now, deps.timeZone);
      const last = status.lastSuccess;
      if (last && toDateOnlyString(new Date(last.at), deps.timeZone) === today) return;
      if (now.getTime() - lastAttempt < BACKUP_RETRY_MS) return;
      lastAttempt = now.getTime();

      const result = await deps.backup.run();
      if (result.ok) {
        await deps.jobState.set(BACKUP_NOTIFIED_KEY, '');
        return;
      }
      if ((await deps.jobState.get(BACKUP_NOTIFIED_KEY)) === result.failure.reason) return;
      await deps.jobState.set(BACKUP_NOTIFIED_KEY, result.failure.reason);
      await deps.notifier.notify({ text: backupFailureNotice(result.failure) });
    },
  };
}
