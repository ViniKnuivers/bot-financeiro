import type { PrismaClient, Reminder } from '../../generated/prisma/client.js';
import type { Category } from '../../generated/prisma/enums.js';
import { parseDateOnly } from '../../lib/dates.js';

export type { Reminder } from '../../generated/prisma/client.js';

export interface NewReminder {
  description: string;
  amountCents: number | null;
  category: Category | null;
  /** "YYYY-MM-DD" */
  dueDate: string;
  /** "YYYY-MM-DD": dia em que o aviso sai (às 9h). */
  remindOn: string;
  /** Preenchido quando não há mais o que avisar (ex.: vence hoje, criado depois das 9h). */
  sentAt?: Date | null;
}

export interface ReminderRepository {
  create(reminder: NewReminder): Promise<Reminder>;
  find(id: number): Promise<Reminder | null>;
  /** Em aberto (nem feitos nem cancelados) que vencem a partir de `fromDate`, por data. */
  listOpen(fromDate: string): Promise<Reminder[]>;
  /** Em aberto, ainda não avisados, com aviso marcado até `today` e que ainda não venceram. */
  listDue(today: string): Promise<Reminder[]>;
  markSent(id: number, at: Date): Promise<void>;
  /** Marca como feito; retorna false se já estava feito ou cancelado. */
  markDone(id: number, at: Date): Promise<boolean>;
  cancel(id: number, at: Date): Promise<boolean>;
}

export class PrismaReminderRepository implements ReminderRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(reminder: NewReminder): Promise<Reminder> {
    return this.prisma.reminder.create({
      data: {
        description: reminder.description,
        amountCents: reminder.amountCents,
        category: reminder.category,
        dueDate: parseDateOnly(reminder.dueDate),
        remindOn: parseDateOnly(reminder.remindOn),
        sentAt: reminder.sentAt ?? null,
      },
    });
  }

  find(id: number): Promise<Reminder | null> {
    return this.prisma.reminder.findUnique({ where: { id } });
  }

  listOpen(fromDate: string): Promise<Reminder[]> {
    return this.prisma.reminder.findMany({
      where: { doneAt: null, canceledAt: null, dueDate: { gte: parseDateOnly(fromDate) } },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    });
  }

  listDue(today: string): Promise<Reminder[]> {
    const day = parseDateOnly(today);
    return this.prisma.reminder.findMany({
      where: {
        doneAt: null,
        canceledAt: null,
        sentAt: null,
        remindOn: { lte: day },
        dueDate: { gte: day },
      },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    });
  }

  async markSent(id: number, at: Date): Promise<void> {
    await this.prisma.reminder.update({ where: { id }, data: { sentAt: at } });
  }

  async markDone(id: number, at: Date): Promise<boolean> {
    const { count } = await this.prisma.reminder.updateMany({
      where: { id, doneAt: null, canceledAt: null },
      data: { doneAt: at },
    });
    return count > 0;
  }

  async cancel(id: number, at: Date): Promise<boolean> {
    const { count } = await this.prisma.reminder.updateMany({
      where: { id, doneAt: null, canceledAt: null },
      data: { canceledAt: at },
    });
    return count > 0;
  }
}
