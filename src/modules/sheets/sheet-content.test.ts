import { describe, expect, it } from 'vitest';
import type { Account } from '../accounts/account.repository.js';
import { summarizeMonths, lastMonths } from '../reports/monthly-report.js';
import type { Transaction } from '../transactions/transaction.repository.js';
import { buildSheetContent, type SheetData } from './sheet-content.js';

const santander = {
  id: 3,
  name: 'Santander',
  kind: 'CREDIT_CARD',
  initialBalanceCents: 0,
  creditLimitCents: 300000,
  closingDay: 5,
  creditAdjustmentCents: 0,
  archivedAt: null,
  createdAt: new Date(),
} satisfies Account;

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'tx-1',
    type: 'EXPENSE',
    amountCents: 3200,
    description: 'Almoço',
    category: 'ALIMENTACAO',
    paymentMethod: 'CREDITO',
    occurredAt: new Date('2026-09-24T00:00:00.000Z'),
    rawInput: 'x',
    source: 'AUDIO',
    batchId: 'b',
    accountId: 3,
    installments: 1,
    createdAt: new Date(),
    ...overrides,
  };
}

function data(transactions: Transaction[], overrides: Partial<SheetData> = {}): SheetData {
  return {
    today: '2026-09-24',
    transactions,
    accounts: [santander],
    months: summarizeMonths(
      transactions,
      { voucherAccountIds: new Set() },
      lastMonths('2026-09', 24),
    ),
    budgets: [{ category: 'ALIMENTACAO', limitCents: 10000 }],
    balances: [],
    cards: [],
    investments: [],
    netInvestedBefore: 0,
    ...overrides,
  };
}

const range = (content: ReturnType<typeof buildSheetContent>, name: string) =>
  content.data.find((r) => r.range === name)?.values ?? [];

describe('buildSheetContent', () => {
  it('lançamentos: data como número de série, valor em reais, rótulos em português', () => {
    const content = buildSheetContent(data([tx({})]));

    expect(range(content, "'Lançamentos'!A1:K")[1]).toEqual([
      'tx-1',
      46289, // 24/09/2026
      'Despesa',
      'Almoço',
      'Alimentação',
      32,
      1,
      'Crédito',
      'Santander (crédito)',
      'Telegram (áudio)',
      '',
    ]);
  });

  it('categorias: mês atual, anterior, variação e % do orçamento', () => {
    const content = buildSheetContent(
      data([
        tx({ amountCents: 8500 }),
        tx({ id: 'tx-2', amountCents: 5000, occurredAt: new Date('2026-08-10T00:00:00.000Z') }),
      ]),
    );

    expect(range(content, "'Categorias'!A1:F12")[1]).toEqual([
      'Alimentação',
      85,
      50,
      35,
      100,
      0.85,
    ]);
  });

  it('investido acumulado soma o que veio antes da tabela', () => {
    const content = buildSheetContent(
      data(
        [
          tx({
            type: 'INVESTMENT',
            category: 'INVESTIMENTO',
            amountCents: 50000,
            paymentMethod: null,
          }),
        ],
        { netInvestedBefore: 100000 },
      ),
    );
    const table = range(content, "'Resumo'!D1:L25");

    expect(table).toHaveLength(25);
    expect(table.at(-1)?.[8]).toBe(1500);
    // Tabela de apoio dos gráficos: cabeçalho + 12 meses.
    expect(range(content, "'Resumo'!N1:S13")).toHaveLength(13);
  });

  it('faturas por cartão: 3 meses atrás a 6 à frente', () => {
    const content = buildSheetContent(
      data([], {
        cards: [
          { account: santander, summary: null, invoiceTotals: new Map([['2026-10', 12000]]) },
        ],
      }),
    );
    const invoices = range(content, "'Cartões e vales'!A2:B12");

    expect(invoices.map((row) => row[0])).toEqual([
      'Mês',
      'jun/2026',
      'jul/2026',
      'ago/2026',
      'set/2026',
      'out/2026',
      'nov/2026',
      'dez/2026',
      'jan/2027',
      'fev/2027',
      'mar/2027',
    ]);
    expect(invoices[5]).toEqual(['out/2026', 120]);
  });
});
