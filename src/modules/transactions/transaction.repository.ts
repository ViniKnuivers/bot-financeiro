import type { PrismaClient, Transaction } from '../../generated/prisma/client.js';
import type {
  Category,
  InputSource,
  PaymentMethod,
  TransactionType,
} from '../../generated/prisma/enums.js';

export type { Transaction } from '../../generated/prisma/client.js';

export interface NewTransaction {
  type: TransactionType;
  amountCents: number;
  description: string;
  category: Category;
  paymentMethod: PaymentMethod | null;
  occurredAt: Date;
  rawInput: string;
  source: InputSource;
}

/** Acesso a dados isolado atrás de uma interface: o service é testável sem banco. */
export interface TransactionRepository {
  createBatch(batchId: string, items: NewTransaction[]): Promise<Transaction[]>;
  /** Retorna quantas transações foram apagadas (0 se o lote já não existia). */
  deleteBatch(batchId: string): Promise<number>;
}

export class PrismaTransactionRepository implements TransactionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  createBatch(batchId: string, items: NewTransaction[]): Promise<Transaction[]> {
    // Um único INSERT com várias linhas: ou salva o lote inteiro, ou nada.
    return this.prisma.transaction.createManyAndReturn({
      data: items.map((item) => ({ ...item, batchId })),
    });
  }

  async deleteBatch(batchId: string): Promise<number> {
    const { count } = await this.prisma.transaction.deleteMany({ where: { batchId } });
    return count;
  }
}
