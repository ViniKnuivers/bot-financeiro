import type { Category, PaymentMethod, TransactionType } from '../../generated/prisma/enums.js';
import { formatDayMonth } from '../../lib/dates.js';
import { formatCents } from '../../lib/money.js';
import { addMonths, daysInMonth } from '../accounts/credit-invoice.js';
import { summarizeMonths, type ReportTransaction } from '../reports/monthly-report.js';
import { datedShares } from './query.js';

/**
 * Previsão da sobra do mês (mesma definição do /resumo: receitas − despesas, sem VR/VA):
 * o que já aconteceu + os fixos que ainda vão ser lançados + o gasto do dia a dia previsto
 * para os dias que faltam.
 */

/** O mínimo de um gasto fixo para a previsão. */
export interface ForecastRecurring {
  type: TransactionType;
  amountCents: number;
  category: Category;
  paymentMethod: PaymentMethod | null;
  accountId: number | null;
  active: boolean;
  lastRunMonth: string | null;
}

export interface ForecastInput {
  /** Hoje, "YYYY-MM-DD", no fuso do usuário. */
  today: string;
  transactions: readonly ReportTransaction[];
  recurring: readonly ForecastRecurring[];
  voucherAccountIds: ReadonlySet<number>;
}

/**
 * De onde veio o ritmo do dia a dia: média dos meses anteriores ("history"), o próprio
 * mês ("month", quando ainda não há histórico) ou nada ("none", sem lançamentos).
 */
export type ForecastBasis = 'history' | 'month' | 'none';

export interface Forecast {
  month: string;
  /** Último dia do mês. */
  endDate: string;
  soFarIncomeCents: number;
  soFarExpenseCents: number;
  fixedIncomeCents: number;
  fixedExpenseCents: number;
  /** Gasto do dia a dia previsto para os dias que faltam. */
  variableCents: number;
  incomeCents: number;
  expenseCents: number;
  surplusCents: number;
  basis: ForecastBasis;
}

const HISTORY_MONTHS = 3;
const MIN_HISTORY_DAYS = 30;

export function forecastMonth(input: ForecastInput): Forecast {
  const { today, transactions, voucherAccountIds } = input;
  const month = today.slice(0, 7);
  const lastDay = daysInMonth(month);
  const dayOfMonth = Number(today.slice(8, 10));
  const [current] = summarizeMonths(transactions, { voucherAccountIds }, [month]);

  let fixedIncomeCents = 0;
  let fixedExpenseCents = 0;
  for (const entry of input.recurring) {
    if (!entry.active || entry.lastRunMonth === month || isVoucher(entry, voucherAccountIds)) {
      continue;
    }
    if (entry.type === 'INCOME') fixedIncomeCents += entry.amountCents;
    if (entry.type === 'EXPENSE') fixedExpenseCents += entry.amountCents;
  }

  const { dailyCents, basis } = variableDailyRate(input, month, dayOfMonth);
  const variableCents = Math.round(dailyCents * (lastDay - dayOfMonth));

  const soFarIncomeCents = current?.incomeCents ?? 0;
  const soFarExpenseCents = current?.expenseCents ?? 0;
  const incomeCents = soFarIncomeCents + fixedIncomeCents;
  const expenseCents = soFarExpenseCents + fixedExpenseCents + variableCents;
  return {
    month,
    endDate: `${month}-${String(lastDay).padStart(2, '0')}`,
    soFarIncomeCents,
    soFarExpenseCents,
    fixedIncomeCents,
    fixedExpenseCents,
    variableCents,
    incomeCents,
    expenseCents,
    surplusCents: incomeCents - expenseCents,
    basis,
  };
}

/**
 * Gasto do dia a dia por dia: média dos 3 meses completos anteriores (sem fixos e sem
 * VR/VA). Com menos de 30 dias de histórico, usa o ritmo deste mês até hoje.
 */
function variableDailyRate(
  input: ForecastInput,
  month: string,
  dayOfMonth: number,
): { dailyCents: number; basis: ForecastBasis } {
  const variable = input.transactions.filter(
    (tx) =>
      tx.type === 'EXPENSE' && tx.source !== 'RECURRING' && !isVoucher(tx, input.voucherAccountIds),
  );
  if (input.transactions.length === 0) return { dailyCents: 0, basis: 'none' };

  const monthStart = `${month}-01`;
  const earliest = input.transactions
    .map((tx) => tx.occurredAt.toISOString().slice(0, 10))
    .reduce((min, date) => (date < min ? date : min));
  const historyStart = `${addMonths(month, -HISTORY_MONTHS)}-01`;
  const from = earliest > historyStart ? earliest : historyStart;
  const historyDays = daysBetween(from, monthStart);

  if (historyDays >= MIN_HISTORY_DAYS) {
    const cents = sumShares(variable, from, monthStart);
    return { dailyCents: cents / historyDays, basis: 'history' };
  }
  const tomorrow = `${month}-${String(dayOfMonth + 1).padStart(2, '0')}`;
  return { dailyCents: sumShares(variable, monthStart, tomorrow) / dayOfMonth, basis: 'month' };
}

/** Soma das parcelas com data em [start, end). */
function sumShares(transactions: readonly ReportTransaction[], start: string, end: string): number {
  let cents = 0;
  for (const tx of transactions) {
    for (const share of datedShares(tx)) {
      if (share.date >= start && share.date < end) cents += share.cents;
    }
  }
  return cents;
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / (24 * 60 * 60 * 1000));
}

function isVoucher(
  entry: Pick<ForecastRecurring, 'paymentMethod' | 'category' | 'accountId'>,
  voucherAccountIds: ReadonlySet<number>,
): boolean {
  return (
    entry.paymentMethod === 'VR' ||
    entry.paymentMethod === 'VA' ||
    entry.category === 'VALE_REFEICAO' ||
    entry.category === 'VALE_ALIMENTACAO' ||
    (entry.accountId !== null && voucherAccountIds.has(entry.accountId))
  );
}

/**
 * "🔮 Previsão para 31/10: sobra de R$ 1.200,00 (no ritmo atual)" ou, se o mês for
 * fechar negativo, "⚠️ Previsão para 31/10: faltam R$ 300,00 (...)". O ⚠️ no começo é o
 * que pinta a faixa de vermelho no Painel.
 */
export function forecastSentence(forecast: Forecast): string {
  const end = formatDayMonth(new Date(`${forecast.endDate}T00:00:00.000Z`));
  if (forecast.basis === 'none') {
    return `🔮 Previsão para ${end}: ainda sem lançamentos para calcular.`;
  }
  return forecast.surplusCents >= 0
    ? `🔮 Previsão para ${end}: sobra de ${formatCents(forecast.surplusCents)} (no ritmo atual)`
    : `⚠️ Previsão para ${end}: o mês fecha no vermelho em ${formatCents(-forecast.surplusCents)} (no ritmo atual)`;
}

/**
 * De onde vem a previsão, para dar transparência:
 * "   gastos: R$ 800,00 já foram + R$ 1.200,00 de fixos + R$ 450,00 do dia a dia".
 */
export function forecastBreakdown(forecast: Forecast): string {
  const parts = [`${formatCents(forecast.soFarExpenseCents)} já foram`];
  if (forecast.fixedExpenseCents > 0) {
    parts.push(`${formatCents(forecast.fixedExpenseCents)} de fixos`);
  }
  parts.push(`${formatCents(forecast.variableCents)} do dia a dia`);
  const income =
    forecast.fixedIncomeCents > 0
      ? `\n   receitas: ${formatCents(forecast.fixedIncomeCents)} ainda vão entrar`
      : '';
  return `   gastos: ${parts.join(' + ')}${income}`;
}
