import { describe, expect, it, vi } from 'vitest';
import type { OutgoingMessage } from '../channels/message-channel.js';
import type { Forecast } from '../modules/insights/forecast.js';
import { inMemoryJobState } from '../test/in-memory-repositories.js';
import { FORECAST_ALERT_KEY, forecastAlertJob } from './forecast-alert.job.js';

const NEGATIVE: Forecast = {
  month: '2026-10',
  endDate: '2026-10-31',
  soFarIncomeCents: 100000,
  soFarExpenseCents: 90000,
  fixedIncomeCents: 0,
  fixedExpenseCents: 30000,
  variableCents: 10000,
  incomeCents: 100000,
  expenseCents: 130000,
  surplusCents: -30000,
  basis: 'history',
};

function setup(forecast: Forecast, isoNow: string) {
  let now = new Date(isoNow);
  const jobState = inMemoryJobState();
  const notify = vi.fn<(message: OutgoingMessage) => Promise<void>>(() => Promise.resolve());
  const job = forecastAlertJob({
    insights: { forecast: () => Promise.resolve(forecast) },
    jobState,
    notifier: { notify },
    now: () => now,
    timeZone: 'America/Sao_Paulo',
  });
  return {
    job,
    notify,
    jobState,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
  };
}

describe('forecastAlertJob', () => {
  it('antes das 9h não faz nada; depois avisa uma vez só na semana', async () => {
    // 08:50 em São Paulo (segunda, 05/10).
    const { job, notify, jobState, setNow } = setup(NEGATIVE, '2026-10-05T11:50:00Z');

    await job.run();
    expect(notify).not.toHaveBeenCalled();

    setNow('2026-10-05T12:10:00Z'); // 09:10
    await job.run();
    setNow('2026-10-08T15:00:00Z'); // quinta, mesma semana
    await job.run();

    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0].text).toMatch(
      /^⚠️ Previsão para 31\/10: o mês fecha no vermelho/,
    );
    expect(jobState.values.get(FORECAST_ALERT_KEY)).toBe('2026-W41');

    setNow('2026-10-12T12:10:00Z'); // segunda seguinte
    await job.run();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('previsão positiva, sem dados ou ainda instável: sem alerta', async () => {
    for (const forecast of [
      { ...NEGATIVE, surplusCents: 5000 },
      { ...NEGATIVE, basis: 'none' as const },
      { ...NEGATIVE, basis: 'early' as const },
    ]) {
      const { job, notify } = setup(forecast, '2026-10-05T12:10:00Z');
      await job.run();
      expect(notify).not.toHaveBeenCalled();
    }
  });
});
