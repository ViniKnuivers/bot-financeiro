import type { BackupConfig } from '../../config/env.js';
import type { JobStateRepository } from '../../jobs/job-state.repository.js';
import type { Logger } from '../../lib/logger.js';
import { BackupService } from './backup.service.js';
import type { CredentialRepository } from './credential.repository.js';
import { dumpDatabase } from './database-dump.js';
import { GoogleDriveStorage } from './google-drive.js';
import { GoogleDriveAuth } from './google-oauth.js';

/** Liga o backup no Google Drive só quando o cliente OAuth está no .env. */
export function createBackup(deps: {
  config: BackupConfig | null;
  databaseUrl: string;
  credentials: CredentialRepository;
  jobState: JobStateRepository;
  timeZone: string;
  logger: Logger;
}): BackupService | null {
  const { config } = deps;
  if (!config) return null;
  const auth = new GoogleDriveAuth({ config, credentials: deps.credentials });
  deps.logger.info('backup: Google Drive configurado');
  return new BackupService({
    dump: () => dumpDatabase(deps.databaseUrl),
    storage: new GoogleDriveStorage({ auth, credentials: deps.credentials }),
    auth,
    jobState: deps.jobState,
    keep: config.keep,
    hour: config.hour,
    now: () => new Date(),
    timeZone: deps.timeZone,
    logger: deps.logger,
  });
}
