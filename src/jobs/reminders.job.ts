import type { Notifier, OutgoingMessage } from '../channels/message-channel.js';
import { localHour } from '../lib/dates.js';
import { REMINDER_HOUR } from '../modules/reminders/reminder.service.js';
import type { Job } from './scheduler.js';

/**
 * A cada 10 minutos, a partir das 9h (no fuso do usuário), manda os lembretes que vencem
 * amanhã: avulsos, faturas e contas fixas em modo lembrete. Se o bot estava desligado na
 * véspera, avisa no próprio dia. Cada aviso é marcado antes de sair, então nunca repete.
 */
export function remindersJob(deps: {
  assistant: { dueReminders: () => Promise<OutgoingMessage[]> };
  notifier: Notifier;
  now: () => Date;
  timeZone: string;
}): Job {
  return {
    name: 'lembretes',
    intervalMs: 10 * 60 * 1000,
    async run() {
      if (localHour(deps.now(), deps.timeZone) < REMINDER_HOUR) return;
      for (const message of await deps.assistant.dueReminders()) {
        await deps.notifier.notify(message);
      }
    },
  };
}
