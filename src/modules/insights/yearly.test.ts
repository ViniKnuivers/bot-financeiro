import { describe, expect, it } from 'vitest';
import type { Category, TransactionType } from '../../generated/prisma/enums.js';
import type { ReportTransaction } from '../reports/monthly-report.js';
import { summarizeYear } from './yearly.js';

const context = { voucherAccountIds: new Set<number>() };

function tx(
  date: string,
  amountCents: number,
  description = 'Padaria',
  category: Category = 'ALIMENTACAO',
  type: TransactionType = 'EXPENSE',
): ReportTransaction {
  return {
    type,
    amountCents,
    category,
    description,
    paymentMethod: null,
    accountId: null,
    installments: 1,
    occurredAt: new Date(`${date}T00:00:00.000Z`),
  };
}

const year2026 = [
  tx('2026-09-02', 200000, 'Salário', 'SALARIO', 'INCOME'),
  tx('2026-09-03', 1500),
  tx('2026-09-10', 1500),
  tx('2026-09-20', 150000, 'Aluguel', 'MORADIA'),
  tx('2026-10-02', 200000, 'Salário', 'SALARIO', 'INCOME'),
  tx('2026-10-05', 1500, 'padaria'),
  tx('2026-10-06', 40000, 'Tênis', 'COMPRAS'),
  tx('2026-10-07', 30000, 'Tesouro', 'INVESTIMENTO', 'INVESTMENT'),
];

describe('summarizeYear', () => {
  it('o ano em números: totais, melhor e pior mês, categorias, maior gasto e o mais frequente', () => {
    const summary = summarizeYear(year2026, context, '2026', '2026-12-31');

    expect(summary).toMatchObject({
      year: '2026',
      firstActiveMonth: '2026-09',
      entries: 8,
      incomeCents: 400000,
      expenseCents: 194500,
      surplusCents: 205500,
      netInvestedCents: 30000,
      averageExpenseCents: 97250,
      biggest: { description: 'Aluguel', cents: 150000, date: '2026-09-20' },
      mostFrequent: { description: 'Padaria', count: 3, cents: 4500 },
      previous: null,
    });
    expect(summary.best?.month).toBe('2026-10');
    expect(summary.worst?.month).toBe('2026-09');
    expect(summary.byCategory.map((c) => [c.category, c.percent])).toEqual([
      ['MORADIA', 77],
      ['COMPRAS', 21],
      ['ALIMENTACAO', 2],
    ]);
    expect(summary.investments).toEqual([
      { destination: 'Tesouro', investedCents: 30000, redeemedCents: 0, balanceCents: 30000 },
    ]);
  });

  it('ano corrente: só os meses que já começaram; compara com o ano anterior', () => {
    const summary = summarizeYear(
      [...year2026, tx('2027-01-10', 97250, 'Mercado', 'MERCADO')],
      context,
      '2027',
      '2027-02-15',
    );

    expect(summary.months.map((m) => m.month)).toEqual(['2027-01', '2027-02']);
    expect(summary.previous).toEqual({ expenseCents: 194500, netInvestedCents: 30000 });
    // Só um mês com movimento: sem melhor/pior mês.
    expect(summary.best).toBeNull();
    expect(summary.mostFrequent).toBeNull();
  });
});
