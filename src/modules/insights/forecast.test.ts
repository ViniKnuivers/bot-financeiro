import { describe, expect, it } from 'vitest';
import type { ReportTransaction } from '../reports/monthly-report.js';
import {
  forecastBreakdown,
  forecastMonth,
  forecastSentence,
  type ForecastRecurring,
} from './forecast.js';

const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function tx(overrides: Partial<ReportTransaction>): ReportTransaction {
  return {
    type: 'EXPENSE',
    amountCents: 1000,
    category: 'ALIMENTACAO',
    description: 'Almoço',
    paymentMethod: 'PIX',
    accountId: 1,
    installments: 1,
    occurredAt: date('2026-10-05'),
    source: 'TEXT',
    ...overrides,
  };
}

function fixed(overrides: Partial<ForecastRecurring>): ForecastRecurring {
  return {
    type: 'EXPENSE',
    amountCents: 120000,
    category: 'MORADIA',
    paymentMethod: 'PIX',
    accountId: 1,
    active: true,
    lastRunMonth: null,
    ...overrides,
  };
}

const NO_VOUCHERS = new Set<number>();

describe('forecastMonth', () => {
  it('com 3 meses de histórico: média diária do dia a dia × dias que faltam', () => {
    // Jul+Ago+Set = 92 dias, R$ 920 de gasto variável → R$ 10/dia. Hoje é 10/10: faltam 21 dias.
    const history = [
      tx({ occurredAt: date('2026-07-01'), amountCents: 30000 }),
      tx({ occurredAt: date('2026-08-15'), amountCents: 32000 }),
      tx({ occurredAt: date('2026-09-20'), amountCents: 30000 }),
      // Fixo lançado automaticamente não entra no dia a dia.
      tx({ occurredAt: date('2026-09-05'), amountCents: 120000, source: 'RECURRING' }),
    ];
    const thisMonth = [
      tx({
        type: 'INCOME',
        category: 'SALARIO',
        amountCents: 500000,
        occurredAt: date('2026-10-05'),
      }),
      tx({ amountCents: 20000, occurredAt: date('2026-10-08') }),
    ];

    const forecast = forecastMonth({
      today: '2026-10-10',
      transactions: [...history, ...thisMonth],
      recurring: [fixed({})],
      voucherAccountIds: NO_VOUCHERS,
    });

    expect(forecast).toMatchObject({
      month: '2026-10',
      endDate: '2026-10-31',
      basis: 'history',
      soFarIncomeCents: 500000,
      soFarExpenseCents: 20000,
      fixedExpenseCents: 120000,
      variableCents: 21000,
      // 5.000 − (200 + 1.200 + 210) = 3.390
      surplusCents: 339000,
    });
  });

  it('fixo já lançado neste mês não entra de novo; pausado e de vale também não', () => {
    const forecast = forecastMonth({
      today: '2026-10-10',
      transactions: [tx({ occurredAt: date('2026-06-01'), amountCents: 0 })],
      recurring: [
        fixed({ lastRunMonth: '2026-10' }),
        fixed({ active: false }),
        fixed({ paymentMethod: 'VA', category: 'MERCADO' }),
        fixed({ type: 'INCOME', category: 'SALARIO', amountCents: 400000 }),
      ],
      voucherAccountIds: NO_VOUCHERS,
    });

    expect(forecast.fixedExpenseCents).toBe(0);
    expect(forecast.fixedIncomeCents).toBe(400000);
  });

  it('sem histórico e antes do dia 7: sem previsão ("early"), em vez de multiplicar 1 dia por 30', () => {
    // O caso real de 01/10: R$ 1.490 gastos no dia 1 não querem dizer R$ 45 mil no mês.
    const forecast = forecastMonth({
      today: '2026-10-01',
      transactions: [
        tx({
          amountCents: 359600,
          type: 'INCOME',
          category: 'SALARIO',
          occurredAt: date('2026-10-01'),
        }),
        tx({ amountCents: 149000, occurredAt: date('2026-10-01') }),
      ],
      recurring: [],
      voucherAccountIds: NO_VOUCHERS,
    });

    expect(forecast).toMatchObject({ basis: 'early', variableCents: 0, surplusCents: 210600 });
    expect(forecastSentence(forecast)).toBe(
      '🔮 Previsão para 31/10: aparece a partir do dia 7, quando houver alguns dias de lançamentos.',
    );
  });

  it('sem histórico: usa o ritmo deste mês até hoje; sem nada: base "none"', () => {
    const pace = forecastMonth({
      today: '2026-10-10',
      transactions: [tx({ amountCents: 10000, occurredAt: date('2026-10-02') })],
      recurring: [],
      voucherAccountIds: NO_VOUCHERS,
    });
    const empty = forecastMonth({
      today: '2026-10-10',
      transactions: [],
      recurring: [],
      voucherAccountIds: NO_VOUCHERS,
    });

    // R$ 100 em 10 dias = R$ 10/dia × 21 dias.
    expect(pace).toMatchObject({ basis: 'month', variableCents: 21000 });
    expect(empty).toMatchObject({ basis: 'none', variableCents: 0, surplusCents: 0 });
  });

  it('gasto com VR/VA fica fora (como no /resumo)', () => {
    const forecast = forecastMonth({
      today: '2026-10-10',
      transactions: [tx({ paymentMethod: 'VR', accountId: 3, amountCents: 5000 })],
      recurring: [],
      voucherAccountIds: new Set([3]),
    });

    expect(forecast).toMatchObject({ soFarExpenseCents: 0, variableCents: 0 });
  });
});

/** O Intl usa espaço não separável depois de "R$"; nos testes, espaço comum. */
const plain = (text: string) => text.replace(/\u00a0/g, ' ');

describe('forecastSentence', () => {
  const base = forecastMonth({
    today: '2026-10-10',
    transactions: [tx({ type: 'INCOME', category: 'SALARIO', amountCents: 100000 })],
    recurring: [],
    voucherAccountIds: NO_VOUCHERS,
  });

  it('sobra positiva com 🔮; negativa começa com ⚠️ (é o que pinta o Painel de vermelho)', () => {
    expect(plain(forecastSentence(base))).toBe(
      '🔮 Previsão para 31/10: sobra de R$ 1.000,00 (no ritmo atual)',
    );
    expect(plain(forecastSentence({ ...base, surplusCents: -30000 }))).toBe(
      '⚠️ Previsão para 31/10: o mês fecha no vermelho em R$ 300,00 (no ritmo atual)',
    );
  });

  it('detalha de onde vêm os gastos previstos', () => {
    const detailed = {
      ...base,
      soFarExpenseCents: 80000,
      fixedExpenseCents: 120000,
      variableCents: 45000,
    };
    expect(plain(forecastBreakdown(detailed))).toBe(
      '   gastos: R$ 800,00 já foram + R$ 1.200,00 de fixos + R$ 450,00 do dia a dia',
    );
  });
});
