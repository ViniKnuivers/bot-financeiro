import type { Category } from '../../generated/prisma/enums.js';
import { addDays } from '../../lib/dates.js';
import { splitInstallments } from '../accounts/credit-invoice.js';
import type { ReportContext, ReportTransaction } from '../reports/monthly-report.js';

/** Quantas semanas anteriores formam a média de comparação. */
export const WEEKS_OF_HISTORY = 4;
/** Categoria "subiu" quando passa da média em 30% e em pelo menos R$ 50. */
const RISE_RATIO = 1.3;
const RISE_MIN_CENTS = 5_000;
/** Categoria "caiu" quando fica na metade da média (com média de pelo menos R$ 50). */
const DROP_RATIO = 0.5;
/** Total da semana diferente da média em 20% ou mais merece comentário. */
const TOTAL_CHANGE_RATIO = 0.2;
/** Dias sem nenhum registro a partir dos quais vale perguntar se esqueceu algo. */
export const QUIET_DAYS_HINT = 3;

export interface WeekCategory {
  category: Category;
  cents: number;
  /** Média das semanas anteriores (proporcional aos dias, numa semana ainda em curso). */
  averageCents: number;
}

export interface WeeklySummary {
  /** Segunda-feira, "YYYY-MM-DD". */
  start: string;
  /** Último dia considerado (domingo, ou hoje numa semana em curso). */
  end: string;
  /** Dias considerados (7 numa semana fechada). */
  days: number;
  /** Todos os gastos, inclusive com VR/VA (parcelado: só a 1ª parcela, no dia da compra). */
  expenseCents: number;
  /** Receitas sem as recargas de VR/VA. */
  incomeCents: number;
  /** Aportes − resgates. */
  netInvestedCents: number;
  entries: number;
  byCategory: WeekCategory[];
  /** null quando não há semanas anteriores com gastos para comparar. */
  averageExpenseCents: number | null;
  biggest: { description: string; cents: number; date: string } | null;
  /** Dias da semana sem nenhum lançamento. */
  quietDays: number;
}

/** Segunda-feira da semana de uma data. */
export function weekStart(date: string): string {
  const weekday = (new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

const dayOf = (tx: ReportTransaction): string => tx.occurredAt.toISOString().slice(0, 10);

/** Valor que conta no dia da compra: parcelado conta só a 1ª parcela. */
function spentOnDay(tx: ReportTransaction): number {
  return tx.installments > 1
    ? (splitInstallments(tx.amountCents, tx.installments)[0] ?? 0)
    : tx.amountCents;
}

function isVoucherIncome(tx: ReportTransaction, context: ReportContext): boolean {
  return (
    tx.category === 'VALE_REFEICAO' ||
    tx.category === 'VALE_ALIMENTACAO' ||
    (tx.accountId !== null && context.voucherAccountIds.has(tx.accountId))
  );
}

/**
 * A semana de segunda até `end` (domingo, ou hoje se a semana ainda não acabou), comparada
 * com a média das 4 semanas anteriores. Numa semana em curso, a média é proporcional aos
 * dias que já passaram, para "até agora" não parecer sempre abaixo da média.
 */
export function summarizeWeek(
  transactions: readonly ReportTransaction[],
  context: ReportContext,
  end: string,
): WeeklySummary {
  const start = weekStart(end);
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  const historyStart = addDays(start, -7 * WEEKS_OF_HISTORY);

  let expenseCents = 0;
  let incomeCents = 0;
  let netInvestedCents = 0;
  let entries = 0;
  let biggest: WeeklySummary['biggest'] = null;
  const activeDays = new Set<string>();
  const byCategory = new Map<Category, number>();
  const historyByCategory = new Map<Category, number>();
  const historyWeeks = new Map<number, number>();

  for (const tx of transactions) {
    const day = dayOf(tx);
    if (day >= start && day <= end) {
      entries += 1;
      activeDays.add(day);
      if (tx.type === 'EXPENSE') {
        const cents = spentOnDay(tx);
        expenseCents += cents;
        byCategory.set(tx.category, (byCategory.get(tx.category) ?? 0) + cents);
        if (!biggest || cents > biggest.cents) {
          biggest = { description: tx.description, cents, date: day };
        }
      } else if (tx.type === 'INCOME' && !isVoucherIncome(tx, context)) {
        incomeCents += tx.amountCents;
      } else if (tx.type === 'INVESTMENT') {
        netInvestedCents += tx.amountCents;
      } else if (tx.type === 'REDEMPTION') {
        netInvestedCents -= tx.amountCents;
      }
    } else if (tx.type === 'EXPENSE' && day >= historyStart && day < start) {
      const cents = spentOnDay(tx);
      const week = Math.floor((Date.parse(day) - Date.parse(historyStart)) / (7 * 86_400_000));
      historyWeeks.set(week, (historyWeeks.get(week) ?? 0) + cents);
      historyByCategory.set(tx.category, (historyByCategory.get(tx.category) ?? 0) + cents);
    }
  }

  const scale = days / 7 / WEEKS_OF_HISTORY;
  const historyTotal = [...historyWeeks.values()].reduce((sum, cents) => sum + cents, 0);
  const categories = new Set([...byCategory.keys(), ...historyByCategory.keys()]);
  return {
    start,
    end,
    days,
    expenseCents,
    incomeCents,
    netInvestedCents,
    entries,
    byCategory: [...categories]
      .map((category) => ({
        category,
        cents: byCategory.get(category) ?? 0,
        averageCents: Math.round((historyByCategory.get(category) ?? 0) * scale),
      }))
      .sort((a, b) => b.cents - a.cents || b.averageCents - a.averageCents),
    averageExpenseCents: historyWeeks.size > 0 ? Math.round(historyTotal * scale) : null,
    biggest,
    quietDays: days - activeDays.size,
  };
}

export type WeeklyTip =
  | { kind: 'total_up' | 'total_down'; percent: number; averageCents: number }
  | {
      kind: 'category_up';
      category: Category;
      cents: number;
      averageCents: number;
      percent: number;
    }
  | {
      kind: 'category_down';
      category: Category;
      cents: number;
      averageCents: number;
      percent: number;
    }
  | { kind: 'quiet_days'; days: number };

/** Observações calculadas (sem IA): o que mudou em relação às semanas anteriores. */
export function weeklyTips(summary: WeeklySummary): WeeklyTip[] {
  const tips: WeeklyTip[] = [];
  const average = summary.averageExpenseCents;
  if (average !== null && average > 0) {
    const change = (summary.expenseCents - average) / average;
    if (change >= TOTAL_CHANGE_RATIO) {
      tips.push({ kind: 'total_up', percent: Math.round(change * 100), averageCents: average });
    } else if (change <= -TOTAL_CHANGE_RATIO) {
      tips.push({ kind: 'total_down', percent: Math.round(-change * 100), averageCents: average });
    }
  }
  if (average !== null) {
    const rises = summary.byCategory
      .filter(
        (c) =>
          c.averageCents > 0 &&
          c.cents >= c.averageCents * RISE_RATIO &&
          c.cents - c.averageCents >= RISE_MIN_CENTS,
      )
      .sort((a, b) => b.cents - b.averageCents - (a.cents - a.averageCents))
      .slice(0, 2);
    for (const c of rises) {
      tips.push({
        kind: 'category_up',
        ...c,
        percent: Math.round(((c.cents - c.averageCents) / c.averageCents) * 100),
      });
    }
    const drop = summary.byCategory
      .filter((c) => c.averageCents >= RISE_MIN_CENTS && c.cents <= c.averageCents * DROP_RATIO)
      .sort((a, b) => b.averageCents - b.cents - (a.averageCents - a.cents))[0];
    if (drop) {
      tips.push({
        kind: 'category_down',
        ...drop,
        percent: Math.round(((drop.averageCents - drop.cents) / drop.averageCents) * 100),
      });
    }
  }
  if (summary.entries > 0 && summary.quietDays >= QUIET_DAYS_HINT) {
    tips.push({ kind: 'quiet_days', days: summary.quietDays });
  }
  return tips;
}
