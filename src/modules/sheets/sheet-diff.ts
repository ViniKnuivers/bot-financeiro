import type { Account } from '../accounts/account.repository.js';
import type { Transaction } from '../transactions/transaction.repository.js';
import {
  fieldsOf,
  hashFields,
  hasUserContent,
  parseRow,
  type RawSheetRow,
  type SheetRowFields,
} from './sheet-row.js';

/** Acima disto, linhas sumidas não são apagadas sem confirmar (aba limpa por engano etc.). */
export const MASS_DELETE_THRESHOLD = 5;

export type SheetChange =
  /** Linha editada na planilha (e não no bot): aplicar no banco. */
  | { kind: 'update'; transaction: Transaction; fields: SheetRowFields }
  /** Linha nova, sem ID, válida: criar o lançamento. */
  | { kind: 'create'; row: RawSheetRow; fields: SheetRowFields }
  /** Linha apagada da planilha. */
  | { kind: 'delete'; transaction: Transaction }
  /** Muitas linhas sumiram de uma vez: não apagar sem perguntar. */
  | { kind: 'mass_delete'; transactions: Transaction[] }
  /** Mudou nos dois lados desde a última sincronização: o bot vence. */
  | { kind: 'conflict'; transaction: Transaction }
  /** Linha nova ou editada com algum valor inválido. */
  | { kind: 'invalid'; row: RawSheetRow; transaction: Transaction | null; error: string };

export interface DiffInput {
  rows: readonly RawSheetRow[];
  transactions: readonly Transaction[];
  /** Hash de cada lançamento na última sincronização. */
  snapshots: ReadonlyMap<string, string>;
  /** Todas as contas, inclusive arquivadas. */
  accounts: readonly Account[];
}

/**
 * Compara três versões de cada linha: a da planilha, a do banco e a da última
 * sincronização. Quem difere da última sincronização é quem mudou.
 */
export function diffSheet({ rows, transactions, snapshots, accounts }: DiffInput): SheetChange[] {
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const changes: SheetChange[] = [];

  for (const row of rows) {
    if (!row.id) {
      if (!hasUserContent(row)) continue;
      const parsed = parseRow(row.cells, accounts);
      changes.push(
        parsed.ok
          ? { kind: 'create', row, fields: parsed.fields }
          : { kind: 'invalid', row, transaction: null, error: parsed.error },
      );
      continue;
    }

    seen.add(row.id);
    const transaction = byId.get(row.id);
    const snapshot = snapshots.get(row.id);
    // Sem lançamento no banco (desfeito pelo bot) ou nunca sincronizado: a próxima escrita
    // do bot acerta a linha; não há edição do usuário para aplicar.
    if (!transaction || snapshot === undefined) continue;

    const parsed = parseRow(row.cells, accounts);
    if (!parsed.ok) {
      changes.push({ kind: 'invalid', row, transaction, error: parsed.error });
      continue;
    }
    const sheetHash = hashFields(parsed.fields);
    if (sheetHash === snapshot) continue;
    const dbHash = hashFields(fieldsOf(transaction));
    changes.push(
      dbHash === snapshot
        ? { kind: 'update', transaction, fields: parsed.fields }
        : { kind: 'conflict', transaction },
    );
  }

  const deleted = transactions.filter((t) => snapshots.has(t.id) && !seen.has(t.id));
  if (deleted.length > MASS_DELETE_THRESHOLD) {
    changes.push({ kind: 'mass_delete', transactions: deleted });
  } else {
    changes.push(...deleted.map((transaction) => ({ kind: 'delete' as const, transaction })));
  }
  return changes;
}
