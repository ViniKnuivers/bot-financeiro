import type {
  NewTransaction,
  Transaction,
  TransactionRepository,
} from '../modules/transactions/transaction.repository.js';

/**
 * Repositório em memória: implementa a mesma interface do Prisma, então o service
 * é testado de verdade (não só "chamou o mock?") sem precisar de banco.
 */
export class InMemoryTransactionRepository implements TransactionRepository {
  readonly rows: Transaction[] = [];
  private sequence = 0;

  createBatch(batchId: string, items: NewTransaction[]): Promise<Transaction[]> {
    const created = items.map((item) => ({
      ...item,
      batchId,
      id: `tx-${String(++this.sequence).padStart(3, '0')}`,
      createdAt: new Date(),
    }));
    this.rows.push(...created);
    return Promise.resolve(created);
  }

  deleteBatch(batchId: string): Promise<number> {
    const before = this.rows.length;
    this.remove((row) => row.batchId === batchId);
    return Promise.resolve(before - this.rows.length);
  }

  findLatest(limit: number): Promise<Transaction[]> {
    return Promise.resolve(this.rows.toReversed().slice(0, limit));
  }

  deleteLatest(): Promise<Transaction | null> {
    const latest = this.rows.at(-1) ?? null;
    if (latest) this.remove((row) => row.id === latest.id);
    return Promise.resolve(latest);
  }

  private remove(predicate: (row: Transaction) => boolean): void {
    const kept = this.rows.filter((row) => !predicate(row));
    this.rows.splice(0, this.rows.length, ...kept);
  }
}
