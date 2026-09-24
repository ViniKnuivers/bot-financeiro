import { toDateOnlyString } from '../../lib/dates.js';
import { isVoucher } from '../accounts/account-kinds.js';
import type { Account } from '../accounts/account.repository.js';
import { hasBalance, type AccountService } from '../accounts/account.service.js';
import type { TransactionRepository } from '../transactions/transaction.repository.js';
import {
  investmentsByDestination,
  lastMonths,
  summarizeMonths,
  type InvestmentPosition,
  type MonthSummary,
} from './monthly-report.js';

export interface AccountBalance {
  account: Account;
  cents: number;
}

/** Relatórios prontos a partir do banco: a fonte única do /resumo, da planilha e do dia 1. */
export class ReportService {
  constructor(
    private readonly transactions: Pick<TransactionRepository, 'listForReports'>,
    private readonly accounts: AccountService,
  ) {}

  /** Resumo dos meses pedidos, na mesma ordem. */
  async months(months: readonly string[]): Promise<MonthSummary[]> {
    const [transactions, accounts] = await Promise.all([
      this.transactions.listForReports(),
      this.accounts.listAll(),
    ]);
    const voucherAccountIds = new Set(accounts.filter((a) => isVoucher(a.kind)).map((a) => a.id));
    return summarizeMonths(transactions, { voucherAccountIds }, months);
  }

  async month(month: string): Promise<MonthSummary> {
    const [summary] = await this.months([month]);
    if (!summary) throw new Error(`resumo de ${month} não calculado`);
    return summary;
  }

  /** Os `count` meses que terminam em `endMonth`. */
  series(endMonth: string, count: number): Promise<MonthSummary[]> {
    return this.months(lastMonths(endMonth, count));
  }

  async investments(): Promise<InvestmentPosition[]> {
    return investmentsByDestination(await this.transactions.listForReports());
  }

  /** Saldos atuais das contas bancárias e dos vales ativos. */
  async balances(): Promise<AccountBalance[]> {
    const accounts = (await this.accounts.listActive()).filter((a) => hasBalance(a.kind));
    return Promise.all(
      accounts.map(async (account) => ({ account, cents: await this.accounts.balance(account) })),
    );
  }
}

/** "YYYY-MM" de hoje no fuso do usuário. */
export function currentMonth(now: Date, timeZone: string): string {
  return toDateOnlyString(now, timeZone).slice(0, 7);
}
