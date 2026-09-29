import { describe, expect, it } from 'vitest';
import { InMemoryReminderRepository } from '../../test/in-memory-repositories.js';
import { reminderSchedule, ReminderService } from './reminder.service.js';

describe('reminderSchedule', () => {
  it('avisa na véspera, às 9h', () => {
    expect(reminderSchedule('2026-10-10', '2026-10-01', 15)).toEqual({
      remindOn: '2026-10-09',
      alreadyNotified: false,
    });
  });

  it('véspera é hoje: antes das 9h ainda dá; depois, avisa no próprio dia', () => {
    expect(reminderSchedule('2026-10-10', '2026-10-09', 8).remindOn).toBe('2026-10-09');
    expect(reminderSchedule('2026-10-10', '2026-10-09', 15).remindOn).toBe('2026-10-10');
  });

  it('vence hoje: antes das 9h avisa hoje; depois, só fica anotado', () => {
    expect(reminderSchedule('2026-10-10', '2026-10-10', 7)).toEqual({
      remindOn: '2026-10-10',
      alreadyNotified: false,
    });
    expect(reminderSchedule('2026-10-10', '2026-10-10', 20)).toEqual({
      remindOn: '2026-10-10',
      alreadyNotified: true,
    });
  });
});

describe('ReminderService', () => {
  function setup(today: string, hour = 12) {
    const repository = new InMemoryReminderRepository();
    const now = new Date(`${today}T15:00:00Z`);
    const service = new ReminderService(repository, {
      today: () => today,
      hour: () => hour,
      now: () => now,
    });
    return { repository, service };
  }
  const ipva = {
    description: 'Pagar IPVA',
    amountCents: 80000,
    category: null,
    dueDate: '2026-10-10',
  };

  it('data que já passou não é criada', async () => {
    const { service, repository } = setup('2026-10-11');
    expect(await service.create(ipva)).toEqual({ status: 'past', dueDate: '2026-10-10' });
    expect(repository.rows).toHaveLength(0);
  });

  it('takeDue devolve cada lembrete uma vez só, e só a partir do dia do aviso', async () => {
    const early = setup('2026-10-01');
    await early.service.create(ipva);
    expect(await early.service.takeDue()).toHaveLength(0);

    // Criado na véspera às 8h: o aviso ainda sai hoje, às 9h.
    const { service } = setup('2026-10-09', 8);
    await service.create({ ...ipva, dueDate: '2026-10-10' });
    expect(await service.takeDue()).toHaveLength(1);
    expect(await service.takeDue()).toHaveLength(0);
  });

  it('cancelado ou feito sai da lista e não avisa', async () => {
    const { service } = setup('2026-10-01');
    const created = await service.create(ipva);
    if (created.status !== 'created') throw new Error('não criou');
    expect(await service.cancel(created.reminder.id)).toBe(true);
    expect(await service.cancel(created.reminder.id)).toBe(false);
    expect(await service.listOpen()).toEqual([]);
  });
});
