import { describe, expect, it } from 'vitest';
import { crossedThreshold, percentOf } from './budget.service.js';

describe('crossedThreshold (limite R$ 100)', () => {
  it.each([
    [0, 7900, null],
    [7900, 8000, 80],
    [7000, 8500, 80],
    [8500, 9000, null],
    [9000, 10000, 100],
    [7000, 12000, 100],
    [12000, 13000, null],
  ] as const)('de %i para %i → %s', (before, after, expected) => {
    expect(crossedThreshold(10000, before, after)).toBe(expected);
  });

  it('percentOf arredonda para baixo', () => {
    expect(percentOf(8599, 10000)).toBe(85);
  });
});
