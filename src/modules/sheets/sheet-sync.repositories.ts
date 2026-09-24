import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Transaction } from '../transactions/transaction.repository.js';

/** Como cada linha estava na última sincronização (lançamento → hash dos campos). */
export interface SheetSnapshotRepository {
  getAll(): Promise<Map<string, string>>;
  replaceAll(entries: ReadonlyMap<string, string>): Promise<void>;
}

/** Lançamentos apagados pela planilha, para o botão "Desfazer". */
export interface TrashRepository {
  put(transaction: Transaction): Promise<number>;
  /** Tira da lixeira (null se já foi restaurado ou não existe). */
  take(id: number): Promise<Transaction | null>;
}

export class PrismaSheetSnapshotRepository implements SheetSnapshotRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getAll(): Promise<Map<string, string>> {
    const rows = await this.prisma.sheetRowSnapshot.findMany();
    return new Map(rows.map((row) => [row.transactionId, row.hash]));
  }

  async replaceAll(entries: ReadonlyMap<string, string>): Promise<void> {
    const data = [...entries].map(([transactionId, hash]) => ({ transactionId, hash }));
    await this.prisma.$transaction([
      this.prisma.sheetRowSnapshot.deleteMany(),
      this.prisma.sheetRowSnapshot.createMany({ data }),
    ]);
  }
}

/** O lançamento guardado na lixeira (datas viram texto no JSON). */
const trashedSchema = z.object({
  id: z.string(),
  type: z.enum(['EXPENSE', 'INCOME', 'INVESTMENT', 'REDEMPTION']),
  amountCents: z.int(),
  description: z.string(),
  category: z.string(),
  paymentMethod: z.string().nullable(),
  occurredAt: z.coerce.date(),
  rawInput: z.string(),
  source: z.string(),
  batchId: z.string(),
  accountId: z.int().nullable(),
  installments: z.int(),
  createdAt: z.coerce.date(),
});

export class PrismaTrashRepository implements TrashRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async put(transaction: Transaction): Promise<number> {
    const entry = await this.prisma.trashEntry.create({
      data: { payload: JSON.parse(JSON.stringify(transaction)) as object },
    });
    return entry.id;
  }

  async take(id: number): Promise<Transaction | null> {
    const entry = await this.prisma.trashEntry.findUnique({ where: { id } });
    if (!entry) return null;
    const { count } = await this.prisma.trashEntry.deleteMany({ where: { id } });
    if (count === 0) return null;
    return trashedSchema.parse(entry.payload) as Transaction;
  }
}
