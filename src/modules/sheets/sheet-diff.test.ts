import { describe, expect, it } from 'vitest';
import type { Account } from '../accounts/account.repository.js';
import type { Transaction } from '../transactions/transaction.repository.js';
import { buildSheetContent } from './sheet-content.js';
import { diffSheet, MASS_DELETE_THRESHOLD } from './sheet-diff.js';
import { fieldsOf, hashFields, parseRow, readRows } from './sheet-row.js';

const account = (overrides: Partial<Account>): Account => ({
  id: 1,
  name: 'Itaú',
  kind: 'BANK',
  initialBalanceCents: 0,
  creditLimitCents: null,
  closingDay: null,
  creditAdjustmentCents: 0,
  archivedAt: null,
  createdAt: new Date(),
  ...overrides,
});
const ACCOUNTS = [
  account({}),
  account({ id: 2, name: 'Itaú', kind: 'CREDIT_CARD' }),
  account({ id: 3, name: 'Santander', kind: 'CREDIT_CARD' }),
];

function tx(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    type: 'EXPENSE',
    amountCents: 3250,
    description: 'Almoço',
    category: 'ALIMENTACAO',
    paymentMethod: 'CREDITO',
    occurredAt: new Date('2026-09-24T00:00:00.000Z'),
    rawInput: 'x',
    source: 'TEXT',
    batchId: 'b',
    accountId: 2,
    installments: 3,
    createdAt: new Date(),
    ...overrides,
  };
}

/** As linhas exatamente como o bot as escreveu (valores crus, como a API devolve). */
function sheetRows(transactions: Transaction[]) {
  const content = buildSheetContent({
    today: '2026-09-24',
    updatedAt: '24/09/2026 10:00',
    transactions,
    accounts: ACCOUNTS,
    months: [],
    budgets: [],
    balances: [],
    cards: [],
    investments: [],
    netInvestedBefore: 0,
  });
  const values = content.data.find((r) => r.range === "'Lançamentos'!A1:K")?.values ?? [];
  return values.slice(1).map((row) => [...row]);
}

const snapshotsOf = (transactions: Transaction[]) =>
  new Map(transactions.map((t) => [t.id, hashFields(fieldsOf(t))]));

describe('ida e volta', () => {
  it('uma linha escrita pelo bot, relida, tem os mesmos campos (senão tudo pareceria editado)', () => {
    const transactions = [
      tx('a'),
      tx('b', {
        type: 'INCOME',
        category: 'SALARIO',
        paymentMethod: null,
        accountId: 1,
        installments: 1,
      }),
      tx('c', {
        type: 'INVESTMENT',
        category: 'INVESTIMENTO',
        description: 'Tesouro Selic',
        paymentMethod: null,
        accountId: null,
        installments: 1,
      }),
    ];
    const rows = sheetRows(transactions);

    for (const [index, transaction] of transactions.entries()) {
      expect(parseRow(rows[index] ?? [], ACCOUNTS)).toEqual({
        ok: true,
        fields: fieldsOf(transaction),
      });
    }
    expect(
      diffSheet({
        rows: readRows(rows),
        transactions,
        snapshots: snapshotsOf(transactions),
        accounts: ACCOUNTS,
      }),
    ).toEqual([]);
  });
});

describe('diffSheet', () => {
  const base = [tx('a'), tx('b', { description: 'Uber', category: 'TRANSPORTE' })];

  it('valor editado na planilha vira "update"', () => {
    const rows = sheetRows(base);
    rows[0]![5] = 35; // Valor
    rows[0]![4] = 'mercado'; // Categoria, sem acento/maiúscula

    const [change] = diffSheet({
      rows: readRows(rows),
      transactions: base,
      snapshots: snapshotsOf(base),
      accounts: ACCOUNTS,
    });

    expect(change).toMatchObject({
      kind: 'update',
      fields: { amountCents: 3500, category: 'MERCADO' },
    });
  });

  it('linha nova sem ID vira "create"; com erro, vira "invalid" e não é perdida', () => {
    const rows = sheetRows(base);
    rows.push([
      '',
      '20/09/2026',
      'Receita',
      'Venda do monitor',
      'Outras receitas',
      '450,00',
      '',
      'Pix',
      'Itaú (conta)',
      '',
      '',
    ]);
    rows.push(['', '20/09/2026', 'Despesa', 'Presente', 'Comida', 80, '', '', '', '', '']);

    const changes = diffSheet({
      rows: readRows(rows),
      transactions: base,
      snapshots: snapshotsOf(base),
      accounts: ACCOUNTS,
    });

    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'create',
        fields: expect.objectContaining({
          type: 'INCOME',
          amountCents: 45000,
          accountId: 1,
          occurredAt: '2026-09-20',
        }),
      }),
      expect.objectContaining({ kind: 'invalid', error: 'Categoria "Comida" não existe.' }),
    ]);
  });

  it('linha apagada vira "delete"', () => {
    const rows = sheetRows(base).slice(1);

    const changes = diffSheet({
      rows: readRows(rows),
      transactions: base,
      snapshots: snapshotsOf(base),
      accounts: ACCOUNTS,
    });

    expect(changes).toEqual([{ kind: 'delete', transaction: base[0] }]);
  });

  it(`mais de ${MASS_DELETE_THRESHOLD} linhas sumindo de uma vez não apaga nada sem confirmar`, () => {
    const many = Array.from({ length: MASS_DELETE_THRESHOLD + 1 }, (_, i) => tx(`t${i}`));

    const changes = diffSheet({
      rows: [],
      transactions: many,
      snapshots: snapshotsOf(many),
      accounts: ACCOUNTS,
    });

    expect(changes).toEqual([{ kind: 'mass_delete', transactions: many }]);
  });

  it('mudou no bot e na planilha ao mesmo tempo: "conflict"', () => {
    const rows = sheetRows(base);
    rows[0]![3] = 'Almoço editado na planilha';
    const changedInBot = [{ ...base[0]!, amountCents: 9999 }, base[1]!];

    const [change] = diffSheet({
      rows: readRows(rows),
      transactions: changedInBot,
      snapshots: snapshotsOf(base),
      accounts: ACCOUNTS,
    });

    expect(change).toMatchObject({ kind: 'conflict' });
  });

  it('mudou só no bot: nada a aplicar (a escrita do bot atualiza a linha)', () => {
    const rows = sheetRows(base);
    const changedInBot = [{ ...base[0]!, amountCents: 9999 }, base[1]!];

    expect(
      diffSheet({
        rows: readRows(rows),
        transactions: changedInBot,
        snapshots: snapshotsOf(base),
        accounts: ACCOUNTS,
      }),
    ).toEqual([]);
  });

  it.each([
    [1, 'Data inválida (use dd/mm/aaaa).', '31/02/2026'],
    [2, 'Tipo inválido. Use: Despesa, Receita, Aporte, Resgate.', 'Gasto'],
    [5, 'Valor inválido (use um número maior que zero).', -10],
    [6, 'Parcelas deve ser um número de 1 a 48.', 0],
    [8, 'Santander (crédito) não combina com a forma Pix.', 'Santander'],
  ])('coluna %i inválida: %s', (column, error, value) => {
    const rows = sheetRows(base);
    rows[0]![column] = value;
    if (column === 8) rows[0]![7] = 'Pix';

    const [change] = diffSheet({
      rows: readRows(rows),
      transactions: base,
      snapshots: snapshotsOf(base),
      accounts: ACCOUNTS,
    });

    expect(change).toMatchObject({ kind: 'invalid', error });
  });
});
