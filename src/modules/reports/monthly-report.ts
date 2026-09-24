import type { Category, PaymentMethod, TransactionType } from '../../generated/prisma/enums.js';
import { normalizeName } from '../accounts/account-kinds.js';
import { addMonths, splitInstallments } from '../accounts/credit-invoice.js';

/**
 * Relatórios mensais em regime de competência: cada lançamento conta no mês em que
 * aconteceu. Parcelado: a 1ª parcela no mês da compra e as seguintes nos meses seguintes.
 * Funções puras, usadas pelo /resumo, pela planilha e pelo aviso do dia 1.
 */

export interface ReportTransaction {
  type: TransactionType;
  amountCents: number;
  category: Category;
  description: string;
  paymentMethod: PaymentMethod | null;
  accountId: number | null;
  installments: number;
  /** Data (meia-noite UTC, como vem da coluna DATE). */
  occurredAt: Date;
}

export interface ReportContext {
  /** Ids dos cartões de VR/VA: dinheiro de vale não entra na sobra (não dá para investir). */
  voucherAccountIds: ReadonlySet<number>;
}

export interface CategoryTotal {
  category: Category;
  cents: number;
}

export interface MonthSummary {
  month: string;
  /** Receitas sem recargas de VR/VA. */
  incomeCents: number;
  /** Despesas sem as pagas com VR/VA. */
  expenseCents: number;
  voucherIncomeCents: number;
  voucherExpenseCents: number;
  /** Receitas − despesas (sem VR/VA): o que sobrou para investir. */
  surplusCents: number;
  investedCents: number;
  redeemedCents: number;
  /** Aportes − resgates. */
  netInvestedCents: number;
  /** Sobra − investido: o que ficou livre na conta. */
  freeCents: number;
  /** Despesas por categoria, incluindo VR/VA (é gasto de verdade), da maior para a menor. */
  byCategory: CategoryTotal[];
}

export function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** Quanto de um lançamento cai em cada mês. */
export function monthlyShares(tx: ReportTransaction): { month: string; cents: number }[] {
  const first = monthOf(tx.occurredAt);
  if (tx.type !== 'EXPENSE' || tx.installments <= 1) {
    return [{ month: first, cents: tx.amountCents }];
  }
  return splitInstallments(tx.amountCents, tx.installments).map((cents, index) => ({
    month: addMonths(first, index),
    cents,
  }));
}

function isVoucherMoney(tx: ReportTransaction, context: ReportContext): boolean {
  return (
    tx.paymentMethod === 'VR' ||
    tx.paymentMethod === 'VA' ||
    tx.category === 'VALE_REFEICAO' ||
    tx.category === 'VALE_ALIMENTACAO' ||
    (tx.accountId !== null && context.voucherAccountIds.has(tx.accountId))
  );
}

function emptySummary(month: string): MonthSummary {
  return {
    month,
    incomeCents: 0,
    expenseCents: 0,
    voucherIncomeCents: 0,
    voucherExpenseCents: 0,
    surplusCents: 0,
    investedCents: 0,
    redeemedCents: 0,
    netInvestedCents: 0,
    freeCents: 0,
    byCategory: [],
  };
}

/**
 * Resumo de vários meses de uma vez (uma passada pelos lançamentos).
 * `months` define quais meses aparecem, mesmo os sem movimento.
 */
export function summarizeMonths(
  transactions: readonly ReportTransaction[],
  context: ReportContext,
  months: readonly string[],
): MonthSummary[] {
  const summaries = new Map(months.map((month) => [month, emptySummary(month)]));
  const categories = new Map(months.map((month) => [month, new Map<Category, number>()]));

  for (const tx of transactions) {
    const voucher = isVoucherMoney(tx, context);
    for (const { month, cents } of monthlyShares(tx)) {
      const summary = summaries.get(month);
      if (!summary) continue;
      switch (tx.type) {
        case 'INCOME':
          if (voucher) summary.voucherIncomeCents += cents;
          else summary.incomeCents += cents;
          break;
        case 'EXPENSE': {
          if (voucher) summary.voucherExpenseCents += cents;
          else summary.expenseCents += cents;
          const byCategory = categories.get(month);
          byCategory?.set(tx.category, (byCategory.get(tx.category) ?? 0) + cents);
          break;
        }
        case 'INVESTMENT':
          summary.investedCents += cents;
          break;
        case 'REDEMPTION':
          summary.redeemedCents += cents;
          break;
      }
    }
  }

  return months.map((month) => {
    const summary = summaries.get(month) ?? emptySummary(month);
    summary.surplusCents = summary.incomeCents - summary.expenseCents;
    summary.netInvestedCents = summary.investedCents - summary.redeemedCents;
    summary.freeCents = summary.surplusCents - summary.netInvestedCents;
    summary.byCategory = [...(categories.get(month) ?? [])]
      .map(([category, cents]) => ({ category, cents }))
      .sort((a, b) => b.cents - a.cents);
    return summary;
  });
}

/** Os `count` meses que terminam em `endMonth`, do mais antigo para o mais novo. */
export function lastMonths(endMonth: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addMonths(endMonth, index - count + 1));
}

export interface InvestmentPosition {
  destination: string;
  investedCents: number;
  redeemedCents: number;
  /** Aportes − resgates (sem rendimentos: o bot não conhece a rentabilidade). */
  balanceCents: number;
}

/**
 * Total por destino ("Tesouro Selic", "Caixinha"). Nomes iguais sem diferenciar
 * maiúsculas e acentos são o mesmo destino; o primeiro nome usado é o exibido.
 */
export function investmentsByDestination(
  transactions: readonly ReportTransaction[],
): InvestmentPosition[] {
  const positions = new Map<string, InvestmentPosition>();
  for (const tx of transactions) {
    if (tx.type !== 'INVESTMENT' && tx.type !== 'REDEMPTION') continue;
    const key = normalizeName(tx.description);
    const position = positions.get(key) ?? {
      destination: tx.description.trim(),
      investedCents: 0,
      redeemedCents: 0,
      balanceCents: 0,
    };
    if (tx.type === 'INVESTMENT') position.investedCents += tx.amountCents;
    else position.redeemedCents += tx.amountCents;
    position.balanceCents = position.investedCents - position.redeemedCents;
    positions.set(key, position);
  }
  return [...positions.values()].sort((a, b) => b.balanceCents - a.balanceCents);
}

/**
 * Nome canônico de um destino de investimento. A IA às vezes encurta ("Caixinha" para um
 * "Caixinha Nubank" já existente), o que partiria o mesmo investimento em dois. Se o nome
 * for igual a um destino conhecido, ou o começo de exatamente um deles, usa o conhecido.
 */
export function canonicalDestination(name: string, known: readonly string[]): string {
  const target = normalizeName(name);
  const exact = known.find((destination) => normalizeName(destination) === target);
  if (exact) return exact;
  const prefixed = known.filter((destination) =>
    normalizeName(destination).startsWith(`${target} `),
  );
  const [only] = prefixed;
  return prefixed.length === 1 && only ? only : name.trim();
}
