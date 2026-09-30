import type { Goal, PrismaClient } from '../../generated/prisma/client.js';

export type { Goal } from '../../generated/prisma/client.js';

export interface NewGoal {
  name: string;
  destination: string;
  targetCents: number;
  /** "YYYY-MM" ou null (sem prazo). */
  deadline: string | null;
}

export interface GoalRepository {
  /** Na ordem de criação. */
  list(): Promise<Goal[]>;
  create(goal: NewGoal): Promise<Goal>;
  /** Retorna false se a meta já não existia. */
  delete(id: number): Promise<boolean>;
  setAchievedAt(id: number, at: Date | null): Promise<void>;
}

export class PrismaGoalRepository implements GoalRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(): Promise<Goal[]> {
    return this.prisma.goal.findMany({ orderBy: { id: 'asc' } });
  }

  create(goal: NewGoal): Promise<Goal> {
    return this.prisma.goal.create({ data: goal });
  }

  async delete(id: number): Promise<boolean> {
    const { count } = await this.prisma.goal.deleteMany({ where: { id } });
    return count > 0;
  }

  async setAchievedAt(id: number, at: Date | null): Promise<void> {
    await this.prisma.goal.updateMany({ where: { id }, data: { achievedAt: at } });
  }
}
