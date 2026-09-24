import type {
  Account,
  AccountPatch,
  AccountRepository,
  NewAccount,
} from '../modules/accounts/account.repository.js';
import type { InvoicePaymentRepository } from '../modules/accounts/invoice-payment.repository.js';
import type {
  ChatStateRepository,
  ChatStateValue,
  StoredChatState,
} from '../modules/conversation/chat-state.repository.js';
import type {
  NewPendingEntry,
  PendingDraft,
  PendingEntry,
  PendingRepository,
} from '../modules/pending/pending.repository.js';

// Versões em memória dos repositórios, com o mesmo comportamento observável das
// implementações Prisma. Os ids são inteiros sequenciais, como no Postgres.

export class InMemoryAccountRepository implements AccountRepository {
  readonly rows: Account[] = [];
  private sequence = 0;

  listActive(): Promise<Account[]> {
    return Promise.resolve(this.rows.filter((row) => row.archivedAt === null));
  }

  listAll(): Promise<Account[]> {
    return Promise.resolve([...this.rows]);
  }

  createMany(items: NewAccount[]): Promise<Account[]> {
    const created = items.map((item) => ({
      ...item,
      id: ++this.sequence,
      creditAdjustmentCents: 0,
      archivedAt: null,
      createdAt: new Date(),
    }));
    this.rows.push(...created);
    return Promise.resolve(created);
  }

  archive(id: number): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.archivedAt = new Date();
    return Promise.resolve();
  }

  update(id: number, patch: AccountPatch): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
    return Promise.resolve();
  }
}

export class InMemoryInvoicePaymentRepository implements InvoicePaymentRepository {
  readonly paid: { accountId: number; invoiceMonth: string }[] = [];

  listPaidMonths(accountId: number): Promise<string[]> {
    return Promise.resolve(
      this.paid.filter((p) => p.accountId === accountId).map((p) => p.invoiceMonth),
    );
  }

  markPaid(accountId: number, invoiceMonth: string): Promise<void> {
    if (!this.paid.some((p) => p.accountId === accountId && p.invoiceMonth === invoiceMonth)) {
      this.paid.push({ accountId, invoiceMonth });
    }
    return Promise.resolve();
  }
}

export class InMemoryPendingRepository implements PendingRepository {
  readonly rows: PendingEntry[] = [];
  private sequence = 0;

  create(entry: NewPendingEntry): Promise<PendingEntry> {
    const created = { ...entry, id: ++this.sequence, createdAt: new Date() };
    this.rows.push(created);
    return Promise.resolve(structuredClone(created));
  }

  findById(id: number): Promise<PendingEntry | null> {
    const row = this.rows.find((r) => r.id === id);
    return Promise.resolve(row ? structuredClone(row) : null);
  }

  updateDrafts(id: number, drafts: PendingDraft[]): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.drafts = structuredClone(drafts);
    return Promise.resolve();
  }

  take(id: number): Promise<PendingEntry | null> {
    const index = this.rows.findIndex((r) => r.id === id);
    if (index === -1) return Promise.resolve(null);
    const [taken] = this.rows.splice(index, 1);
    return Promise.resolve(taken ?? null);
  }

  list(): Promise<PendingEntry[]> {
    return Promise.resolve(structuredClone(this.rows));
  }

  count(): Promise<number> {
    return Promise.resolve(this.rows.length);
  }
}

export class InMemoryChatStateRepository implements ChatStateRepository {
  stored: StoredChatState | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  get(): Promise<StoredChatState | null> {
    return Promise.resolve(this.stored);
  }

  set(state: ChatStateValue): Promise<void> {
    this.stored = { state: structuredClone(state), updatedAt: this.now() };
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.stored = null;
    return Promise.resolve();
  }
}
