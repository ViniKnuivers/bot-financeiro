import type { AccountKind } from '../../generated/prisma/enums.js';
import type { TransactionRepository } from '../transactions/transaction.repository.js';
import { accountLabel, isVoucher, normalizeName } from './account-kinds.js';
import type { Account, AccountRepository } from './account.repository.js';

/** Opções do cadastro. "Conta + crédito" cria duas contas com o mesmo nome. */
export type NewAccountChoice = AccountKind | 'BANK_AND_CREDIT';

export const MAX_ACCOUNT_NAME_LENGTH = 30;

/** Erro de validação com mensagem pronta para o usuário. */
export class AccountError extends Error {
  override readonly name = 'AccountError';
}

export class AccountService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly transactions: Pick<TransactionRepository, 'sumByAccount'>,
  ) {}

  listActive(): Promise<Account[]> {
    return this.accounts.listActive();
  }

  listAll(): Promise<Account[]> {
    return this.accounts.listAll();
  }

  async findActive(id: number): Promise<Account | null> {
    const active = await this.accounts.listActive();
    return active.find((account) => account.id === id) ?? null;
  }

  async create(
    choice: NewAccountChoice,
    rawName: string,
    initialBalanceCents = 0,
  ): Promise<Account[]> {
    const name = rawName.trim().replace(/\s+/g, ' ');
    if (name.length === 0 || name.length > MAX_ACCOUNT_NAME_LENGTH) {
      throw new AccountError(`O nome precisa ter de 1 a ${MAX_ACCOUNT_NAME_LENGTH} caracteres.`);
    }

    const kinds: AccountKind[] = choice === 'BANK_AND_CREDIT' ? ['BANK', 'CREDIT_CARD'] : [choice];
    const active = await this.accounts.listActive();
    for (const kind of kinds) {
      const duplicate = active.find(
        (account) => account.kind === kind && normalizeName(account.name) === normalizeName(name),
      );
      if (duplicate) {
        throw new AccountError(`Você já tem "${accountLabel(duplicate)}".`);
      }
    }

    return this.accounts.createMany(
      kinds.map((kind) => ({
        name,
        kind,
        initialBalanceCents: isVoucher(kind) ? initialBalanceCents : 0,
      })),
    );
  }

  archive(id: number): Promise<void> {
    return this.accounts.archive(id);
  }

  /**
   * Saldo de um vale (VR/VA): inicial + tudo que entrou - tudo que saiu.
   * Calculado na hora, então desfazer um lançamento já corrige o saldo.
   */
  async balance(account: Account): Promise<number> {
    const { incomeCents, expenseCents } = await this.transactions.sumByAccount(account.id);
    return account.initialBalanceCents + incomeCents - expenseCents;
  }

  /** Faz o saldo calculado bater com o valor real (ex.: o que o app do VA mostra). */
  async adjustBalance(account: Account, targetCents: number): Promise<void> {
    const { incomeCents, expenseCents } = await this.transactions.sumByAccount(account.id);
    await this.accounts.setInitialBalance(account.id, targetCents - (incomeCents - expenseCents));
  }
}
