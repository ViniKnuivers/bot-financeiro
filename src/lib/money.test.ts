import { describe, expect, it } from 'vitest';
import { formatCents } from './money.js';

// O Intl usa espaço não separável (U+00A0) entre "R$" e o valor, e não um espaço comum.
const NBSP = String.fromCharCode(0xa0);

describe('formatCents', () => {
  it('formata centavos como reais', () => {
    expect(formatCents(1850)).toBe(`R$${NBSP}18,50`);
    expect(formatCents(150000)).toBe(`R$${NBSP}1.500,00`);
    expect(formatCents(7)).toBe(`R$${NBSP}0,07`);
  });

  it('não usa espaço comum (por isso outros testes comparam com \\s)', () => {
    expect(formatCents(100)).not.toBe('R$ 1,00');
  });
});
