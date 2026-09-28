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
    updatedAt: '24/09/2026 10:00',
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
      '🍔 Alimentação',
      32,
      1,
      'Crédito',
      'Santander (crédito)',
      'Chat (áudio)',
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
      '🍔 Alimentação',
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
    // Tabela de apoio dos gráficos (aba Dados): cabeçalho + 12 meses, acumulado no fim.
    const chart = range(content, "'Dados'!K1:P13");
    expect(chart).toHaveLength(13);
    expect(chart.at(-1)?.[5]).toBe(1500);
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

describe('aba Dados (base do Painel)', () => {
  const itau = { ...santander, id: 1, name: 'Itaú', kind: 'BANK' as const, creditLimitCents: null };

  it('gastos por categoria de cada mês, com chave "mês#posição" e do maior para o menor', () => {
    const content = buildSheetContent(
      data([
        tx({ amountCents: 3000 }),
        tx({ id: 'tx-2', amountCents: 9000, category: 'TRANSPORTE' }),
        tx({ id: 'tx-3', amountCents: 1000, occurredAt: new Date('2026-08-05T00:00:00.000Z') }),
      ]),
    );
    const rows = range(content, "'Dados'!R1:T265");

    expect(rows.slice(1)).toEqual([
      ['ago/2026#1', '🍔 Alimentação', 10],
      ['set/2026#1', '🚗 Transporte', 90],
      ['set/2026#2', '🍔 Alimentação', 30],
    ]);
  });

  it('orçamento do mês: gasto, limite e uso, inclusive categoria ainda sem gasto', () => {
    const content = buildSheetContent(
      data([tx({ amountCents: 8500 })], {
        budgets: [
          { category: 'ALIMENTACAO', limitCents: 10000 },
          { category: 'LAZER', limitCents: 20000 },
        ],
      }),
    );
    const september = range(content, "'Dados'!V1:Z265").filter((r) =>
      String(r[0]).startsWith('set/2026#'),
    );

    expect(september).toEqual([
      ['set/2026#1', '🍔 Alimentação', 85, 100, 0.85],
      ['set/2026#2', '🎉 Lazer', 0, 200, 0],
    ]);
  });

  it('maiores gastos: 5 por mês, do mais caro para o mais barato; mês sem gasto não aparece', () => {
    const expenses = Array.from({ length: 7 }, (_, i) =>
      tx({ id: `tx-${i}`, amountCents: (i + 1) * 1000, description: `Gasto ${i + 1}` }),
    );
    const content = buildSheetContent(
      data([...expenses, tx({ id: 'salario', type: 'INCOME', category: 'SALARIO' })]),
    );
    const top = range(content, "'Dados'!AB1:AF121").slice(1);

    expect(top.map((r) => [r[0], r[2], r[4]])).toEqual([
      ['set/2026#1', 'Gasto 7', 70],
      ['set/2026#2', 'Gasto 6', 60],
      ['set/2026#3', 'Gasto 5', 50],
      ['set/2026#4', 'Gasto 4', 40],
      ['set/2026#5', 'Gasto 3', 30],
    ]);
  });

  it('últimos lançamentos: mais recentes primeiro, com sinal de entrada e saída', () => {
    const content = buildSheetContent(
      data([
        tx({ id: 'velho', occurredAt: new Date('2026-09-01T00:00:00.000Z') }),
        tx({
          id: 'salario',
          type: 'INCOME',
          category: 'SALARIO',
          description: 'Salário',
          amountCents: 375000,
        }),
      ]),
    );
    const latest = range(content, "'Dados'!AH1:AL9").slice(1);

    expect(latest.map((r) => [r[1], r[3], r[4]])).toEqual([
      ['Salário', '💰 Receita', 3750],
      ['Almoço', '💸 Despesa', -32],
    ]);
  });

  it('lista do seletor começa em "Mês atual" e vem do mês mais novo para o mais velho', () => {
    const content = buildSheetContent(data([]));
    const list = range(content, "'Dados'!AZ1:AZ25").map((r) => r[0]);

    expect(list).toHaveLength(25);
    expect(list.slice(0, 3)).toEqual(['Mês atual', 'set/2026', 'ago/2026']);
    expect(list.at(-1)).toBe('out/2024');
  });

  it('saldo em conta soma só as contas bancárias; atualizado em vai para o Painel', () => {
    const vr = { ...santander, id: 4, name: 'VR', kind: 'MEAL_VOUCHER' as const };
    const content = buildSheetContent(
      data([], {
        balances: [
          { account: itau, cents: 230000 },
          { account: vr, cents: 5900 },
        ],
      }),
    );

    expect(range(content, "'Dados'!AW1:AX2")).toEqual([
      ['Atualizado em', '24/09/2026 10:00'],
      ['Saldo em conta', 2300],
    ]);
    expect(range(content, "'Dados'!AT1:AU11").slice(1)).toEqual([
      ['🏦 Itaú (conta)', 2300],
      ['🍽️ VR', 59],
    ]);
  });
});
