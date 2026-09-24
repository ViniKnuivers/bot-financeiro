import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Category } from '../../generated/prisma/enums.js';

export interface BudgetLimit {
  category: Category;
  limitCents: number;
}

export interface BudgetRepository {
  list(): Promise<BudgetLimit[]>;
  upsert(category: Category, limitCents: number): Promise<void>;
  remove(category: Category): Promise<void>;
}

export class PrismaBudgetRepository implements BudgetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(): Promise<BudgetLimit[]> {
    return this.prisma.budget.findMany({
      select: { category: true, limitCents: true },
      orderBy: { category: 'asc' },
    });
  }

  async upsert(category: Category, limitCents: number): Promise<void> {
    await this.prisma.budget.upsert({
      where: { category },
      create: { category, limitCents },
      update: { limitCents },
    });
  }

  async remove(category: Category): Promise<void> {
    await this.prisma.budget.deleteMany({ where: { category } });
  }
}
