import { describe, expect, it } from 'vitest';
import { dueDate, initialLastRunMonth, isDue } from './recurring-schedule.js';

const entry = (dayOfMonth: number, lastRunMonth: string | null = null, active = true) => ({
  dayOfMonth,
  lastRunMonth,
  active,
});

describe('gastos fixos: quando lançar', () => {
  it('dia 31 em fevereiro vira o último dia do mês', () => {
    expect(dueDate(31, '2027-02')).toBe('2027-02-28');
    expect(isDue(entry(31), '2027-02-28')).toBe(true);
  });

  it('antes do dia não lança; no dia e depois (bot desligado no dia) lança', () => {
    expect(isDue(entry(10), '2026-09-09')).toBe(false);
    expect(isDue(entry(10), '2026-09-10')).toBe(true);
    expect(isDue(entry(10), '2026-09-25')).toBe(true);
  });

  it('nunca duas vezes no mesmo mês, e volta a lançar no mês seguinte', () => {
    expect(isDue(entry(10, '2026-09'), '2026-09-25')).toBe(false);
    expect(isDue(entry(10, '2026-09'), '2026-10-10')).toBe(true);
  });

  it('pausado não lança', () => {
    expect(isDue(entry(10, null, false), '2026-09-10')).toBe(false);
  });

  it('cadastro depois do dia começa no mês que vem', () => {
    expect(initialLastRunMonth(5, '2026-09-24')).toBe('2026-09');
    expect(initialLastRunMonth(28, '2026-09-24')).toBeNull();
    expect(initialLastRunMonth(24, '2026-09-24')).toBeNull();
  });
});
