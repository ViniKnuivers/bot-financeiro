import { describe, expect, it, vi } from 'vitest';
import type { OutgoingMessage } from '../channels/message-channel.js';
import { inMemoryJobState } from '../test/in-memory-repositories.js';
import { WEEKLY_SUMMARY_KEY, weeklySummaryJob } from './weekly-summary.job.js';
import { YEARLY_RETROSPECTIVE_KEY, yearlyRetrospectiveJob } from './yearly-retrospective.job.js';

function clock(iso: string) {
  let now = new Date(iso);
  return {
    now: () => now,
    set: (next: string) => {
      now = new Date(next);
    },
  };
}

describe('weeklySummaryJob', () => {
  function setup(iso: string) {
    const time = clock(iso);
    const jobState = inMemoryJobState();
    const notify = vi.fn<(message: OutgoingMessage) => Promise<void>>(() => Promise.resolve());
    const weekMessage = vi.fn((sunday: string) => Promise.resolve({ text: `semana ${sunday}` }));
    const job = weeklySummaryJob({
      jobState,
      notifier: { notify },
      now: time.now,
      timeZone: 'America/Sao_Paulo',
      weekMessage,
    });
    return { job, notify, weekMessage, jobState, time };
  }

  it('domingo antes das 19h nada; às 19h manda uma vez na semana', async () => {
    const { job, notify, jobState, time } = setup('2026-10-04T21:50:00Z'); // domingo 18:50

    await job.run();
    expect(notify).not.toHaveBeenCalled();

    time.set('2026-10-04T22:05:00Z'); // 19:05
    await job.run();
    time.set('2026-10-05T01:00:00Z'); // 22:00
    await job.run();

    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0].text).toBe('semana 2026-10-04');
    expect(jobState.values.get(WEEKLY_SUMMARY_KEY)).toBe('2026-W40');
  });

  it('bot desligado no domingo: manda segunda de manhã; depois do meio-dia, pula', async () => {
    const morning = setup('2026-10-05T13:00:00Z'); // segunda 10:00
    await morning.job.run();
    expect(morning.weekMessage).toHaveBeenCalledWith('2026-10-04');

    const afternoon = setup('2026-10-05T16:00:00Z'); // segunda 13:00
    await afternoon.job.run();
    expect(afternoon.notify).not.toHaveBeenCalled();
  });
});

describe('yearlyRetrospectiveJob', () => {
  it('primeira vez só anota; em 1º de janeiro a partir das 9h manda o ano que fechou, uma vez', async () => {
    const time = clock('2026-09-30T15:00:00Z');
    const jobState = inMemoryJobState();
    const notify = vi.fn<(message: OutgoingMessage) => Promise<void>>(() => Promise.resolve());
    const job = yearlyRetrospectiveJob({
      jobState,
      notifier: { notify },
      now: time.now,
      timeZone: 'America/Sao_Paulo',
      yearMessage: (year) => Promise.resolve({ text: `ano ${year}` }),
    });

    await job.run();
    expect(jobState.values.get(YEARLY_RETROSPECTIVE_KEY)).toBe('2025');

    time.set('2027-01-01T10:00:00Z'); // 07:00 em São Paulo
    await job.run();
    expect(notify).not.toHaveBeenCalled();

    time.set('2027-01-01T12:30:00Z'); // 09:30
    await job.run();
    time.set('2027-01-02T12:30:00Z');
    await job.run();

    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0].text).toBe('ano 2026');
  });
});
