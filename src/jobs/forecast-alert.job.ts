import type { Notifier } from '../channels/message-channel.js';
import { isoWeek, localHour, toDateOnlyString } from '../lib/dates.js';
import { forecastBreakdown, forecastSentence } from '../modules/insights/forecast.js';
import type { InsightsService } from '../modules/insights/insights.service.js';
import type { JobStateRepository } from './job-state.repository.js';
import type { Job } from './scheduler.js';

export const FORECAST_ALERT_KEY = 'forecast.alertWeek';

/** Avisos do bot saem a partir desta hora (no fuso do usuário). */
export const NOTICE_HOUR = 9;

/**
 * Sem histórico, a previsão usa só o ritmo do mês; antes deste dia ela ainda é instável
 * demais para justificar um alerta.
 */
const MIN_DAY_WITHOUT_HISTORY = 7;

/**
 * A partir das 9h, se a previsão do mês indicar que ele vai fechar no vermelho, avisa.
 * No máximo uma vez por semana (a semana do último aviso fica no JobState).
 */
export function forecastAlertJob(deps: {
  insights: Pick<InsightsService, 'forecast'>;
  jobState: JobStateRepository;
  notifier: Notifier;
  now: () => Date;
  timeZone: string;
}): Job {
  return {
    name: 'alerta-previsao',
    intervalMs: 10 * 60 * 1000,
    async run() {
      const now = deps.now();
      if (localHour(now, deps.timeZone) < NOTICE_HOUR) return;
      const today = toDateOnlyString(now, deps.timeZone);
      const week = isoWeek(today);
      if ((await deps.jobState.get(FORECAST_ALERT_KEY)) === week) return;

      const forecast = await deps.insights.forecast();
      if (forecast.surplusCents >= 0 || forecast.basis === 'none') return;
      if (forecast.basis === 'month' && Number(today.slice(8, 10)) < MIN_DAY_WITHOUT_HISTORY) {
        return;
      }

      // Marca antes de enviar: se falhar no meio, o pior caso é não receber o alerta.
      await deps.jobState.set(FORECAST_ALERT_KEY, week);
      await deps.notifier.notify({
        text: [
          forecastSentence(forecast),
          forecastBreakdown(forecast),
          '',
          'Veja no /resumo e no /orcamento onde dá para ajustar.',
        ].join('\n'),
      });
    },
  };
}
