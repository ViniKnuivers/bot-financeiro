/**
 * Cálculos de fatura de cartão de crédito. Funções puras sobre datas "YYYY-MM-DD" e
 * meses "YYYY-MM" (o mês em que a fatura FECHA), sem fuso nem hora envolvidos.
 */

export function daysInMonth(month: string): number {
  const [year = 0, monthNumber = 0] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

export function addMonths(month: string, count: number): string {
  const [year = 0, monthNumber = 0] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + count, 1));
  return date.toISOString().slice(0, 7);
}

/** Dia 31 em fevereiro vira o último dia do mês. */
function effectiveClosingDay(month: string, closingDay: number): number {
  return Math.min(closingDay, daysInMonth(month));
}

/** Data de fechamento da fatura de um mês. */
export function closingDate(month: string, closingDay: number): string {
  return `${month}-${String(effectiveClosingDay(month, closingDay)).padStart(2, '0')}`;
}

/**
 * Fatura em que cai uma compra: se foi antes do dia de fechamento, entra na fatura que
 * fecha naquele mês; no dia do fechamento ou depois, entra na do mês seguinte.
 */
export function invoiceMonthFor(date: string, closingDay: number): string {
  const month = date.slice(0, 7);
  const day = Number(date.slice(8, 10));
  return day < effectiveClosingDay(month, closingDay) ? month : addMonths(month, 1);
}

/** Divide em parcelas inteiras; a primeira fica com o resto (100,00 em 3x = 33,34 + 33,33 + 33,33). */
export function splitInstallments(totalCents: number, installments: number): number[] {
  const base = Math.floor(totalCents / installments);
  const remainder = totalCents - base * installments;
  return Array.from({ length: installments }, (_, index) =>
    index === 0 ? base + remainder : base,
  );
}

export interface CreditPurchase {
  amountCents: number;
  installments: number;
  /** Data da compra (Date à meia-noite UTC, como vem da coluna DATE). */
  occurredAt: Date;
}

/** Em quais faturas cada parcela de uma compra cai. */
export function installmentSchedule(
  purchase: CreditPurchase,
  closingDay: number,
): { invoiceMonth: string; amountCents: number }[] {
  const firstInvoice = invoiceMonthFor(purchase.occurredAt.toISOString().slice(0, 10), closingDay);
  return splitInstallments(purchase.amountCents, purchase.installments).map(
    (amountCents, index) => ({
      invoiceMonth: addMonths(firstInvoice, index),
      amountCents,
    }),
  );
}

export interface CreditSummaryInput {
  purchases: CreditPurchase[];
  closingDay: number;
  limitCents: number | null;
  adjustmentCents: number;
  paidMonths: readonly string[];
  /** Hoje, "YYYY-MM-DD", no fuso do usuário. */
  today: string;
}

export interface CreditSummary {
  /** A fatura ainda aberta (a próxima a fechar). */
  openInvoiceMonth: string;
  openInvoiceCents: number;
  openInvoiceClosesOn: string;
  /** null quando o limite não foi informado. */
  availableCents: number | null;
  /** A fatura já fechada mais antiga ainda não marcada como paga, se houver. */
  oldestUnpaidClosed: { month: string; cents: number } | null;
}

/**
 * Fatura atual e limite disponível. O disponível desconta TODAS as parcelas de faturas não
 * pagas, inclusive as futuras, porque o banco reserva o valor total da compra no limite.
 */
export function summarizeCredit(input: CreditSummaryInput): CreditSummary {
  const byMonth = new Map<string, number>();
  for (const purchase of input.purchases) {
    for (const { invoiceMonth, amountCents } of installmentSchedule(purchase, input.closingDay)) {
      byMonth.set(invoiceMonth, (byMonth.get(invoiceMonth) ?? 0) + amountCents);
    }
  }

  const paid = new Set(input.paidMonths);
  const openInvoiceMonth = invoiceMonthFor(input.today, input.closingDay);
  const unpaid = [...byMonth].filter(([month, cents]) => !paid.has(month) && cents > 0);
  const usedCents = unpaid.reduce((total, [, cents]) => total + cents, 0);

  // Meses "YYYY-MM" comparados como texto já ficam em ordem cronológica.
  const closedUnpaid = unpaid
    .filter(([month]) => month < openInvoiceMonth)
    .sort(([a], [b]) => a.localeCompare(b));
  const [oldest] = closedUnpaid;

  return {
    openInvoiceMonth,
    openInvoiceCents: byMonth.get(openInvoiceMonth) ?? 0,
    openInvoiceClosesOn: closingDate(openInvoiceMonth, input.closingDay),
    availableCents:
      input.limitCents === null ? null : input.limitCents - usedCents + input.adjustmentCents,
    oldestUnpaidClosed: oldest ? { month: oldest[0], cents: oldest[1] } : null,
  };
}
