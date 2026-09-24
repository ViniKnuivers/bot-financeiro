import { closingDate } from '../accounts/credit-invoice.js';

/** O mínimo de um gasto fixo para decidir quando lançar. */
export interface RecurringSchedule {
  dayOfMonth: number;
  active: boolean;
  lastRunMonth: string | null;
}

/** Data do lançamento no mês ("dia 31" em fevereiro vira o último dia). */
export function dueDate(dayOfMonth: number, month: string): string {
  return closingDate(month, dayOfMonth);
}

/**
 * Deve lançar hoje? Sim se está ativo, ainda não lançou neste mês e o dia já chegou.
 * Se o bot estiver desligado no dia, lança na primeira vez que ligar dentro do mês.
 */
export function isDue(entry: RecurringSchedule, today: string): boolean {
  const month = today.slice(0, 7);
  return entry.active && entry.lastRunMonth !== month && today >= dueDate(entry.dayOfMonth, month);
}

/**
 * Ao cadastrar: se o dia deste mês já passou, começa no mês que vem (você provavelmente
 * já lançou este mês à mão). Retorna o lastRunMonth inicial.
 */
export function initialLastRunMonth(dayOfMonth: number, today: string): string | null {
  const month = today.slice(0, 7);
  return today > dueDate(dayOfMonth, month) ? month : null;
}
