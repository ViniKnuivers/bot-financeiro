import type { SheetSyncService } from '../modules/sheets/sheet-sync.service.js';
import type { Job } from './scheduler.js';

/**
 * A cada 10 minutos, sincroniza a planilha mesmo sem mudanças: vira o "mês atual" na
 * virada do mês e tenta de novo depois de uma falha (sem internet, Google fora do ar).
 */
export function sheetRefreshJob(sheets: Pick<SheetSyncService, 'syncNow'>): Job {
  return { name: 'planilha', intervalMs: 10 * 60 * 1000, run: () => sheets.syncNow() };
}
