import type { PrismaClient, RecurringEntry } from '../../generated/prisma/client.js';

export type { RecurringEntry } from '../../generated/prisma/client.js';

export type NewRecurringEntry = Pick<
  RecurringEntry,
  | 'type'
  | 'amountCents'
  | 'description'
  | 'category'
  | 'paymentMethod'
  | 'accountId'
  | 'dayOfMonth'
  | 'lastRunMonth'
>;

export type RecurringPatch = Partial<Pick<RecurringEntry, 'active' | 'lastRunMonth' | 'mode'>>;

export interface RecurringRepository {
  list(): Promise<RecurringEntry[]>;
  create(entry: NewRecurringEntry): Promise<RecurringEntry>;
  update(id: number, patch: RecurringPatch): Promise<void>;
  remove(id: number): Promise<void>;
}

export class PrismaRecurringRepository implements RecurringRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(): Promise<RecurringEntry[]> {
    return this.prisma.recurringEntry.findMany({ orderBy: [{ dayOfMonth: 'asc' }, { id: 'asc' }] });
  }

  create(entry: NewRecurringEntry): Promise<RecurringEntry> {
    return this.prisma.recurringEntry.create({ data: entry });
  }

  async update(id: number, patch: RecurringPatch): Promise<void> {
    await this.prisma.recurringEntry.update({ where: { id }, data: patch });
  }

  async remove(id: number): Promise<void> {
    await this.prisma.recurringEntry.deleteMany({ where: { id } });
  }
}
