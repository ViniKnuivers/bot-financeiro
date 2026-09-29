import type { Query } from '../../ai/parse-result.schema.js';
import type { AccountKind, Category, TransactionType } from '../../generated/prisma/enums.js';
import { ACCOUNT_KIND_BY_METHOD, normalizeName } from '../accounts/account-kinds.js';
import { addMonths, daysInMonth, splitInstallments } from '../accounts/credit-invoice.js';
import type { ReportTransaction } from '../reports/monthly-report.js';

/**
 * Responde perguntas sobre os lançamentos ("quanto gastei com uber em setembro?").
 * A IA só traduz a pergunta em filtros (Query); a conta é sempre feita aqui, com os mesmos
 * critérios do /resumo: parcelas distribuídas pelos meses e VR/VA contando como gasto.
 */

export interface QueryAccount {
  id: number;
  name: string;
  kind: AccountKind;
}

export interface Period {
  start: string;
  end: string;
}

/** O que foi perguntado, para montar o título da resposta. */
export interface QuerySubject {
  type: TransactionType;
  categories: Category[];
  text: string | null;
  /** Nome do cartão/conta citado na pergunta (null se nenhum). */
  accountName: string | null;
  /** Contas com esse nome (pode ser mais de uma, ex.: Itaú conta e crédito; vazio se não existe). */
  accounts: QueryAccount[];
  paymentMethod: Query['paymentMethod'];
}

export interface PeriodTotal {
  period: Period;
  totalCents: number;
  count: number;
}

export interface ListedTransaction {
  date: string;
  description: string;
  category: Category;
  amountCents: number;
  installments: number;
  accountId: number | null;
}

export type QueryAnswer =
  | ({ kind: 'total'; subject: QuerySubject } & PeriodTotal)
  | { kind: 'compare'; subject: QuerySubject; current: PeriodTotal; other: PeriodTotal }
  | {
      kind: 'ranking';
      subject: QuerySubject;
      period: Period;
      rankBy: 'month' | 'category';
      /** Do maior para o menor; `key` é "YYYY-MM" ou a categoria. */
      rows: { key: string; cents: number }[];
    }
  | {
      kind: 'list';
      subject: QuerySubject;
      period: Period;
      sort: 'recent' | 'largest';
      items: ListedTransaction[];
      /** Quantos lançamentos combinam no total (a lista mostra só os primeiros). */
      matches: number;
    };

/** "Posso gastar?" é respondido à parte (junta previsão, orçamento e cartão). */
export type ComputableQuery = Query & { kind: Exclude<Query['kind'], 'can_afford'> };

const DEFAULT_LIST_LIMIT = 5;

export function answerQuery(
  query: ComputableQuery,
  transactions: readonly ReportTransaction[],
  accounts: readonly QueryAccount[],
): QueryAnswer {
  const subject = subjectOf(query, accounts);
  const matching = transactions.filter((tx) => matches(tx, subject));
  const period = { start: query.periodStart, end: query.periodEnd };

  switch (query.kind) {
    case 'total':
      return { kind: 'total', subject, ...totalIn(matching, period) };
    case 'compare':
      return {
        kind: 'compare',
        subject,
        current: totalIn(matching, period),
        other: totalIn(matching, {
          start: query.compareStart ?? query.periodStart,
          end: query.compareEnd ?? query.periodEnd,
        }),
      };
    case 'ranking': {
      const rankBy = query.rankBy ?? 'month';
      const totals = new Map<string, number>();
      for (const tx of matching) {
        for (const share of datedShares(tx)) {
          if (!inPeriod(share.date, period)) continue;
          const key = rankBy === 'month' ? share.date.slice(0, 7) : tx.category;
          totals.set(key, (totals.get(key) ?? 0) + share.cents);
        }
      }
      const rows = [...totals]
        .map(([key, cents]) => ({ key, cents }))
        .filter((row) => row.cents > 0)
        .sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key));
      return { kind: 'ranking', subject, period, rankBy, rows };
    }
    case 'list': {
      const sort = query.sort ?? 'recent';
      // Lista a compra como foi feita (data e valor total), não as parcelas.
      const inRange = matching.filter((tx) => inPeriod(isoDate(tx.occurredAt), period));
      const sorted = [...inRange].sort((a, b) =>
        sort === 'largest'
          ? b.amountCents - a.amountCents || b.occurredAt.getTime() - a.occurredAt.getTime()
          : b.occurredAt.getTime() - a.occurredAt.getTime() || b.amountCents - a.amountCents,
      );
      return {
        kind: 'list',
        subject,
        period,
        sort,
        matches: inRange.length,
        items: sorted.slice(0, query.limit ?? DEFAULT_LIST_LIMIT).map((tx) => ({
          date: isoDate(tx.occurredAt),
          description: tx.description,
          category: tx.category,
          amountCents: tx.amountCents,
          installments: tx.installments,
          accountId: tx.accountId,
        })),
      };
    }
  }
}

/** Total no período (parcelas contam no mês de cada uma) e quantos lançamentos entraram. */
export function totalIn(transactions: readonly ReportTransaction[], period: Period): PeriodTotal {
  let totalCents = 0;
  let count = 0;
  for (const tx of transactions) {
    const cents = datedShares(tx)
      .filter((share) => inPeriod(share.date, period))
      .reduce((sum, share) => sum + share.cents, 0);
    if (cents > 0) {
      totalCents += cents;
      count += 1;
    }
  }
  return { period, totalCents, count };
}

function subjectOf(query: Query, accounts: readonly QueryAccount[]): QuerySubject {
  const methodKind = query.paymentMethod ? ACCOUNT_KIND_BY_METHOD[query.paymentMethod] : undefined;
  const named = query.account ? normalizeName(query.account) : null;
  const text = query.text?.trim() ? query.text.trim() : null;
  return {
    type: query.type ?? 'EXPENSE',
    // Nome específico ("uber") vale mais que a categoria que a IA às vezes junta
    // (Transporte): somar as duas deixaria de fora um "Uber Eats" em Alimentação.
    categories: text ? [] : [...query.categories],
    text,
    accountName: query.account,
    accounts:
      named === null
        ? []
        : accounts.filter(
            (a) => normalizeName(a.name) === named && (!methodKind || a.kind === methodKind),
          ),
    paymentMethod: query.paymentMethod,
  };
}

function matches(tx: ReportTransaction, subject: QuerySubject): boolean {
  if (tx.type !== subject.type) return false;
  if (subject.categories.length > 0 && !subject.categories.includes(tx.category)) return false;
  if (subject.text && !normalizeName(tx.description).includes(normalizeName(subject.text))) {
    return false;
  }
  if (subject.paymentMethod && tx.paymentMethod !== subject.paymentMethod) return false;
  // Conta citada que não existe: nada combina (melhor "nenhum" do que somar tudo).
  if (subject.accountName !== null) {
    if (tx.accountId === null || !subject.accounts.some((a) => a.id === tx.accountId)) {
      return false;
    }
  }
  return true;
}

/**
 * Cada parcela com a sua data: a 1ª na data da compra e as seguintes no mesmo dia dos
 * meses seguintes (dia 31 vira o último dia do mês).
 */
export function datedShares(tx: ReportTransaction): { date: string; cents: number }[] {
  const date = isoDate(tx.occurredAt);
  if (tx.type !== 'EXPENSE' || tx.installments <= 1) return [{ date, cents: tx.amountCents }];
  return splitInstallments(tx.amountCents, tx.installments).map((cents, index) => ({
    date: addMonthsToDate(date, index),
    cents,
  }));
}

function addMonthsToDate(date: string, count: number): string {
  const month = addMonths(date.slice(0, 7), count);
  const day = Math.min(Number(date.slice(8, 10)), daysInMonth(month));
  return `${month}-${String(day).padStart(2, '0')}`;
}

function inPeriod(date: string, period: Period): boolean {
  return date >= period.start && date <= period.end;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
