import { describe, expect, it, vi } from 'vitest';
import type { OutgoingMessage } from '../channels/message-channel.js';
import { remindersJob } from './reminders.job.js';

describe('remindersJob', () => {
  it('antes das 9h nem consulta; depois manda cada aviso por todos os canais', async () => {
    let now = new Date('2026-10-09T11:50:00Z'); // 08:50 em São Paulo
    const dueReminders = vi.fn(() => Promise.resolve([{ text: 'a' }, { text: 'b' }]));
    const notify = vi.fn<(message: OutgoingMessage) => Promise<void>>(() => Promise.resolve());
    const job = remindersJob({
      assistant: { dueReminders },
      notifier: { notify },
      now: () => now,
      timeZone: 'America/Sao_Paulo',
    });

    await job.run();
    expect(dueReminders).not.toHaveBeenCalled();

    now = new Date('2026-10-09T12:05:00Z'); // 09:05
    await job.run();
    expect(notify.mock.calls.map(([m]) => m.text)).toEqual(['a', 'b']);
  });
});
