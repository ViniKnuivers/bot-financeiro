import type { SheetSyncService } from '../modules/sheets/sheet-sync.service.js';
import type { Job } from './scheduler.js';

/**
 * A cada minuto, lê a planilha para aplicar o que você editou lá. Só reescreve se algo
 * mudou (ou a cada 10 minutos, para virar o "mês atual" e tentar de novo depois de falhas).
 */
export function sheetRefreshJob(sheets: Pick<SheetSyncService, 'syncNow'>): Job {
  return { name: 'planilha', intervalMs: 60 * 1000, run: () => sheets.syncNow() };
}
