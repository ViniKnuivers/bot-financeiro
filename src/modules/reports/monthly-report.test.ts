import { describe, expect, it } from 'vitest';
import {
  canonicalDestination,
  investmentsByDestination,
  lastMonths,
  monthlyShares,
  summarizeMonths,
  type ReportTransaction,
} from './monthly-report.js';

const VA_ID = 5;
const context = { voucherAccountIds: new Set([VA_ID]) };

function tx(overrides: Partial<ReportTransaction>): ReportTransaction {
  return {
    type: 'EXPENSE',
    amountCents: 1000,
    category: 'ALIMENTACAO',
    description: 'x',
    paymentMethod: 'PIX',
    accountId: 1,
    installments: 1,
    occurredAt: new Date('2026-09-10T00:00:00.000Z'),
    ...overrides,
  };
}

const at = (date: string) => new Date(`${date}T00:00:00.000Z`);

describe('monthlyShares', () => {
  it('parcelado: 1ª parcela no mês da compra, as seguintes nos meses seguintes', () => {
    expect(
      monthlyShares(tx({ amountCents: 10000, installments: 3, occurredAt: at('2026-11-20') })),
    ).toEqual([
      { month: '2026-11', cents: 3334 },
      { month: '2026-12', cents: 3333 },
      { month: '2027-01', cents: 3333 },
    ]);
  });

  it('à vista conta inteiro no mês', () => {
    expect(monthlyShares(tx({ amountCents: 5000 }))).toEqual([{ month: '2026-09', cents: 5000 }]);
  });
});

describe('summarizeMonths', () => {
  it('sobra = receitas + resgates − despesas, sem VR/VA; livre = sobra − aportes', () => {
    const [september] = summarizeMonths(
      [
        tx({ type: 'INCOME', category: 'SALARIO', amountCents: 375000, paymentMethod: null }),
        tx({
          type: 'INCOME',
          category: 'VALE_ALIMENTACAO',
          amountCents: 60000,
          paymentMethod: 'VA',
          accountId: VA_ID,
        }),
        tx({ amountCents: 120000, category: 'MORADIA' }),
        tx({ amountCents: 8000, category: 'MERCADO', paymentMethod: 'VA', accountId: VA_ID }),
        tx({
          type: 'INVESTMENT',
          category: 'INVESTIMENTO',
          amountCents: 100000,
          paymentMethod: null,
        }),
        tx({
          type: 'REDEMPTION',
          category: 'INVESTIMENTO',
          amountCents: 20000,
          paymentMethod: null,
        }),
      ],
      context,
      ['2026-09'],
    );

    expect(september).toMatchObject({
      incomeCents: 375000,
      expenseCents: 120000,
      voucherIncomeCents: 60000,
      voucherExpenseCents: 8000,
      // 3.750 + 200 de resgate − 1.200.
      surplusCents: 275000,
      investedCents: 100000,
      redeemedCents: 20000,
      netInvestedCents: 80000,
      freeCents: 175000,
    });
    // Gasto no VA entra nas categorias (é gasto de verdade), só não na sobra.
    expect(september?.byCategory).toEqual([
      { category: 'MORADIA', cents: 120000 },
      { category: 'MERCADO', cents: 8000 },
    ]);
  });

  it('parcelas se espalham pelos meses e atravessam o ano', () => {
    const months = summarizeMonths(
      [
        tx({
          amountCents: 30000,
          installments: 3,
          occurredAt: at('2026-12-15'),
          paymentMethod: 'CREDITO',
        }),
      ],
      context,
      ['2026-12', '2027-01', '2027-02', '2027-03'],
    );

    expect(months.map((m) => m.expenseCents)).toEqual([10000, 10000, 10000, 0]);
  });

  it('meses sem movimento aparecem zerados', () => {
    expect(summarizeMonths([], context, lastMonths('2026-09', 3)).map((m) => m.month)).toEqual([
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
  });
});

describe('investmentsByDestination', () => {
  it('agrupa por destino sem diferenciar maiúsculas e acentos', () => {
    expect(
      investmentsByDestination([
        tx({
          type: 'INVESTMENT',
          category: 'INVESTIMENTO',
          description: 'Tesouro Selic',
          amountCents: 50000,
        }),
        tx({
          type: 'INVESTMENT',
          category: 'INVESTIMENTO',
          description: 'tesouro selic',
          amountCents: 30000,
        }),
        tx({
          type: 'REDEMPTION',
          category: 'INVESTIMENTO',
          description: 'Tesouro Selic',
          amountCents: 10000,
        }),
        tx({
          type: 'INVESTMENT',
          category: 'INVESTIMENTO',
          description: 'Caixinha',
          amountCents: 20000,
        }),
        tx({ amountCents: 999 }),
      ]),
    ).toEqual([
      {
        destination: 'Tesouro Selic',
        investedCents: 80000,
        redeemedCents: 10000,
        balanceCents: 70000,
      },
      { destination: 'Caixinha', investedCents: 20000, redeemedCents: 0, balanceCents: 20000 },
    ]);
  });
});

describe('canonicalDestination', () => {
  const known = ['Tesouro Selic', 'Caixinha Nubank', 'CDB Inter', 'CDB Itaú'];

  it.each([
    ['Caixinha', 'Caixinha Nubank'],
    ['caixinha nubank', 'Caixinha Nubank'],
    ['tesouro', 'Tesouro Selic'],
    ['CDB', 'CDB'],
    ['Ações', 'Ações'],
    ['Caixa', 'Caixa'],
  ])('"%s" → "%s"', (name, expected) => {
    expect(canonicalDestination(name, known)).toBe(expected);
  });
});
