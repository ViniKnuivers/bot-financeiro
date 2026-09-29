import type { Category } from '../../generated/prisma/enums.js';
import { addDays } from '../../lib/dates.js';
import type { Reminder, ReminderRepository } from './reminder.repository.js';

/** Os avisos saem a partir desta hora (no fuso do usuário). */
export const REMINDER_HOUR = 9;

export interface ReminderRequest {
  description: string;
  amountCents: number | null;
  category: Category | null;
  /** "YYYY-MM-DD" */
  dueDate: string;
}

/**
 * Quando avisar: na véspera, às 9h. Se a véspera já passou (ou é hoje e já passou das 9h),
 * avisa no próprio dia do vencimento. Vencendo hoje depois das 9h, não há mais quando
 * avisar: fica só anotado em /lembretes.
 */
export function reminderSchedule(
  dueDate: string,
  today: string,
  hour: number,
): { remindOn: string; alreadyNotified: boolean } {
  const eve = addDays(dueDate, -1);
  const tooLateToday = hour >= REMINDER_HOUR;
  if (eve > today || (eve === today && !tooLateToday)) {
    return { remindOn: eve, alreadyNotified: false };
  }
  if (dueDate > today || !tooLateToday) return { remindOn: dueDate, alreadyNotified: false };
  return { remindOn: dueDate, alreadyNotified: true };
}

export type CreateResult =
  { status: 'created'; reminder: Reminder } | { status: 'past'; dueDate: string };

export class ReminderService {
  constructor(
    private readonly reminders: ReminderRepository,
    /** Relógio injetável: hoje ("YYYY-MM-DD") e a hora local. */
    private readonly clock: { today: () => string; hour: () => number; now: () => Date },
  ) {}

  async create(request: ReminderRequest): Promise<CreateResult> {
    const today = this.clock.today();
    if (request.dueDate < today) return { status: 'past', dueDate: request.dueDate };
    const { remindOn, alreadyNotified } = reminderSchedule(
      request.dueDate,
      today,
      this.clock.hour(),
    );
    const reminder = await this.reminders.create({
      ...request,
      remindOn,
      sentAt: alreadyNotified ? this.clock.now() : null,
    });
    return { status: 'created', reminder };
  }

  find(id: number): Promise<Reminder | null> {
    return this.reminders.find(id);
  }

  /** Os que ainda vão vencer (ou vencem hoje), para /lembretes. */
  listOpen(): Promise<Reminder[]> {
    return this.reminders.listOpen(this.clock.today());
  }

  /** Os que devem ser avisados agora. Marca como avisados antes de devolver (nunca repete). */
  async takeDue(): Promise<Reminder[]> {
    const due = await this.reminders.listDue(this.clock.today());
    for (const reminder of due) await this.reminders.markSent(reminder.id, this.clock.now());
    return due;
  }

  markDone(id: number): Promise<boolean> {
    return this.reminders.markDone(id, this.clock.now());
  }

  cancel(id: number): Promise<boolean> {
    return this.reminders.cancel(id, this.clock.now());
  }
}
