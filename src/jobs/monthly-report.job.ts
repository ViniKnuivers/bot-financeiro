import type { Notifier, OutgoingMessage } from '../channels/message-channel.js';
import { addMonths } from '../modules/accounts/credit-invoice.js';
import type { JobStateRepository } from './job-state.repository.js';
import type { Job } from './scheduler.js';

export const MONTHLY_REPORT_KEY = 'monthly.report';

/**
 * No dia 1 (ou na primeira vez que o bot ligar no mês novo), manda o resumo do mês que
 * fechou. Guarda o último mês enviado: nunca manda duas vezes, e na primeira vez que roda
 * não manda nada retroativo.
 */
export function monthlyReportJob(deps: {
  jobState: JobStateRepository;
  notifier: Notifier;
  today: () => string;
  /** Monta a mensagem (sincroniza a planilha antes, se houver). */
  monthClosedMessage: (month: string) => Promise<OutgoingMessage>;
}): Job {
  return {
    name: 'resumo-mensal',
    intervalMs: 10 * 60 * 1000,
    async run() {
      const previous = addMonths(deps.today().slice(0, 7), -1);
      const lastSent = await deps.jobState.get(MONTHLY_REPORT_KEY);
      if (lastSent === null) {
        await deps.jobState.set(MONTHLY_REPORT_KEY, previous);
        return;
      }
      if (lastSent >= previous) return;

      // Marca antes de enviar: se o envio falhar no meio, o pior caso é não receber o
      // resumo (dá para ver em /resumo), nunca receber repetido.
      await deps.jobState.set(MONTHLY_REPORT_KEY, previous);
      await deps.notifier.notify(await deps.monthClosedMessage(previous));
    },
  };
}
