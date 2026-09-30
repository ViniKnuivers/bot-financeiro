import type { Notifier, OutgoingMessage } from '../channels/message-channel.js';
import { localHour, toDateOnlyString } from '../lib/dates.js';
import { NOTICE_HOUR } from './forecast-alert.job.js';
import type { JobStateRepository } from './job-state.repository.js';
import type { Job } from './scheduler.js';

export const YEARLY_RETROSPECTIVE_KEY = 'yearly.retrospective';

/**
 * Retrospectiva do ano que fechou: em 1º de janeiro a partir das 9h (ou na primeira vez que
 * o bot ligar no ano novo). Na primeira execução só anota o ano anterior, sem mandar nada
 * retroativo, como o resumo do dia 1.
 */
export function yearlyRetrospectiveJob(deps: {
  jobState: JobStateRepository;
  notifier: Notifier;
  now: () => Date;
  timeZone: string;
  yearMessage: (year: string) => Promise<OutgoingMessage>;
}): Job {
  return {
    name: 'retrospectiva-anual',
    intervalMs: 10 * 60 * 1000,
    async run() {
      const now = deps.now();
      const previous = String(Number(toDateOnlyString(now, deps.timeZone).slice(0, 4)) - 1);
      const lastSent = await deps.jobState.get(YEARLY_RETROSPECTIVE_KEY);
      if (lastSent === null) {
        await deps.jobState.set(YEARLY_RETROSPECTIVE_KEY, previous);
        return;
      }
      if (lastSent >= previous || localHour(now, deps.timeZone) < NOTICE_HOUR) return;

      await deps.jobState.set(YEARLY_RETROSPECTIVE_KEY, previous);
      await deps.notifier.notify(await deps.yearMessage(previous));
    },
  };
}
