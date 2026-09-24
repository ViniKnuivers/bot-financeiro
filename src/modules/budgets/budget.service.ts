import type { Category } from '../../generated/prisma/enums.js';
import type { MonthSummary } from '../reports/monthly-report.js';
import type { BudgetLimit, BudgetRepository } from './budget.repository.js';

export interface BudgetStatus extends BudgetLimit {
  spentCents: number;
  /** Porcentagem inteira do limite já gasta (pode passar de 100). */
  percent: number;
}

/** Limiares avisados depois de um gasto. */
export type BudgetThreshold = 80 | 100;

/**
 * Qual limiar um gasto acabou de cruzar (null se nenhum). Só avisa na passagem: quem já
 * estava em 85% não é avisado de novo dos 80% a cada compra.
 */
export function crossedThreshold(
  limitCents: number,
  beforeCents: number,
  afterCents: number,
): BudgetThreshold | null {
  for (const threshold of [100, 80] as const) {
    const mark = (limitCents * threshold) / 100;
    if (beforeCents < mark && afterCents >= mark) return threshold;
  }
  return null;
}

export function percentOf(spentCents: number, limitCents: number): number {
  return Math.floor((spentCents * 100) / limitCents);
}

export class BudgetService {
  constructor(private readonly budgets: BudgetRepository) {}

  list(): Promise<BudgetLimit[]> {
    return this.budgets.list();
  }

  set(category: Category, limitCents: number): Promise<void> {
    return this.budgets.upsert(category, limitCents);
  }

  remove(category: Category): Promise<void> {
    return this.budgets.remove(category);
  }

  /** Gasto × limite de cada categoria com orçamento, no mês do resumo. */
  async status(summary: MonthSummary): Promise<BudgetStatus[]> {
    const spent = new Map(summary.byCategory.map((c) => [c.category, c.cents]));
    return (await this.budgets.list()).map((budget) => {
      const spentCents = spent.get(budget.category) ?? 0;
      return { ...budget, spentCents, percent: percentOf(spentCents, budget.limitCents) };
    });
  }
}
