import type { Category } from '../../generated/prisma/enums.js';
import { normalizeName } from '../accounts/account-kinds.js';
import {
  investmentsByDestination,
  summarizeMonths,
  type InvestmentPosition,
  type MonthSummary,
  type ReportContext,
  type ReportTransaction,
} from '../reports/monthly-report.js';

/** Quantas vezes um mesmo lugar precisa aparecer para ser o "mais frequente". */
const FREQUENT_MIN_COUNT = 3;

export interface YearSummary {
  year: string;
  /** Meses do ano considerados (até o atual, se o ano ainda não acabou). */
  months: MonthSummary[];
  /** Primeiro mês com algum lançamento; null se o ano está vazio. */
  firstActiveMonth: string | null;
  entries: number;
  incomeCents: number;
  /** Sem VR/VA (como no /resumo). */
  expenseCents: number;
  voucherExpenseCents: number;
  surplusCents: number;
  netInvestedCents: number;
  /** Maior e menor sobra entre os meses com movimento (só com 2 meses ou mais). */
  best: MonthSummary | null;
  worst: MonthSummary | null;
  /** Gasto médio por mês com movimento (sem VR/VA). */
  averageExpenseCents: number;
  /** Todas as despesas por categoria (com VR/VA), da maior para a menor. */
  byCategory: { category: Category; cents: number; percent: number }[];
  biggest: { description: string; cents: number; date: string } | null;
  mostFrequent: { description: string; count: number; cents: number } | null;
  /** Saldo de cada destino de aporte no fim do ano (ou hoje). */
  investments: InvestmentPosition[];
  /** Mesmo cálculo do ano anterior, se ele teve movimento. */
  previous: { expenseCents: number; netInvestedCents: number } | null;
}

function yearMonths(year: string, lastMonth: string): string[] {
  const end = lastMonth.startsWith(year) ? Number(lastMonth.slice(5, 7)) : 12;
  return Array.from({ length: end }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

/**
 * O ano em números: totais, melhor e pior mês, categorias, maior gasto, lugar mais
 * frequente e investimentos. `today` limita o ano corrente aos meses que já começaram.
 */
export function summarizeYear(
  transactions: readonly ReportTransaction[],
  context: ReportContext,
  year: string,
  today: string,
): YearSummary {
  const months = summarizeMonths(transactions, context, yearMonths(year, today.slice(0, 7)));
  const inYear = transactions.filter((tx) => tx.occurredAt.toISOString().startsWith(year));
  const activeMonths = new Set(inYear.map((tx) => tx.occurredAt.toISOString().slice(0, 7)));
  const active = months.filter((m) => activeMonths.has(m.month));

  const sum = (pick: (m: MonthSummary) => number) => months.reduce((t, m) => t + pick(m), 0);
  const expenseCents = sum((m) => m.expenseCents);

  const categories = new Map<Category, number>();
  for (const m of months) {
    for (const c of m.byCategory)
      categories.set(c.category, (categories.get(c.category) ?? 0) + c.cents);
  }
  const allExpenses = [...categories.values()].reduce((t, c) => t + c, 0);

  let biggest: YearSummary['biggest'] = null;
  const places = new Map<string, { description: string; count: number; cents: number }>();
  for (const tx of inYear) {
    if (tx.type !== 'EXPENSE') continue;
    if (!biggest || tx.amountCents > biggest.cents) {
      biggest = {
        description: tx.description,
        cents: tx.amountCents,
        date: tx.occurredAt.toISOString().slice(0, 10),
      };
    }
    const key = normalizeName(tx.description);
    const place = places.get(key) ?? { description: tx.description.trim(), count: 0, cents: 0 };
    place.count += 1;
    place.cents += tx.amountCents;
    places.set(key, place);
  }
  const frequent = [...places.values()]
    .filter((p) => p.count >= FREQUENT_MIN_COUNT)
    .sort((a, b) => b.count - a.count || b.cents - a.cents)[0];

  const bySurplus = [...active].sort((a, b) => b.surplusCents - a.surplusCents);
  const endOfYear = `${year}-12-31`;
  const previousYear = String(Number(year) - 1);
  const hadPrevious = transactions.some((tx) =>
    tx.occurredAt.toISOString().startsWith(previousYear),
  );
  const previousMonths = hadPrevious
    ? summarizeMonths(transactions, context, yearMonths(previousYear, `${previousYear}-12`))
    : [];

  return {
    year,
    months,
    firstActiveMonth: active[0]?.month ?? null,
    entries: inYear.length,
    incomeCents: sum((m) => m.incomeCents),
    expenseCents,
    voucherExpenseCents: sum((m) => m.voucherExpenseCents),
    surplusCents: sum((m) => m.surplusCents),
    netInvestedCents: sum((m) => m.netInvestedCents),
    best: bySurplus.length >= 2 ? (bySurplus[0] ?? null) : null,
    worst: bySurplus.length >= 2 ? (bySurplus.at(-1) ?? null) : null,
    averageExpenseCents: active.length > 0 ? Math.round(expenseCents / active.length) : 0,
    byCategory: [...categories]
      .map(([category, cents]) => ({
        category,
        cents,
        percent: allExpenses > 0 ? Math.round((cents / allExpenses) * 100) : 0,
      }))
      .sort((a, b) => b.cents - a.cents),
    biggest,
    mostFrequent: frequent ?? null,
    investments: investmentsByDestination(
      transactions.filter((tx) => tx.occurredAt.toISOString().slice(0, 10) <= endOfYear),
    ).filter((p) => p.balanceCents > 0),
    previous: hadPrevious
      ? {
          expenseCents: previousMonths.reduce((t, m) => t + m.expenseCents, 0),
          netInvestedCents: previousMonths.reduce((t, m) => t + m.netInvestedCents, 0),
        }
      : null,
  };
}
