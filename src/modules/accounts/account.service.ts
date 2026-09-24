import type { AccountKind } from '../../generated/prisma/enums.js';
import type { TransactionRepository } from '../transactions/transaction.repository.js';
import { accountLabel, isVoucher, normalizeName } from './account-kinds.js';
import type { Account, AccountRepository } from './account.repository.js';
import { summarizeCredit, type CreditSummary } from './credit-invoice.js';
import type { InvoicePaymentRepository } from './invoice-payment.repository.js';

/** Opções do cadastro. "Conta + crédito" cria duas contas com o mesmo nome. */
export type NewAccountChoice = AccountKind | 'BANK_AND_CREDIT';

export const MAX_ACCOUNT_NAME_LENGTH = 30;

/** Erro de validação com mensagem pronta para o usuário. */
export class AccountError extends Error {
  override readonly name = 'AccountError';
}

export interface NewAccountOptions {
  /** VR/VA: saldo atual no momento do cadastro. */
  initialBalanceCents?: number;
  /** Crédito: limite e dia de fechamento (opcionais). */
  creditLimitCents?: number | null;
  closingDay?: number | null;
}

export interface CreditSettings {
  creditLimitCents: number | null;
  closingDay: number | null;
}

export class AccountService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly transactions: Pick<
      TransactionRepository,
      'sumByAccount' | 'listPurchasesByAccount'
    >,
    private readonly invoices: InvoicePaymentRepository,
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
    options: NewAccountOptions = {},
  ): Promise<Account[]> {
    const kinds: AccountKind[] = choice === 'BANK_AND_CREDIT' ? ['BANK', 'CREDIT_CARD'] : [choice];
    const name = await this.validName(rawName, kinds);

    return this.accounts.createMany(
      kinds.map((kind) => ({
        name,
        kind,
        initialBalanceCents: isVoucher(kind) ? (options.initialBalanceCents ?? 0) : 0,
        creditLimitCents: kind === 'CREDIT_CARD' ? (options.creditLimitCents ?? null) : null,
        closingDay: kind === 'CREDIT_CARD' ? (options.closingDay ?? null) : null,
      })),
    );
  }

  /** Renomeia só esta conta (no "Itaú" conta + crédito, a outra continua como está). */
  async rename(account: Account, rawName: string): Promise<void> {
    const name = await this.validName(rawName, [account.kind], account.id);
    await this.accounts.update(account.id, { name });
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
    await this.accounts.update(account.id, {
      initialBalanceCents: targetCents - (incomeCents - expenseCents),
    });
  }

  async configureCredit(account: Account, settings: CreditSettings): Promise<void> {
    await this.accounts.update(account.id, settings);
  }

  /** Fatura aberta e disponível; null se o dia de fechamento não foi informado. */
  async creditSummary(account: Account, today: string): Promise<CreditSummary | null> {
    if (account.kind !== 'CREDIT_CARD' || account.closingDay === null) return null;
    const [purchases, paidMonths] = await Promise.all([
      this.transactions.listPurchasesByAccount(account.id),
      this.invoices.listPaidMonths(account.id),
    ]);
    return summarizeCredit({
      purchases,
      closingDay: account.closingDay,
      limitCents: account.creditLimitCents,
      adjustmentCents: account.creditAdjustmentCents,
      paidMonths,
      today,
    });
  }

  /**
   * Faz o disponível bater com o do app do banco. O bot não conhece compras feitas antes
   * do cadastro; a diferença fica guardada como ajuste.
   */
  async adjustAvailable(account: Account, targetCents: number, today: string): Promise<void> {
    const summary = await this.creditSummary({ ...account, creditAdjustmentCents: 0 }, today);
    if (summary?.availableCents == null) {
      throw new AccountError('Informe o limite e o dia de fechamento antes de ajustar.');
    }
    await this.accounts.update(account.id, {
      creditAdjustmentCents: targetCents - summary.availableCents,
    });
  }

  markInvoicePaid(account: Account, invoiceMonth: string): Promise<void> {
    return this.invoices.markPaid(account.id, invoiceMonth);
  }

  /** Nome aparado, com tamanho válido e sem repetir outro ativo do mesmo tipo. */
  private async validName(
    rawName: string,
    kinds: AccountKind[],
    ignoreId?: number,
  ): Promise<string> {
    const name = rawName.trim().replace(/\s+/g, ' ');
    if (name.length === 0 || name.length > MAX_ACCOUNT_NAME_LENGTH) {
      throw new AccountError(`O nome precisa ter de 1 a ${MAX_ACCOUNT_NAME_LENGTH} caracteres.`);
    }
    const active = await this.accounts.listActive();
    for (const kind of kinds) {
      const duplicate = active.find(
        (account) =>
          account.id !== ignoreId &&
          account.kind === kind &&
          normalizeName(account.name) === normalizeName(name),
      );
      if (duplicate) {
        throw new AccountError(`Você já tem "${accountLabel(duplicate)}".`);
      }
    }
    return name;
  }
}
