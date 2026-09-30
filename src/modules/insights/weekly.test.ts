import { describe, expect, it } from 'vitest';
import type { Category, TransactionType } from '../../generated/prisma/enums.js';
import type { ReportTransaction } from '../reports/monthly-report.js';
import { summarizeWeek, weeklyTips, weekStart } from './weekly.js';

const context = { voucherAccountIds: new Set([9]) };

function tx(
  date: string,
  amountCents: number,
  category: Category = 'ALIMENTACAO',
  type: TransactionType = 'EXPENSE',
  extra: Partial<ReportTransaction> = {},
): ReportTransaction {
  return {
    type,
    amountCents,
    category,
    description: 'Gasto',
    paymentMethod: null,
    accountId: null,
    installments: 1,
    occurredAt: new Date(`${date}T00:00:00.000Z`),
    ...extra,
  };
}

/** 4 semanas anteriores (de 31/08 a 27/09) com R$ 100 de Alimentação e R$ 100 de Lazer. */
const history = ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22'].flatMap((date) => [
  tx(date, 10000),
  tx(date, 10000, 'LAZER'),
]);

describe('summarizeWeek', () => {
  it('soma a semana de segunda a domingo e compara com a média das 4 anteriores', () => {
    const summary = summarizeWeek(
      [
        ...history,
        tx('2026-09-28', 20000),
        tx('2026-09-29', 30000, 'COMPRAS', 'EXPENSE', { installments: 3, description: 'Tênis' }),
        tx('2026-09-30', 150000, 'SALARIO', 'INCOME'),
        tx('2026-09-30', 60000, 'VALE_REFEICAO', 'INCOME'), // recarga de VR: não conta
        tx('2026-10-01', 40000, 'INVESTIMENTO', 'INVESTMENT'),
        tx('2026-10-05', 99999), // semana seguinte
      ],
      context,
      '2026-10-04',
    );

    expect(summary).toMatchObject({
      start: '2026-09-28',
      end: '2026-10-04',
      days: 7,
      // Alimentação 200 + 1ª parcela do tênis (300 em 3x = 100).
      expenseCents: 30000,
      incomeCents: 150000,
      netInvestedCents: 40000,
      entries: 5,
      averageExpenseCents: 20000,
      biggest: { description: 'Gasto', cents: 20000, date: '2026-09-28' },
      quietDays: 3,
    });
    expect(summary.byCategory).toEqual([
      { category: 'ALIMENTACAO', cents: 20000, averageCents: 10000 },
      { category: 'COMPRAS', cents: 10000, averageCents: 0 },
      { category: 'LAZER', cents: 0, averageCents: 10000 },
    ]);
  });

  it('semana em curso: a média é proporcional aos dias que já passaram', () => {
    const summary = summarizeWeek([...history, tx('2026-09-29', 5000)], context, '2026-09-30');

    expect(summary.days).toBe(3);
    // R$ 200 por semana × 3/7 dias.
    expect(summary.averageExpenseCents).toBe(8571);
  });

  it('sem histórico, não há média', () => {
    expect(
      summarizeWeek([tx('2026-09-29', 5000)], context, '2026-10-04').averageExpenseCents,
    ).toBeNull();
    expect(weekStart('2026-10-04')).toBe('2026-09-28');
  });
});

describe('weeklyTips', () => {
  it('aponta o total acima da média, a categoria que subiu, a que caiu e os dias sem registro', () => {
    const summary = summarizeWeek(
      [...history, tx('2026-09-28', 25000), tx('2026-09-29', 1000, 'LAZER')],
      context,
      '2026-10-04',
    );

    expect(weeklyTips(summary)).toEqual([
      { kind: 'total_up', percent: 30, averageCents: 20000 },
      {
        kind: 'category_up',
        category: 'ALIMENTACAO',
        cents: 25000,
        averageCents: 10000,
        percent: 150,
      },
      { kind: 'category_down', category: 'LAZER', cents: 1000, averageCents: 10000, percent: 90 },
      { kind: 'quiet_days', days: 5 },
    ]);
  });

  it('semana parecida com a média e registros todo dia: nenhuma observação', () => {
    const days = ['28', '29', '30']
      .map((d) => `2026-09-${d}`)
      .concat(['01', '02', '03', '04'].map((d) => `2026-10-${d}`));
    // Mesma divisão das semanas anteriores: R$ 100 de Alimentação e ~R$ 100 de Lazer.
    const week = days.map((date) =>
      date.endsWith('28') ? tx(date, 10000) : tx(date, 1667, 'LAZER'),
    );

    expect(weeklyTips(summarizeWeek([...history, ...week], context, '2026-10-04'))).toEqual([]);
  });
});
