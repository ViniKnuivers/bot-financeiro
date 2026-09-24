import { existsSync, readFileSync } from 'node:fs';
import type { Env } from '../../config/env.js';
import type { Logger } from '../../lib/logger.js';
import { SheetSyncService, type SheetSyncDeps } from './sheet-sync.service.js';
import { GoogleSheetsGateway } from './spreadsheet-gateway.js';

/**
 * Liga a planilha só se ela estiver configurada: GOOGLE_SHEETS_ID preenchido e o arquivo
 * da conta de serviço presente. Sem isso, o bot funciona normalmente, sem planilha.
 */
export function createSheetSync({
  env,
  logger,
  deps,
}: {
  env: Env;
  logger: Logger;
  deps: Omit<SheetSyncDeps, 'gateway' | 'serviceAccountEmail'>;
}): SheetSyncService | null {
  if (!env.GOOGLE_SHEETS_ID) return null;

  const keyFile = env.GOOGLE_SERVICE_ACCOUNT_FILE;
  if (!existsSync(keyFile)) {
    logger.error(
      { keyFile },
      'planilha: GOOGLE_SHEETS_ID preenchido, mas o arquivo da conta de serviço não existe; planilha desligada',
    );
    return null;
  }

  logger.info('planilha: sincronização ligada');
  return new SheetSyncService({
    ...deps,
    gateway: new GoogleSheetsGateway(env.GOOGLE_SHEETS_ID, keyFile),
    serviceAccountEmail: readServiceAccountEmail(keyFile),
  });
}

/** O e-mail com quem a planilha precisa ser compartilhada (campo client_email do JSON). */
function readServiceAccountEmail(keyFile: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(keyFile, 'utf8'));
    const email = (parsed as { client_email?: unknown }).client_email;
    return typeof email === 'string' ? email : null;
  } catch {
    return null;
  }
}
