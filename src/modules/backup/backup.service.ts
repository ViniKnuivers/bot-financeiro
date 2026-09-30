import type { JobStateRepository } from '../../jobs/job-state.repository.js';
import { localTime, toDateOnlyString } from '../../lib/dates.js';
import type { Logger } from '../../lib/logger.js';
import type { BackupStorage } from './google-drive.js';
import { DriveAuthError, type GoogleDriveAuth } from './google-oauth.js';

export const BACKUP_KEYS = {
  lastSuccess: 'backup.lastSuccess',
  lastFailure: 'backup.lastFailure',
} as const;

/** "financeiro-2026-09-30-0300.sql.gz": em ordem alfabética = em ordem de data. */
export const BACKUP_FILE_PATTERN = /^financeiro-\d{4}-\d{2}-\d{2}-\d{4}\.sql\.gz$/;

export interface BackupRecord {
  /** ISO 8601. */
  at: string;
  name: string;
  bytes: number;
}

export interface BackupFailure {
  at: string;
  /** revoked: reconectar com /backup; not_connected: nunca conectou; failed: o resto. */
  reason: 'not_connected' | 'revoked' | 'failed';
  message: string;
}

export type BackupResult =
  { ok: true; record: BackupRecord; pruned: number } | { ok: false; failure: BackupFailure };

export interface BackupStatus {
  connected: boolean;
  lastSuccess: BackupRecord | null;
  /** Só quando é mais recente que o último backup que deu certo. */
  lastFailure: BackupFailure | null;
  keep: number;
  hour: number;
}

export function backupFileName(instant: Date, timeZone: string): string {
  const time = localTime(instant, timeZone).replace(':', '');
  return `financeiro-${toDateOnlyString(instant, timeZone)}-${time}.sql.gz`;
}

/**
 * Backup do banco no Google Drive: cópia completa → upload → apaga (lixeira) as mais
 * velhas, guardando as `keep` mais recentes. O resultado fica no JobState, para o
 * /backup mostrar e a tarefa diária saber se já rodou hoje.
 */
export class BackupService {
  private running: Promise<BackupResult> | null = null;

  constructor(
    private readonly deps: {
      dump: () => Promise<Buffer>;
      storage: BackupStorage;
      auth: Pick<GoogleDriveAuth, 'isConnected' | 'authorizationUrl' | 'finishAuthorization'>;
      jobState: JobStateRepository;
      /** Quantas cópias guardar. */
      keep: number;
      /** A partir de que hora sai o backup do dia (só para mostrar no /backup). */
      hour: number;
      now: () => Date;
      timeZone: string;
      logger: Logger;
    },
  ) {}

  isConnected(): Promise<boolean> {
    return this.deps.auth.isConnected();
  }

  authorizationUrl(): string {
    return this.deps.auth.authorizationUrl();
  }

  connect(params: Parameters<GoogleDriveAuth['finishAuthorization']>[0]): Promise<void> {
    return this.deps.auth.finishAuthorization(params);
  }

  /** Faz o backup agora. Se já houver um em andamento, devolve o resultado dele. */
  run(): Promise<BackupResult> {
    this.running ??= this.execute().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async status(): Promise<BackupStatus> {
    const [connected, lastSuccess, lastFailure] = await Promise.all([
      this.deps.auth.isConnected(),
      this.read<BackupRecord>(BACKUP_KEYS.lastSuccess),
      this.read<BackupFailure>(BACKUP_KEYS.lastFailure),
    ]);
    const failureIsNewer =
      lastFailure !== null && (lastSuccess === null || lastFailure.at > lastSuccess.at);
    return {
      connected,
      lastSuccess,
      lastFailure: failureIsNewer ? lastFailure : null,
      keep: this.deps.keep,
      hour: this.deps.hour,
    };
  }

  private async execute(): Promise<BackupResult> {
    const { storage, jobState, logger } = this.deps;
    const now = this.deps.now();
    try {
      if (!(await this.deps.auth.isConnected())) {
        throw new DriveAuthError('not_connected', 'Google Drive ainda não conectado');
      }
      const data = await this.deps.dump();
      const name = backupFileName(now, this.deps.timeZone);
      await storage.upload(name, data);
      const record: BackupRecord = { at: now.toISOString(), name, bytes: data.length };
      await jobState.set(BACKUP_KEYS.lastSuccess, JSON.stringify(record));
      logger.info({ name, bytes: data.length }, 'backup: enviado ao Google Drive');
      return { ok: true, record, pruned: await this.prune() };
    } catch (error) {
      const failure: BackupFailure = {
        at: now.toISOString(),
        reason:
          error instanceof DriveAuthError && error.reason === 'revoked'
            ? 'revoked'
            : error instanceof DriveAuthError && error.reason === 'not_connected'
              ? 'not_connected'
              : 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
      await jobState.set(BACKUP_KEYS.lastFailure, JSON.stringify(failure));
      logger.error({ err: error }, 'backup: falhou');
      return { ok: false, failure };
    }
  }

  /** Guarda as `keep` cópias mais novas. Falhar aqui não desfaz o backup: tenta na próxima. */
  private async prune(): Promise<number> {
    try {
      const backups = (await this.deps.storage.list())
        .filter((file) => BACKUP_FILE_PATTERN.test(file.name))
        .sort((a, b) => b.name.localeCompare(a.name));
      const old = backups.slice(this.deps.keep);
      for (const file of old) await this.deps.storage.trash(file.id);
      if (old.length > 0) this.deps.logger.info({ count: old.length }, 'backup: cópias antigas');
      return old.length;
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'backup: não consegui apagar as cópias antigas');
      return 0;
    }
  }

  private async read<T>(key: string): Promise<T | null> {
    const raw = await this.deps.jobState.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}
