import type { Query } from '../../ai/parse-result.schema.js';
import type { Category } from '../../generated/prisma/enums.js';
import { isVoucher, normalizeName } from '../accounts/account-kinds.js';
import type { Account } from '../accounts/account.repository.js';
import type { AccountService } from '../accounts/account.service.js';
import { percentOf, type BudgetService } from '../budgets/budget.service.js';
import type { RecurringService } from '../recurring/recurring.service.js';
import { summarizeMonths } from '../reports/monthly-report.js';
import type { TransactionRepository } from '../transactions/transaction.repository.js';
import { forecastMonth, type Forecast } from './forecast.js';
import { answerQuery, type ComputableQuery, type QueryAnswer } from './query.js';

export interface CanAffordAnswer {
  kind: 'can_afford';
  amountCents: number;
  forecast: Forecast;
  /** Sobra prevista depois da compra; null quando é paga com VR/VA (não mexe na sobra). */
  surplusAfterCents: number | null;
  budget: { category: Category; limitCents: number; percentAfter: number } | null;
  card: { account: Account; availableAfterCents: number } | null;
  verdict: 'ok' | 'careful' | 'no';
}

export type InsightAnswer = QueryAnswer | CanAffordAnswer;

export interface InsightsDeps {
  transactions: Pick<TransactionRepository, 'listForReports'>;
  accounts: Pick<AccountService, 'listAll' | 'creditSummary'>;
  recurring: Pick<RecurringService, 'list'>;
  budgets: Pick<BudgetService, 'list'>;
  /** Hoje, "YYYY-MM-DD", no fuso do usuário. */
  today: () => string;
}

/** A partir de quanto do orçamento a compra vira "com atenção" (mesmo limiar do alerta). */
const BUDGET_WARNING_PERCENT = 80;
/** Sobra prevista abaixo disso (fração das receitas) também pede atenção. */
const THIN_SURPLUS_RATIO = 0.1;

/** Responde perguntas e calcula a previsão do mês, sempre a partir do banco. */
export class InsightsService {
  constructor(private readonly deps: InsightsDeps) {}

  async answer(query: Query): Promise<InsightAnswer> {
    if (query.kind === 'can_afford') return this.canAfford(query);
    const [transactions, accounts] = await Promise.all([
      this.deps.transactions.listForReports(),
      this.deps.accounts.listAll(),
    ]);
    return answerQuery(query as ComputableQuery, transactions, accounts);
  }

  async forecast(): Promise<Forecast> {
    const [transactions, accounts, recurring] = await Promise.all([
      this.deps.transactions.listForReports(),
      this.deps.accounts.listAll(),
      this.deps.recurring.list(),
    ]);
    return forecastMonth({
      today: this.deps.today(),
      transactions,
      recurring,
      voucherAccountIds: voucherIds(accounts),
    });
  }

  private async canAfford(query: Query): Promise<CanAffordAnswer> {
    const amountCents = query.amountCents ?? 0;
    const today = this.deps.today();
    const [transactions, accounts, recurring, budgets] = await Promise.all([
      this.deps.transactions.listForReports(),
      this.deps.accounts.listAll(),
      this.deps.recurring.list(),
      this.deps.budgets.list(),
    ]);
    const voucherAccountIds = voucherIds(accounts);
    const forecast = forecastMonth({ today, transactions, recurring, voucherAccountIds });

    const named = query.account
      ? accounts.filter(
          (a) =>
            a.archivedAt === null && normalizeName(a.name) === normalizeName(query.account ?? ''),
        )
      : [];
    const paidWithVoucher =
      query.paymentMethod === 'VR' ||
      query.paymentMethod === 'VA' ||
      (named.length > 0 && named.every((a) => isVoucher(a.kind)));
    const surplusAfterCents = paidWithVoucher ? null : forecast.surplusCents - amountCents;

    let budget: CanAffordAnswer['budget'] = null;
    const [category] = query.categories;
    const limit =
      query.categories.length === 1 ? budgets.find((b) => b.category === category) : undefined;
    if (limit) {
      const [summary] = summarizeMonths(transactions, { voucherAccountIds }, [today.slice(0, 7)]);
      const spent = summary?.byCategory.find((c) => c.category === limit.category)?.cents ?? 0;
      budget = {
        category: limit.category,
        limitCents: limit.limitCents,
        percentAfter: percentOf(spent + amountCents, limit.limitCents),
      };
    }

    let card: CanAffordAnswer['card'] = null;
    const creditCard = named.find((a) => a.kind === 'CREDIT_CARD');
    if (creditCard && query.paymentMethod !== 'PIX' && query.paymentMethod !== 'DEBITO') {
      const summary = await this.deps.accounts.creditSummary(creditCard, today);
      if (summary?.availableCents != null) {
        card = { account: creditCard, availableAfterCents: summary.availableCents - amountCents };
      }
    }

    const verdict =
      (surplusAfterCents !== null && surplusAfterCents < 0) ||
      (card !== null && card.availableAfterCents < 0)
        ? 'no'
        : (budget !== null && budget.percentAfter >= BUDGET_WARNING_PERCENT) ||
            (surplusAfterCents !== null &&
              surplusAfterCents < forecast.incomeCents * THIN_SURPLUS_RATIO)
          ? 'careful'
          : 'ok';

    return { kind: 'can_afford', amountCents, forecast, surplusAfterCents, budget, card, verdict };
  }
}

function voucherIds(accounts: readonly Account[]): Set<number> {
  return new Set(accounts.filter((a) => isVoucher(a.kind)).map((a) => a.id));
}
