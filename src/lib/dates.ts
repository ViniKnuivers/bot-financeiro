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

/** Hora (0 a 23) de um instante no fuso informado, para tarefas "a partir das 9h". */
export function localHour(instant: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  })
    .formatToParts(instant)
    .find((part) => part.type === 'hour')?.value;
  return Number(hour ?? 0);
}

/** Semana ISO ("2026-W41"), para avisos que saem no máximo uma vez por semana. */
export function isoWeek(dateOnly: string): string {
  const date = parseDateOnly(dateOnly);
  // A semana ISO é a da quinta-feira mais próxima (segunda = início da semana).
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday + 3);
  const year = date.getUTCFullYear();
  const firstThursday = parseDateOnly(`${year}-01-04`);
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
  return `${year}-W${String(week).padStart(2, '0')}`;
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

/** "2026-10" → "out/2026". */
export function formatMonthShort(month: string): string {
  const name = new Intl.DateTimeFormat('pt-BR', { month: 'short', timeZone: 'UTC' })
    .format(new Date(`${month}-01T00:00:00.000Z`))
    .replace('.', '');
  return `${name}/${month.slice(0, 4)}`;
}

/** "2026-09" → "setembro de 2026". */
export function formatMonthLong(month: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00.000Z`));
}

/**
 * Número de série de data das planilhas (dias desde 30/12/1899), para gravar datas como
 * data de verdade (ordenável e com formato), e não como texto.
 */
export function toSheetSerial(dateOnly: string): number {
  return (parseDateOnly(dateOnly).getTime() - Date.UTC(1899, 11, 30)) / MS_PER_DAY;
}
