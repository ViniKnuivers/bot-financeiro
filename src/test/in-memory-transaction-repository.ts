import type {
  TransactionPatch,
  AccountTotals,
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

  sumByAccount(accountId: number): Promise<AccountTotals> {
    const sum = (type: Transaction['type']) =>
      this.rows
        .filter((row) => row.accountId === accountId && row.type === type)
        .reduce((total, row) => total + row.amountCents, 0);
    return Promise.resolve({
      EXPENSE: sum('EXPENSE'),
      INCOME: sum('INCOME'),
      INVESTMENT: sum('INVESTMENT'),
      REDEMPTION: sum('REDEMPTION'),
    });
  }

  listPurchasesByAccount(accountId: number) {
    return Promise.resolve(
      this.rows
        .filter((row) => row.accountId === accountId && row.type === 'EXPENSE')
        .map(({ amountCents, installments, occurredAt }) => ({
          amountCents,
          installments,
          occurredAt,
        })),
    );
  }

  listAll(): Promise<Transaction[]> {
    return Promise.resolve(
      this.rows.toSorted(
        (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id),
      ),
    );
  }

  update(id: string, fields: TransactionPatch): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) Object.assign(row, fields);
    return Promise.resolve();
  }

  deleteById(id: string): Promise<number> {
    const before = this.rows.length;
    this.remove((row) => row.id === id);
    return Promise.resolve(before - this.rows.length);
  }

  restore(transaction: Transaction): Promise<void> {
    this.rows.push({ ...transaction });
    return Promise.resolve();
  }

  listForReports() {
    return Promise.resolve([...this.rows]);
  }

  private remove(predicate: (row: Transaction) => boolean): void {
    const kept = this.rows.filter((row) => !predicate(row));
    this.rows.splice(0, this.rows.length, ...kept);
  }
}
