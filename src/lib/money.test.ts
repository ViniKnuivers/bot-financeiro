import { describe, expect, it } from 'vitest';
import { formatCents, parseBrlToCents } from './money.js';

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

describe('parseBrlToCents', () => {
  it.each([
    ['230,50', 23050],
    ['230', 23000],
    ['0', 0],
    ['R$ 1.234,56', 123456],
    ['1.500', 150000],
    ['12.5', 1250],
    ['12.50', 1250],
    ['  45,9 ', 4590],
  ])('"%s" → %i centavos', (input, cents) => {
    expect(parseBrlToCents(input)).toBe(cents);
  });

  it.each(['', 'abc', '-10', '1,2,3', '10,555', 'dez reais'])('recusa "%s"', (input) => {
    expect(parseBrlToCents(input)).toBeNull();
  });
});
