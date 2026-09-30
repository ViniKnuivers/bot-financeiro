import { normalizeName } from '../accounts/account-kinds.js';
import type { InvestmentPosition } from '../reports/monthly-report.js';
import type { Goal, GoalRepository, NewGoal } from './goal.repository.js';

export const MAX_GOALS = 10;

export interface GoalProgress {
  goal: Goal;
  /** Saldo do destino (aportes − resgates), nunca negativo. */
  savedCents: number;
  /** 0 a 100 (arredondado para baixo; 100 só quando alcançou). */
  percent: number;
  remainingCents: number;
  /** Com prazo e ainda não alcançada: quanto guardar por mês até o prazo. */
  perMonthCents: number | null;
  /** Meses que faltam, contando o mês do prazo (e não o atual). */
  monthsLeft: number | null;
  /** O prazo já passou sem alcançar. */
  overdue: boolean;
  reached: boolean;
}

/** Meses de `from` até `to` ("YYYY-MM"): 2026-09 → 2026-12 = 3. */
export function monthsBetween(from: string, to: string): number {
  const [fy = 0, fm = 0] = from.split('-').map(Number);
  const [ty = 0, tm = 0] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * Progresso de uma meta. Com prazo, divide o que falta pelos meses até o prazo, contando o
 * mês do prazo e não o atual (em setembro, "até dezembro" = outubro, novembro e dezembro);
 * prazo no mês atual conta como 1 mês.
 */
export function goalProgress(goal: Goal, balanceCents: number, month: string): GoalProgress {
  const savedCents = Math.max(0, balanceCents);
  const reached = savedCents >= goal.targetCents;
  const remainingCents = Math.max(0, goal.targetCents - savedCents);
  const percent = reached ? 100 : Math.min(99, Math.floor((savedCents / goal.targetCents) * 100));
  const months = goal.deadline ? monthsBetween(month, goal.deadline) : null;
  const overdue = !reached && months !== null && months < 0;
  const monthsLeft = months === null || overdue ? null : Math.max(1, months);
  return {
    goal,
    savedCents,
    percent,
    remainingCents,
    perMonthCents: reached || monthsLeft === null ? null : Math.ceil(remainingCents / monthsLeft),
    monthsLeft,
    overdue,
    reached,
  };
}

/**
 * Metas de economia. O dinheiro de uma meta são os aportes para o destino dela ("guardei
 * 300 pra viagem" = aporte em "Viagem"): nada novo para registrar, e resgatar desconta.
 */
export class GoalService {
  constructor(
    private readonly deps: {
      goals: GoalRepository;
      /** Saldo de cada destino de aporte (vem dos relatórios). */
      investments: () => Promise<InvestmentPosition[]>;
      /** Mês atual, "YYYY-MM". */
      month: () => string;
      now: () => Date;
    },
  ) {}

  async list(): Promise<GoalProgress[]> {
    const [goals, positions] = await Promise.all([this.deps.goals.list(), this.deps.investments()]);
    const balances = new Map(positions.map((p) => [normalizeName(p.destination), p.balanceCents]));
    const month = this.deps.month();
    return goals.map((goal) =>
      goalProgress(goal, balances.get(normalizeName(goal.destination)) ?? 0, month),
    );
  }

  /** Destinos das metas, para a IA usar o mesmo nome nos aportes ("pra viagem" → "Viagem"). */
  async destinations(): Promise<string[]> {
    return (await this.deps.goals.list()).map((goal) => goal.destination);
  }

  async create(goal: NewGoal): Promise<Goal> {
    return this.deps.goals.create(goal);
  }

  remove(id: number): Promise<boolean> {
    return this.deps.goals.delete(id);
  }

  /**
   * Depois de um aporte ou resgate: o progresso das metas desses destinos. Marca as que
   * acabaram de ser alcançadas (`justReached`, para comemorar uma vez só) e desmarca as
   * que voltaram a ficar abaixo do alvo depois de um resgate.
   */
  async afterContribution(
    destinations: readonly string[],
  ): Promise<{ progress: GoalProgress; justReached: boolean }[]> {
    const touched = new Set(destinations.map(normalizeName));
    const affected = (await this.list()).filter((p) =>
      touched.has(normalizeName(p.goal.destination)),
    );
    return Promise.all(
      affected.map(async (progress) => {
        const { goal, reached } = progress;
        const justReached = reached && goal.achievedAt === null;
        if (justReached) await this.deps.goals.setAchievedAt(goal.id, this.deps.now());
        if (!reached && goal.achievedAt !== null) {
          await this.deps.goals.setAchievedAt(goal.id, null);
        }
        return { progress, justReached };
      }),
    );
  }
}
