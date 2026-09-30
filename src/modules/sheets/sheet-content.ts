import type { InputSource } from '../../generated/prisma/enums.js';
import { formatMonthLong, formatMonthShort, toSheetSerial } from '../../lib/dates.js';
import { accountLabel } from '../accounts/account-kinds.js';
import type { Account } from '../accounts/account.repository.js';
import { addMonths, type CreditSummary } from '../accounts/credit-invoice.js';
import type { BudgetLimit } from '../budgets/budget.repository.js';
import type { InvestmentPosition, MonthSummary } from '../reports/monthly-report.js';
import type { AccountBalance } from '../reports/report.service.js';
import {
  categoryLabelWithIcon,
  PAYMENT_METHOD_LABELS,
  TYPE_LABELS,
} from '../transactions/transaction.labels.js';
import type { Transaction } from '../transactions/transaction.repository.js';
import { EXPENSE_CATEGORIES } from '../transactions/transaction.schemas.js';
import { DATA, dataTabContent, monthTable } from './sheet-dashboard.js';
import {
  a1,
  columnLetter,
  INVOICE_MONTHS_BACK,
  INVOICE_ROWS,
  MAX_BALANCE_ROWS,
  MAX_CARD_ROWS,
  MAX_INVESTMENT_ROWS,
  SUMMARY_TABLE_HEADERS,
  TRANSACTION_HEADERS,
} from './sheet-layout.js';
import type { RangeValues } from './spreadsheet-gateway.js';

/** Cartão de crédito com fatura configurada, para a aba de cartões. */
export interface SheetCard {
  account: Account;
  summary: CreditSummary | null;
  /** Total de cada fatura ("YYYY-MM" → centavos), com parcelas futuras. */
  invoiceTotals: ReadonlyMap<string, number>;
}

export interface SheetData {
  /** Hoje ("YYYY-MM-DD") no fuso do usuário. */
  today: string;
  /** Momento desta sincronização, para o "Atualizado em" do Painel ("25/09/2026 16:40"). */
  updatedAt: string;
  /** Frase da previsão do fim do mês, para a faixa do Painel (null sem previsão). */
  forecast?: string | null;
  transactions: readonly Transaction[];
  /** Todas as contas, inclusive arquivadas (lançamentos antigos usam o nome). */
  accounts: readonly Account[];
  /** Meses em ordem cronológica, terminando no mês atual (tamanho SUMMARY_MONTHS). */
  months: readonly MonthSummary[];
  budgets: readonly BudgetLimit[];
  balances: readonly AccountBalance[];
  /** Cartões de crédito ativos (com ou sem fechamento configurado). */
  cards: readonly SheetCard[];
  investments: readonly InvestmentPosition[];
  /** Aportes − resgates anteriores ao primeiro mês da tabela (base do acumulado). */
  netInvestedBefore: number;
  /** Mensagem para a coluna Status de um lançamento (ex.: edição recusada). */
  statuses?: ReadonlyMap<string, string>;
  /** Linhas novas digitadas à mão que ainda têm erro: ficam no fim, para você corrigir. */
  pendingRows?: readonly Cell[][];
}

export interface SheetContent {
  clearRanges: string[];
  data: RangeValues[];
}

export type Cell = string | number | null;

const SOURCE_LABELS: Record<InputSource, string> = {
  // Telegram ou WhatsApp: os dois chegam como mensagem de texto ou de voz. PHOTO veio da
  // leitura de comprovantes, que foi removida; fica para os lançamentos já feitos.
  TEXT: 'Chat (texto)',
  AUDIO: 'Chat (áudio)',
  PHOTO: 'Chat (foto)',
  RECURRING: 'Gasto fixo',
  SHEET: 'Planilha',
};

/** Centavos → reais, só para gravar na planilha (a conta em si é sempre em centavos). */
const reais = (cents: number): number => cents / 100;

/** Tudo que o bot escreve na planilha, aba por aba. */
export function buildSheetContent(input: SheetData): SheetContent {
  return {
    clearRanges: [
      a1('transactions', 'A2:K'),
      a1('summary', 'A1:S40'),
      a1('categories', 'A1:F20'),
      a1('cards', 'A1:Z40'),
      a1('investments', 'A1:G40'),
      a1('data', DATA.clear),
    ],
    data: [
      ...transactionsTab(input),
      ...summaryTab(input),
      ...categoriesTab(input),
      ...cardsTab(input),
      ...investmentsTab(input),
      ...dataTabContent(input),
    ],
  };
}

function transactionsTab({
  transactions,
  accounts,
  statuses,
  pendingRows = [],
}: SheetData): RangeValues[] {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const rows: Cell[][] = transactions.map((t) => {
    const account = t.accountId === null ? undefined : byId.get(t.accountId);
    return [
      t.id,
      toSheetSerial(t.occurredAt.toISOString().slice(0, 10)),
      TYPE_LABELS[t.type],
      t.description,
      categoryLabelWithIcon(t.category),
      reais(t.amountCents),
      t.installments,
      t.paymentMethod ? PAYMENT_METHOD_LABELS[t.paymentMethod] : '',
      account ? accountLabel(account) : '',
      SOURCE_LABELS[t.source],
      statuses?.get(t.id) ?? '',
    ];
  });
  return [
    {
      range: a1('transactions', 'A1:K'),
      values: [[...TRANSACTION_HEADERS], ...rows, ...pendingRows],
    },
  ];
}

function summaryTab(input: SheetData): RangeValues[] {
  const current = input.months.at(-1);
  if (!current) return [];

  const block: Cell[][] = [
    ['Mês atual', formatMonthLong(current.month)],
    ['Receitas', reais(current.incomeCents)],
    ['Despesas', reais(current.expenseCents)],
    ['Sobra', reais(current.surplusCents)],
    ['Investido (aportes − resgates)', reais(current.netInvestedCents)],
    ['Livre depois de investir', reais(current.freeCents)],
    ['VR/VA: entrou', reais(current.voucherIncomeCents)],
    ['VR/VA: saiu', reais(current.voucherExpenseCents)],
    [],
    ['Saldos agora', ''],
    ...input.balances
      .slice(0, MAX_BALANCE_ROWS)
      .map(({ account, cents }): Cell[] => [accountLabel(account), reais(cents)]),
  ];

  return [
    { range: a1('summary', 'A1:B20'), values: block },
    {
      range: a1('summary', 'D1:L25'),
      values: [[...SUMMARY_TABLE_HEADERS], ...monthTable(input)],
    },
  ];
}

function categoriesTab(input: SheetData): RangeValues[] {
  const current = input.months.at(-1);
  const previous = input.months.at(-2);
  if (!current) return [];
  const spent = (summary: MonthSummary | undefined) =>
    new Map((summary?.byCategory ?? []).map((c) => [c.category, c.cents]));
  const now = spent(current);
  const before = spent(previous);
  const budgets = new Map(input.budgets.map((b) => [b.category, b.limitCents]));

  const rows: Cell[][] = EXPENSE_CATEGORIES.map((category) => {
    const cents = now.get(category) ?? 0;
    const previousCents = before.get(category) ?? 0;
    const limit = budgets.get(category);
    return [
      categoryLabelWithIcon(category),
      reais(cents),
      reais(previousCents),
      reais(cents - previousCents),
      limit === undefined ? '' : reais(limit),
      limit === undefined ? '' : cents / limit,
    ];
  });

  return [
    {
      range: a1('categories', 'A1:F12'),
      values: [
        [
          'Categoria',
          formatMonthShort(current.month),
          previous ? formatMonthShort(previous.month) : 'Mês anterior',
          'Variação',
          'Orçamento',
          '% do orçamento',
        ],
        ...rows,
      ],
    },
  ];
}

/** Cartões com fechamento configurado: são os que têm fatura calculável (e gráfico). */
export function cardsWithInvoices(cards: readonly SheetCard[]): SheetCard[] {
  return cards.filter((card) => card.account.closingDay !== null).slice(0, MAX_CARD_ROWS);
}

function cardsTab(input: SheetData): RangeValues[] {
  const month = input.today.slice(0, 7);
  const withInvoices = cardsWithInvoices(input.cards);
  const months = Array.from({ length: INVOICE_ROWS }, (_, i) =>
    addMonths(month, i - INVOICE_MONTHS_BACK),
  );
  const lastColumn = columnLetter(Math.max(1, withInvoices.length));

  const invoiceTable: Cell[][] = [
    ['Mês', ...withInvoices.map((card) => card.account.name)],
    ...months.map((m): Cell[] => [
      formatMonthShort(m),
      ...withInvoices.map((card) => reais(card.invoiceTotals.get(m) ?? 0)),
    ]),
  ];

  const cardRows: Cell[][] = input.cards.slice(0, MAX_CARD_ROWS).map((card) => {
    const { account, summary } = card;
    return [
      account.name,
      account.creditLimitCents === null ? '' : reais(account.creditLimitCents),
      summary ? reais(summary.openInvoiceCents) : '',
      summary ? toSheetSerial(summary.openInvoiceClosesOn) : '',
      summary?.availableCents == null ? '' : reais(summary.availableCents),
      summary?.oldestUnpaidClosed ? reais(summary.oldestUnpaidClosed.cents) : '',
    ];
  });

  return [
    { range: a1('cards', 'A1'), values: [['Faturas por mês (inclui parcelas futuras)']] },
    { range: a1('cards', `A2:${lastColumn}${2 + INVOICE_ROWS}`), values: invoiceTable },
    { range: a1('cards', 'A14'), values: [['Cartões de crédito']] },
    {
      range: a1('cards', `A15:F${15 + MAX_CARD_ROWS}`),
      values: [
        ['Cartão', 'Limite', 'Fatura aberta', 'Fecha em', 'Disponível', 'Fatura fechada não paga'],
        ...cardRows,
      ],
    },
  ];
}

function investmentsTab(input: SheetData): RangeValues[] {
  const rows: Cell[][] = input.investments
    .slice(0, MAX_INVESTMENT_ROWS)
    .map((p) => [
      p.destination,
      reais(p.investedCents),
      reais(p.redeemedCents),
      reais(p.balanceCents),
    ]);
  const total = input.investments.reduce((sum, p) => sum + p.balanceCents, 0);
  return [
    {
      range: a1('investments', `A1:D${1 + MAX_INVESTMENT_ROWS}`),
      values: [['Destino', 'Aportes', 'Resgates', 'Saldo investido'], ...rows],
    },
    { range: a1('investments', 'F1:G1'), values: [['Total investido', reais(total)]] },
  ];
}
