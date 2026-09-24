import { describe, expect, it } from 'vitest';
import {
  InMemoryAccountRepository,
  InMemoryInvoicePaymentRepository,
} from '../../test/in-memory-repositories.js';
import { InMemoryTransactionRepository } from '../../test/in-memory-transaction-repository.js';
import { AccountError, AccountService } from './account.service.js';

function setup() {
  const accounts = new InMemoryAccountRepository();
  const transactions = new InMemoryTransactionRepository();
  const invoices = new InMemoryInvoicePaymentRepository();
  return {
    accounts,
    transactions,
    service: new AccountService(accounts, transactions, invoices),
  };
}

async function addTransaction(
  transactions: InMemoryTransactionRepository,
  accountId: number,
  type: 'INCOME' | 'EXPENSE',
  amountCents: number,
) {
  await transactions.createBatch('batch', [
    {
      type,
      amountCents,
      description: 'x',
      category: type === 'INCOME' ? 'VALE_ALIMENTACAO' : 'MERCADO',
      paymentMethod: 'VA',
      occurredAt: new Date(),
      rawInput: 'x',
      source: 'TEXT',
      accountId,
      installments: 1,
    },
  ]);
}

describe('AccountService', () => {
  it('"Conta + crédito" cria duas contas com o mesmo nome', async () => {
    const { service } = setup();

    const created = await service.create('BANK_AND_CREDIT', '  Itaú  ');

    expect(created.map((a) => [a.name, a.kind])).toEqual([
      ['Itaú', 'BANK'],
      ['Itaú', 'CREDIT_CARD'],
    ]);
  });

  it('recusa nome repetido no mesmo tipo, ignorando acento e maiúsculas', async () => {
    const { service } = setup();
    await service.create('CREDIT_CARD', 'Itaú');

    await expect(service.create('CREDIT_CARD', 'itau')).rejects.toThrow(AccountError);
    // Mesmo nome em outro tipo pode.
    await expect(service.create('BANK', 'Itaú')).resolves.toHaveLength(1);
  });

  it('recusa nome vazio ou longo demais', async () => {
    const { service } = setup();

    await expect(service.create('BANK', '   ')).rejects.toThrow(AccountError);
    await expect(service.create('BANK', 'x'.repeat(31))).rejects.toThrow(AccountError);
  });

  it('nome repetido volta a ser permitido depois de remover o antigo', async () => {
    const { service } = setup();
    const [santander] = await service.create('CREDIT_CARD', 'Santander');
    await service.archive(santander?.id ?? 0);

    await expect(service.create('CREDIT_CARD', 'Santander')).resolves.toHaveLength(1);
    expect(await service.listActive()).toHaveLength(1);
    expect(await service.listAll()).toHaveLength(2);
  });

  describe('saldo de vale', () => {
    it('saldo = inicial + recargas - gastos', async () => {
      const { service, transactions } = setup();
      const [va] = await service.create('FOOD_VOUCHER', 'VA', { initialBalanceCents: 10000 });
      if (!va) throw new Error('VA não criado');

      await addTransaction(transactions, va.id, 'INCOME', 60000);
      await addTransaction(transactions, va.id, 'EXPENSE', 8000);

      expect(await service.balance(va)).toBe(62000);
    });

    it('ajustar faz o saldo calculado bater com o valor informado', async () => {
      const { service, transactions, accounts } = setup();
      const [va] = await service.create('FOOD_VOUCHER', 'VA', { initialBalanceCents: 0 });
      if (!va) throw new Error('VA não criado');
      await addTransaction(transactions, va.id, 'INCOME', 60000);
      await addTransaction(transactions, va.id, 'EXPENSE', 8000);

      await service.adjustBalance(va, 50000);

      const [updated] = await accounts.listActive();
      if (!updated) throw new Error('VA sumiu');
      expect(await service.balance(updated)).toBe(50000);
    });

    it('saldo inicial só vale para vales', async () => {
      const { service } = setup();

      const [credito] = await service.create('CREDIT_CARD', 'Santander', {
        initialBalanceCents: 99999,
      });

      expect(credito?.initialBalanceCents).toBe(0);
    });
  });
});
