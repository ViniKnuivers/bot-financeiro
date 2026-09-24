import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { InputSource, PendingPurpose } from '../../generated/prisma/enums.js';
import { transactionDraftSchema } from '../transactions/transaction.schemas.js';

/** Rascunho da IA + a conta escolhida nos botões (null enquanto não decidida). */
export const pendingDraftSchema = transactionDraftSchema.extend({
  accountId: z.int().nullable(),
});
export type PendingDraft = z.infer<typeof pendingDraftSchema>;

const pendingDraftsSchema = z.array(pendingDraftSchema).min(1);

export interface PendingEntry {
  id: number;
  drafts: PendingDraft[];
  rawInput: string;
  source: InputSource;
  receivedAt: Date;
  /** TRANSACTION: vira lançamento. RECURRING: vira gasto fixo, no dia `recurringDay`. */
  purpose: PendingPurpose;
  recurringDay: number | null;
  createdAt: Date;
}

export type NewPendingEntry = Omit<PendingEntry, 'id' | 'createdAt'>;

export interface PendingRepository {
  create(entry: NewPendingEntry): Promise<PendingEntry>;
  findById(id: number): Promise<PendingEntry | null>;
  updateDrafts(id: number, drafts: PendingDraft[]): Promise<void>;
  /**
   * Remove e devolve a pendência. Usado para "reservá-la" antes de salvar: se dois toques
   * chegarem juntos, só o primeiro encontra a pendência, e nada é salvo em dobro.
   */
  take(id: number): Promise<PendingEntry | null>;
  list(): Promise<PendingEntry[]>;
  count(): Promise<number>;
}

type PendingRow = Awaited<ReturnType<PrismaClient['pendingEntry']['findFirstOrThrow']>>;

function toEntry(row: PendingRow): PendingEntry {
  return { ...row, drafts: pendingDraftsSchema.parse(row.drafts) };
}

export class PrismaPendingRepository implements PendingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(entry: NewPendingEntry): Promise<PendingEntry> {
    return toEntry(await this.prisma.pendingEntry.create({ data: entry }));
  }

  async findById(id: number): Promise<PendingEntry | null> {
    const row = await this.prisma.pendingEntry.findUnique({ where: { id } });
    return row ? toEntry(row) : null;
  }

  async updateDrafts(id: number, drafts: PendingDraft[]): Promise<void> {
    await this.prisma.pendingEntry.update({ where: { id }, data: { drafts } });
  }

  async take(id: number): Promise<PendingEntry | null> {
    const entry = await this.findById(id);
    if (!entry) return null;
    const { count } = await this.prisma.pendingEntry.deleteMany({ where: { id } });
    return count > 0 ? entry : null;
  }

  async list(): Promise<PendingEntry[]> {
    const rows = await this.prisma.pendingEntry.findMany({ orderBy: { id: 'asc' } });
    return rows.map(toEntry);
  }

  count(): Promise<number> {
    return this.prisma.pendingEntry.count();
  }
}
