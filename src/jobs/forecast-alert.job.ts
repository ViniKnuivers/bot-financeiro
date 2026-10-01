import type { Notifier } from '../channels/message-channel.js';
import { isoWeek, localHour, toDateOnlyString } from '../lib/dates.js';
import { forecastBreakdown, forecastSentence, hasForecast } from '../modules/insights/forecast.js';
import type { InsightsService } from '../modules/insights/insights.service.js';
import type { JobStateRepository } from './job-state.repository.js';
import type { Job } from './scheduler.js';

export const FORECAST_ALERT_KEY = 'forecast.alertWeek';

/** Avisos do bot saem a partir desta hora (no fuso do usuário). */
export const NOTICE_HOUR = 9;

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
      // Sem histórico e antes do dia 7, a previsão nem existe ("early"): nada de alerta.
      if (forecast.surplusCents >= 0 || !hasForecast(forecast)) return;

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
