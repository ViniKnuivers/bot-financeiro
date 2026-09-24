import type { Assistant } from '../assistant/assistant.js';
import type { Notifier } from '../channels/message-channel.js';
import type { RecurringService } from '../modules/recurring/recurring.service.js';
import type { Job } from './scheduler.js';

/** A cada 10 minutos, lança os gastos fixos que venceram e avisa no chat. */
export function recurringJob(deps: {
  recurring: RecurringService;
  assistant: Pick<Assistant, 'announceRecurring'>;
  notifier: Notifier;
  today: () => string;
}): Job {
  return {
    name: 'gastos-fixos',
    intervalMs: 10 * 60 * 1000,
    async run() {
      const runs = await deps.recurring.runDue(deps.today());
      for (const message of await deps.assistant.announceRecurring(runs)) {
        await deps.notifier.notify(message);
      }
    },
  };
}
