import { describe, expect, it } from 'vitest';
import {
  addDays,
  formatDateOnly,
  isoWeek,
  localHour,
  parseDateOnly,
  toDateOnlyString,
  weekdayName,
} from './dates.js';

describe('dates', () => {
  it('toDateOnlyString usa o dia no fuso informado, não o de UTC', () => {
    // 01:30 UTC do dia 24 ainda é 22:30 do dia 23 em São Paulo.
    const instant = new Date('2026-09-24T01:30:00Z');

    expect(toDateOnlyString(instant, 'America/Sao_Paulo')).toBe('2026-09-23');
    expect(toDateOnlyString(instant, 'UTC')).toBe('2026-09-24');
  });

  it('addDays atravessa meses e anos', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('weekdayName em português', () => {
    expect(weekdayName('2026-09-23')).toBe('quarta-feira');
  });

  it('parseDateOnly e formatDateOnly preservam o dia', () => {
    expect(formatDateOnly(parseDateOnly('2026-09-01'))).toBe('01/09/2026');
  });

  it('localHour usa a hora no fuso do usuário', () => {
    // 12:30 UTC = 09:30 em São Paulo.
    expect(localHour(new Date('2026-10-05T12:30:00Z'), 'America/Sao_Paulo')).toBe(9);
    expect(localHour(new Date('2026-10-05T02:59:00Z'), 'America/Sao_Paulo')).toBe(23);
  });

  it('isoWeek: semanas ISO, inclusive na virada do ano', () => {
    expect(isoWeek('2026-10-05')).toBe('2026-W41'); // segunda
    expect(isoWeek('2026-10-11')).toBe('2026-W41'); // domingo, mesma semana
    expect(isoWeek('2026-10-12')).toBe('2026-W42');
    expect(isoWeek('2027-01-01')).toBe('2026-W53'); // sexta: ainda é a última de 2026
    expect(isoWeek('2025-12-29')).toBe('2026-W01'); // segunda: já é a 1ª de 2026
  });
});
