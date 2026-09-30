import { describe, expect, it } from 'vitest';
import { InMemoryGoalRepository } from '../../test/in-memory-repositories.js';
import type { Goal } from './goal.repository.js';
import { GoalService, goalProgress, monthsBetween } from './goal.service.js';

const goal = (overrides: Partial<Goal> = {}): Goal => ({
  id: 1,
  name: 'Viagem',
  destination: 'Viagem',
  targetCents: 500000,
  deadline: '2026-12',
  achievedAt: null,
  createdAt: new Date(),
  ...overrides,
});

describe('goalProgress', () => {
  it('divide o que falta pelos meses até o prazo, sem contar o mês atual', () => {
    expect(monthsBetween('2026-09', '2026-12')).toBe(3);
    expect(goalProgress(goal(), 200000, '2026-09')).toMatchObject({
      savedCents: 200000,
      percent: 40,
      remainingCents: 300000,
      monthsLeft: 3,
      perMonthCents: 100000,
      reached: false,
      overdue: false,
    });
  });

  it('prazo no mês atual conta como 1 mês; prazo que passou vira atrasada', () => {
    expect(goalProgress(goal(), 0, '2026-12').perMonthCents).toBe(500000);
    expect(goalProgress(goal(), 0, '2027-01')).toMatchObject({
      overdue: true,
      perMonthCents: null,
    });
  });

  it('alcançada: 100%, sem valor por mês; saldo negativo conta como zero; 99% até bater', () => {
    expect(goalProgress(goal(), 600000, '2026-09')).toMatchObject({
      reached: true,
      percent: 100,
      remainingCents: 0,
      perMonthCents: null,
    });
    expect(goalProgress(goal(), -5000, '2026-09').savedCents).toBe(0);
    expect(goalProgress(goal(), 499999, '2026-09').percent).toBe(99);
    expect(goalProgress(goal({ deadline: null }), 0, '2026-09').perMonthCents).toBeNull();
  });
});

describe('GoalService.afterContribution', () => {
  it('comemora uma vez ao bater, e desmarca se um resgate deixar abaixo do alvo', async () => {
    const repository = new InMemoryGoalRepository();
    let balance = 0;
    const service = new GoalService({
      goals: repository,
      investments: () =>
        Promise.resolve([
          {
            destination: 'viagem',
            investedCents: balance,
            redeemedCents: 0,
            balanceCents: balance,
          },
        ]),
      month: () => '2026-09',
      now: () => new Date('2026-09-30T12:00:00Z'),
    });
    await repository.create({
      name: 'Viagem',
      destination: 'Viagem',
      targetCents: 1000,
      deadline: null,
    });
    await repository.create({
      name: 'Carro',
      destination: 'Carro',
      targetCents: 1000,
      deadline: null,
    });

    balance = 1200;
    const reached = await service.afterContribution(['Viágem']);
    expect(reached.map((u) => [u.progress.goal.name, u.justReached])).toEqual([['Viagem', true]]);
    expect((await service.afterContribution(['Viagem']))[0]?.justReached).toBe(false);

    balance = 500;
    await service.afterContribution(['Viagem']);
    expect(repository.rows[0]?.achievedAt).toBeNull();
  });
});
