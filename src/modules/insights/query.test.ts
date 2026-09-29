import { describe, expect, it } from 'vitest';
import type { Query } from '../../ai/parse-result.schema.js';
import type { ReportTransaction } from '../reports/monthly-report.js';
import { answerQuery, type ComputableQuery, type QueryAccount } from './query.js';

const ACCOUNTS: QueryAccount[] = [
  { id: 1, name: 'Itaú', kind: 'BANK' },
  { id: 2, name: 'Itaú', kind: 'CREDIT_CARD' },
  { id: 3, name: 'VR', kind: 'MEAL_VOUCHER' },
];

function tx(overrides: Partial<ReportTransaction>): ReportTransaction {
  return {
    type: 'EXPENSE',
    amountCents: 1000,
    category: 'TRANSPORTE',
    description: 'Uber',
    paymentMethod: 'PIX',
    accountId: 1,
    installments: 1,
    occurredAt: new Date('2026-09-10T00:00:00.000Z'),
    ...overrides,
  };
}

function query(overrides: Partial<Query>): ComputableQuery {
  return {
    kind: 'total',
    type: null,
    categories: [],
    text: null,
    account: null,
    paymentMethod: null,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    compareStart: null,
    compareEnd: null,
    rankBy: null,
    sort: null,
    limit: null,
    amountCents: null,
    ...overrides,
  } as ComputableQuery;
}

const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('answerQuery: total', () => {
  const data = [
    tx({ description: 'Uber' }),
    tx({ description: 'UBER Eats', category: 'ALIMENTACAO', amountCents: 3000 }),
    tx({ description: 'Ônibus', amountCents: 500 }),
    tx({ description: 'Uber', occurredAt: date('2026-08-31') }),
    tx({ type: 'INCOME', category: 'SALARIO', description: 'Salário', amountCents: 500000 }),
  ];

  it('filtra por texto sem acento nem maiúsculas, só no período e só despesas', () => {
    expect(answerQuery(query({ text: 'uber' }), data, ACCOUNTS)).toMatchObject({
      kind: 'total',
      totalCents: 4000,
      count: 2,
    });
    expect(answerQuery(query({ text: 'onibus' }), data, ACCOUNTS)).toMatchObject({
      totalCents: 500,
    });
  });

  it('nome específico vale mais que a categoria que vier junto', () => {
    expect(
      answerQuery(query({ text: 'uber', categories: ['TRANSPORTE'] }), data, ACCOUNTS),
    ).toMatchObject({ totalCents: 4000, count: 2 });
  });

  it('por categoria e por tipo', () => {
    expect(answerQuery(query({ categories: ['TRANSPORTE'] }), data, ACCOUNTS)).toMatchObject({
      totalCents: 1500,
      count: 2,
    });
    expect(answerQuery(query({ type: 'INCOME' }), data, ACCOUNTS)).toMatchObject({
      totalCents: 500000,
    });
  });

  it('parcelado conta só a parcela de cada mês, como no /resumo', () => {
    const purchase = tx({
      description: 'Tênis',
      category: 'COMPRAS',
      amountCents: 30000,
      installments: 3,
      occurredAt: date('2026-08-31'),
      paymentMethod: 'CREDITO',
      accountId: 2,
    });
    const september = answerQuery(query({ text: 'tenis' }), [purchase], ACCOUNTS);
    const quarter = answerQuery(
      query({ text: 'tenis', periodStart: '2026-08-01', periodEnd: '2026-10-31' }),
      [purchase],
      ACCOUNTS,
    );

    expect(september).toMatchObject({ totalCents: 10000, count: 1 });
    expect(quarter).toMatchObject({ totalCents: 30000, count: 1 });
  });

  it('cartão citado: só os lançamentos dele; cartão inexistente: nada', () => {
    const data2 = [
      tx({ accountId: 2, paymentMethod: 'CREDITO', amountCents: 7000 }),
      tx({ accountId: 1, amountCents: 2000 }),
      tx({ accountId: 3, paymentMethod: 'VR', category: 'ALIMENTACAO', amountCents: 3500 }),
    ];

    expect(
      answerQuery(query({ account: 'itau', paymentMethod: 'CREDITO' }), data2, ACCOUNTS),
    ).toMatchObject({ totalCents: 7000 });
    expect(answerQuery(query({ account: 'Itaú' }), data2, ACCOUNTS)).toMatchObject({
      totalCents: 9000,
    });
    // VR conta como gasto de verdade.
    expect(answerQuery(query({ account: 'VR' }), data2, ACCOUNTS)).toMatchObject({
      totalCents: 3500,
    });
    expect(answerQuery(query({ account: 'Nubank' }), data2, ACCOUNTS)).toMatchObject({
      totalCents: 0,
      count: 0,
    });
  });
});

describe('answerQuery: compare, ranking e list', () => {
  const data = [
    tx({ category: 'ALIMENTACAO', description: 'iFood', amountCents: 4000 }),
    tx({
      category: 'ALIMENTACAO',
      description: 'iFood',
      amountCents: 6000,
      occurredAt: date('2026-09-20'),
    }),
    tx({
      category: 'ALIMENTACAO',
      description: 'iFood',
      amountCents: 8000,
      occurredAt: date('2026-08-05'),
    }),
    tx({
      category: 'LAZER',
      description: 'Cinema',
      amountCents: 5000,
      occurredAt: date('2026-07-15'),
    }),
  ];

  it('compare: os dois totais', () => {
    const answer = answerQuery(
      query({
        kind: 'compare',
        categories: ['ALIMENTACAO'],
        compareStart: '2026-08-01',
        compareEnd: '2026-08-31',
      }),
      data,
      ACCOUNTS,
    );

    expect(answer).toMatchObject({
      kind: 'compare',
      current: { totalCents: 10000, count: 2 },
      other: { totalCents: 8000, count: 1 },
    });
  });

  it('ranking por mês e por categoria, do maior para o menor', () => {
    const byMonth = answerQuery(
      query({ kind: 'ranking', rankBy: 'month', periodStart: '2026-07-01' }),
      data,
      ACCOUNTS,
    );
    const byCategory = answerQuery(
      query({ kind: 'ranking', rankBy: 'category', periodStart: '2026-07-01' }),
      data,
      ACCOUNTS,
    );

    expect(byMonth).toMatchObject({
      rows: [
        { key: '2026-09', cents: 10000 },
        { key: '2026-08', cents: 8000 },
        { key: '2026-07', cents: 5000 },
      ],
    });
    expect(byCategory).toMatchObject({
      rows: [
        { key: 'ALIMENTACAO', cents: 18000 },
        { key: 'LAZER', cents: 5000 },
      ],
    });
  });

  it('list: maior gasto do período, e os mais recentes com o total de encontrados', () => {
    const largest = answerQuery(
      query({ kind: 'list', sort: 'largest', limit: 1, periodStart: '2026-07-01' }),
      data,
      ACCOUNTS,
    );
    const recent = answerQuery(
      query({ kind: 'list', sort: 'recent', limit: 2, text: 'ifood', periodStart: '2026-07-01' }),
      data,
      ACCOUNTS,
    );

    expect(largest).toMatchObject({
      matches: 4,
      items: [{ description: 'iFood', amountCents: 8000 }],
    });
    expect(recent).toMatchObject({
      matches: 3,
      items: [
        { date: '2026-09-20', amountCents: 6000 },
        { date: '2026-09-10', amountCents: 4000 },
      ],
    });
  });

  it('período sem nada: listas vazias', () => {
    const empty = query({ periodStart: '2025-01-01', periodEnd: '2025-01-31' });
    expect(answerQuery({ ...empty, kind: 'list' }, data, ACCOUNTS)).toMatchObject({
      matches: 0,
      items: [],
    });
    expect(answerQuery({ ...empty, kind: 'ranking' }, data, ACCOUNTS)).toMatchObject({ rows: [] });
  });
});
