import { describe, expect, it } from 'vitest';
import { parseDeadline } from './goals-flow.js';

describe('parseDeadline', () => {
  it.each([
    ['dezembro', '2026-12'],
    ['Dezembro de 2027', '2027-12'],
    ['até dezembro', '2026-12'],
    ['dez/2026', '2026-12'],
    ['12/2026', '2026-12'],
    ['06/27', '2027-06'],
    ['março', '2027-03'], // já passou este ano: o próximo março
    ['setembro', '2026-09'], // o mês atual vale
  ])('%s → %s', (text, expected) => {
    expect(parseDeadline(text, '2026-09')).toBe(expected);
  });

  it('recusa mês que já passou e texto que não é mês', () => {
    expect(parseDeadline('03/2026', '2026-09')).toBeNull();
    expect(parseDeadline('13/2026', '2026-09')).toBeNull();
    expect(parseDeadline('logo', '2026-09')).toBeNull();
  });
});
