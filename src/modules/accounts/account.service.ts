import type { AccountKind } from '../../generated/prisma/enums.js';
import type { TransactionRepository } from '../transactions/transaction.repository.js';
import { accountLabel, isVoucher, normalizeName } from './account-kinds.js';
import type { Account, AccountRepository } from './account.repository.js';
import { invoiceTotalsByMonth, summarizeCredit, type CreditSummary } from './credit-invoice.js';
import type { InvoicePaymentRepository } from './invoice-payment.repository.js';

/** Contas com saldo acompanhado: conta bancária e vales. */
export function hasBalance(kind: AccountKind): boolean {
  return kind === 'BANK' || isVoucher(kind);
}

/** Opções do cadastro. "Conta + crédito" cria duas contas com o mesmo nome. */
export type NewAccountChoice = AccountKind | 'BANK_AND_CREDIT';

export const MAX_ACCOUNT_NAME_LENGTH = 30;

/** Erro de validação com mensagem pronta para o usuário. */
export class AccountError extends Error {
  override readonly name = 'AccountError';
}

export interface NewAccountOptions {
  /** Conta bancária e VR/VA: saldo atual no momento do cadastro. */
  initialBalanceCents?: number;
  /** Crédito: limite, dia de fechamento e dia de vencimento (opcionais). */
  creditLimitCents?: number | null;
  closingDay?: number | null;
  dueDay?: number | null;
}

export interface CreditSettings {
  creditLimitCents: number | null;
  closingDay: number | null;
  dueDay: number | null;
}

export interface InvoiceStatus {
  cents: number;
  paid: boolean;
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
        initialBalanceCents: hasBalance(kind) ? (options.initialBalanceCents ?? 0) : 0,
        creditLimitCents: kind === 'CREDIT_CARD' ? (options.creditLimitCents ?? null) : null,
        closingDay: kind === 'CREDIT_CARD' ? (options.closingDay ?? null) : null,
        dueDay: kind === 'CREDIT_CARD' ? (options.dueDay ?? null) : null,
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
   * Saldo de uma conta bancária ou de um vale: inicial + movimentações.
   * Calculado na hora, então desfazer um lançamento já corrige o saldo.
   */
  async balance(account: Account): Promise<number> {
    return account.initialBalanceCents + (await this.movements(account));
  }

  /** Faz o saldo calculado bater com o valor real (ex.: o que o app do banco mostra). */
  async adjustBalance(account: Account, targetCents: number): Promise<void> {
    await this.accounts.update(account.id, {
      initialBalanceCents: targetCents - (await this.movements(account)),
    });
  }

  /**
   * Quanto entrou menos quanto saiu desde o cadastro.
   * Conta: + receitas + resgates − despesas (débito/pix) − aportes − faturas pagas por ela.
   * Vale: + recargas − gastos.
   */
  private async movements(account: Account): Promise<number> {
    const totals = await this.transactions.sumByAccount(account.id);
    const base = totals.INCOME - totals.EXPENSE;
    if (account.kind !== 'BANK') return base;
    const invoicesPaid = await this.invoices.sumPaidFrom(account.id);
    return base + totals.REDEMPTION - totals.INVESTMENT - invoicesPaid;
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

  /** Valor de uma fatura (com as parcelas que caem nela) e se já foi marcada como paga. */
  async invoiceStatus(card: Account, invoiceMonth: string): Promise<InvoiceStatus> {
    if (card.closingDay === null) return { cents: 0, paid: false };
    const [purchases, paidMonths] = await Promise.all([
      this.transactions.listPurchasesByAccount(card.id),
      this.invoices.listPaidMonths(card.id),
    ]);
    return {
      cents: invoiceTotalsByMonth(purchases, card.closingDay).get(invoiceMonth) ?? 0,
      paid: paidMonths.includes(invoiceMonth),
    };
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

  /**
   * Marca a fatura como paga (libera o limite) e guarda o valor e a conta de onde saiu o
   * dinheiro, que passa a descontar do saldo dela.
   */
  async markInvoicePaid(
    card: Account,
    invoiceMonth: string,
    paidFromAccountId: number | null,
  ): Promise<void> {
    const purchases = await this.transactions.listPurchasesByAccount(card.id);
    const totals =
      card.closingDay === null
        ? new Map<string, number>()
        : invoiceTotalsByMonth(purchases, card.closingDay);
    await this.invoices.markPaid({
      accountId: card.id,
      invoiceMonth,
      amountCents: totals.get(invoiceMonth) ?? 0,
      paidFromAccountId,
    });
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
