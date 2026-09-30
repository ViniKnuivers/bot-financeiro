import type { Notifier, OutgoingMessage } from '../channels/message-channel.js';
import { addDays, isoWeek, localHour, toDateOnlyString } from '../lib/dates.js';
import type { JobStateRepository } from './job-state.repository.js';
import type { Job } from './scheduler.js';

export const WEEKLY_SUMMARY_KEY = 'weekly.summaryWeek';
/** Domingo, a partir desta hora (fuso do usuário). */
export const WEEKLY_SUMMARY_HOUR = 19;
/** Se o bot estava desligado no domingo à noite, ainda vale mandar até segunda ao meio-dia. */
const LATE_UNTIL_HOUR = 12;

/**
 * Resumo semanal: domingo a partir das 19h, uma vez por semana (a semana ISO fica no
 * JobState). Se o bot estava desligado, manda na segunda de manhã; depois disso, pula.
 */
export function weeklySummaryJob(deps: {
  jobState: JobStateRepository;
  notifier: Notifier;
  now: () => Date;
  timeZone: string;
  /** Monta o resumo da semana que termina no domingo informado. */
  weekMessage: (sunday: string) => Promise<OutgoingMessage>;
}): Job {
  return {
    name: 'resumo-semanal',
    intervalMs: 10 * 60 * 1000,
    async run() {
      const now = deps.now();
      const today = toDateOnlyString(now, deps.timeZone);
      const hour = localHour(now, deps.timeZone);
      const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
      let sunday: string;
      if (weekday === 0 && hour >= WEEKLY_SUMMARY_HOUR) sunday = today;
      else if (weekday === 1 && hour < LATE_UNTIL_HOUR) sunday = addDays(today, -1);
      else return;

      const week = isoWeek(sunday);
      if ((await deps.jobState.get(WEEKLY_SUMMARY_KEY)) === week) return;
      // Marca antes de enviar: no pior caso não chega (dá para ver com /semana), nunca repete.
      await deps.jobState.set(WEEKLY_SUMMARY_KEY, week);
      await deps.notifier.notify(await deps.weekMessage(sunday));
    },
  };
}
