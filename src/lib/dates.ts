/**
 * Datas "só dia" (sem hora) são representadas como string YYYY-MM-DD na aplicação
 * e como Date à meia-noite UTC no Prisma (coluna DATE). Usar UTC nas conversões
 * garante que 23/09 continue 23/09, independente do fuso do servidor.
 */

const MS_PER_DAY = 86_400_000;

/** Data de calendário (YYYY-MM-DD) de um instante, no fuso informado. */
export function toDateOnlyString(instant: Date, timeZone: string): string {
  // en-CA formata como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export function parseDateOnly(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00.000Z`);
}

export function addDays(dateOnly: string, days: number): string {
  return new Date(parseDateOnly(dateOnly).getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Ex.: "quarta-feira". */
export function weekdayName(dateOnly: string): string {
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'UTC' }).format(
    parseDateOnly(dateOnly),
  );
}

/** Ex.: "23/09". */
export function formatDayMonth(date: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

/** Ex.: "23/09/2026". */
export function formatDateOnly(date: Date): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(date);
}
