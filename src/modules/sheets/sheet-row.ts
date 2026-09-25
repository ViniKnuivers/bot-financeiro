import type { Category, PaymentMethod, TransactionType } from '../../generated/prisma/enums.js';
import { parseBrlToCents } from '../../lib/money.js';
import { ACCOUNT_KIND_BY_METHOD, accountLabel, normalizeName } from '../accounts/account-kinds.js';
import type { Account } from '../accounts/account.repository.js';
import {
  CATEGORY_LABELS,
  PAYMENT_METHOD_LABELS,
  TYPE_LABELS,
} from '../transactions/transaction.labels.js';
import type { Transaction } from '../transactions/transaction.repository.js';
import { isCategoryAllowedForType } from '../transactions/transaction.schemas.js';

/** Os campos de um lançamento que podem ser editados pela planilha. */
export interface SheetRowFields {
  occurredAt: string;
  type: TransactionType;
  description: string;
  category: Category;
  amountCents: number;
  installments: number;
  paymentMethod: PaymentMethod | null;
  accountId: number | null;
}

/** Uma linha da aba Lançamentos, como veio da API (números e datas crus). */
export interface RawSheetRow {
  /** Número da linha na planilha (a 2 é a primeira depois do cabeçalho). */
  rowNumber: number;
  /** Coluna A; vazio numa linha nova digitada à mão. */
  id: string;
  cells: unknown[];
}

export type ParsedRow = { ok: true; fields: SheetRowFields } | { ok: false; error: string };

const MS_PER_DAY = 86_400_000;
const SHEET_EPOCH = Date.UTC(1899, 11, 30);
const MAX_INSTALLMENTS = 48;

/** Linhas da aba (a partir da 2), ignorando as totalmente vazias. */
export function readRows(values: readonly unknown[][]): RawSheetRow[] {
  return values.flatMap((cells, index) =>
    cells.some((cell) => cell !== '' && cell !== null && cell !== undefined)
      ? [{ rowNumber: index + 2, id: text(cells[0]), cells }]
      : [],
  );
}

/** A linha tem algum dado além das colunas preenchidas pelo bot (ID, Origem, Status)? */
export function hasUserContent(row: RawSheetRow): boolean {
  return row.cells.slice(1, 9).some((cell) => text(cell) !== '');
}

/** Os campos de um lançamento, no mesmo formato que `parseRow` produz. */
export function fieldsOf(transaction: Transaction): SheetRowFields {
  return {
    occurredAt: transaction.occurredAt.toISOString().slice(0, 10),
    type: transaction.type,
    description: transaction.description.trim(),
    category: transaction.category,
    amountCents: transaction.amountCents,
    installments: transaction.installments,
    paymentMethod: transaction.paymentMethod,
    accountId: transaction.accountId,
  };
}

/** Impressão digital dos campos: igual se e só se nada editável mudou. */
export function hashFields(fields: SheetRowFields): string {
  return JSON.stringify([
    fields.occurredAt,
    fields.type,
    fields.description,
    fields.category,
    fields.amountCents,
    fields.installments,
    fields.paymentMethod,
    fields.accountId,
  ]);
}

/**
 * Lê e valida uma linha (colunas B a I). Aceita os rótulos em português da planilha
 * ("Alimentação", "Crédito"), sem diferenciar maiúsculas e acentos.
 */
export function parseRow(cells: readonly unknown[], accounts: readonly Account[]): ParsedRow {
  const occurredAt = parseDate(cells[1]);
  if (!occurredAt) return fail('Data inválida (use dd/mm/aaaa).');

  const type = fromLabel(TYPE_LABELS, cells[2]);
  if (!type) return fail(`Tipo inválido. Use: ${Object.values(TYPE_LABELS).join(', ')}.`);

  const description = text(cells[3]);
  if (!description || description.length > 120) return fail('Descrição vazia ou longa demais.');

  const category = fromLabel(CATEGORY_LABELS, cells[4]);
  if (!category) return fail(`Categoria "${text(cells[4])}" não existe.`);
  if (!isCategoryAllowedForType(category, type)) {
    return fail(`A categoria ${CATEGORY_LABELS[category]} não combina com ${TYPE_LABELS[type]}.`);
  }

  const amountCents = parseAmount(cells[5]);
  if (amountCents === null) return fail('Valor inválido (use um número maior que zero).');

  const installments = cells[6] === '' || cells[6] == null ? 1 : Number(cells[6]);
  if (!Number.isInteger(installments) || installments < 1 || installments > MAX_INSTALLMENTS) {
    return fail(`Parcelas deve ser um número de 1 a ${MAX_INSTALLMENTS}.`);
  }

  const methodText = text(cells[7]);
  const paymentMethod = methodText ? fromLabel(PAYMENT_METHOD_LABELS, methodText) : null;
  if (methodText && !paymentMethod) return fail(`Forma de pagamento "${methodText}" não existe.`);

  const accountText = text(cells[8]);
  const account = accountText ? findAccount(accountText, accounts) : null;
  if (accountText && !account) return fail(`Cartão/Conta "${accountText}" não existe.`);
  if (account && paymentMethod && ACCOUNT_KIND_BY_METHOD[paymentMethod] !== account.kind) {
    return fail(
      `${accountLabel(account)} não combina com a forma ${PAYMENT_METHOD_LABELS[paymentMethod]}.`,
    );
  }

  return {
    ok: true,
    fields: {
      occurredAt,
      type,
      description,
      category,
      amountCents,
      installments,
      paymentMethod,
      accountId: account?.id ?? null,
    },
  };
}

function fail(error: string): ParsedRow {
  return { ok: false, error };
}

function text(cell: unknown): string {
  if (typeof cell === 'string') return cell.trim();
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
  return '';
}

/**
 * Rótulo em português ou o nome interno ("Alimentação" ou "ALIMENTACAO"), com ou sem o
 * emoji que a planilha mostra na frente ("🍔 Alimentação").
 */
function fromLabel<K extends string>(labels: Record<K, string>, cell: unknown): K | null {
  const wanted = normalizeName(text(cell).replace(/^[^\p{L}\p{N}]+/u, ''));
  if (!wanted) return null;
  const entries = Object.entries(labels) as [K, string][];
  return (
    entries.find(
      ([key, label]) => normalizeName(label) === wanted || normalizeName(key) === wanted,
    )?.[0] ?? null
  );
}

function findAccount(label: string, accounts: readonly Account[]): Account | null {
  const wanted = normalizeName(label);
  const byLabel = accounts.filter((a) => normalizeName(accountLabel(a)) === wanted);
  if (byLabel.length === 1) return byLabel[0] ?? null;
  // Aceita só o nome, se ele for único (ex.: "Santander").
  const active = accounts.filter((a) => a.archivedAt === null);
  const byName = active.filter((a) => normalizeName(a.name) === wanted);
  return byName.length === 1 ? (byName[0] ?? null) : null;
}

/** Número de série da planilha, "dd/mm/aaaa" ou "aaaa-mm-dd" → "aaaa-mm-dd". */
function parseDate(cell: unknown): string | null {
  if (typeof cell === 'number' && Number.isFinite(cell)) {
    return new Date(SHEET_EPOCH + Math.round(cell) * MS_PER_DAY).toISOString().slice(0, 10);
  }
  const value = text(cell);
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const [year, month, day] = br
    ? [Number(br[3]), Number(br[2]), Number(br[1])]
    : iso
      ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
      : [NaN, NaN, NaN];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime()) || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** Número em reais (como a planilha guarda) ou texto "32,50" → centavos. */
function parseAmount(cell: unknown): number | null {
  const cents =
    typeof cell === 'number' && Number.isFinite(cell)
      ? Math.round(cell * 100)
      : parseBrlToCents(text(cell));
  return cents !== null && cents > 0 ? cents : null;
}
