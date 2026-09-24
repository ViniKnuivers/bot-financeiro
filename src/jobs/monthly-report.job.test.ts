import { describe, expect, it, vi } from 'vitest';
import type { OutgoingMessage } from '../channels/message-channel.js';
import { MONTHLY_REPORT_KEY, monthlyReportJob } from './monthly-report.job.js';

function setup(initial: string | null) {
  const store = new Map<string, string>();
  if (initial) store.set(MONTHLY_REPORT_KEY, initial);
  let today = '2026-09-24';
  const notify = vi.fn<(message: OutgoingMessage) => Promise<void>>(() => Promise.resolve());
  const monthClosedMessage = vi.fn((month: string) => Promise.resolve({ text: `resumo ${month}` }));
  const job = monthlyReportJob({
    jobState: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      set: (key, value) => {
        store.set(key, value);
        return Promise.resolve();
      },
    },
    notifier: { notify },
    today: () => today,
    monthClosedMessage,
  });
  return { job, notify, store, setToday: (value: string) => (today = value) };
}

describe('aviso do dia 1', () => {
  it('na primeira vez não manda nada retroativo', async () => {
    const { job, notify, store } = setup(null);

    await job.run();

    expect(notify).not.toHaveBeenCalled();
    expect(store.get(MONTHLY_REPORT_KEY)).toBe('2026-08');
  });

  it('na virada do mês manda o resumo do mês que fechou, uma vez só', async () => {
    const { job, notify, setToday } = setup('2026-08');
    await job.run();
    expect(notify).not.toHaveBeenCalled();

    setToday('2026-10-01');
    await job.run();
    await job.run();

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith({ text: 'resumo 2026-09' });
  });

  it('bot desligado no dia 1: manda quando ligar, dentro do mês', async () => {
    const { job, notify, setToday } = setup('2026-08');

    setToday('2026-10-17');
    await job.run();

    expect(notify).toHaveBeenCalledWith({ text: 'resumo 2026-09' });
  });
});
