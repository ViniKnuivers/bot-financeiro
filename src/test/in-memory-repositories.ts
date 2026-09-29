import { parseDateOnly } from '../lib/dates.js';
import type {
  NewReminder,
  Reminder,
  ReminderRepository,
} from '../modules/reminders/reminder.repository.js';
import type { JobStateRepository } from '../jobs/job-state.repository.js';
import type {
  Account,
  AccountPatch,
  AccountRepository,
  NewAccount,
} from '../modules/accounts/account.repository.js';
import type {
  InvoicePaymentRepository,
  NewInvoicePayment,
} from '../modules/accounts/invoice-payment.repository.js';
import type { Category } from '../generated/prisma/enums.js';
import type {
  SheetSnapshotRepository,
  TrashRepository,
} from '../modules/sheets/sheet-sync.repositories.js';
import type { Transaction } from '../modules/transactions/transaction.repository.js';
import type { BudgetLimit, BudgetRepository } from '../modules/budgets/budget.repository.js';
import type {
  NewRecurringEntry,
  RecurringEntry,
  RecurringPatch,
  RecurringRepository,
} from '../modules/recurring/recurring.repository.js';
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
  readonly paid: NewInvoicePayment[] = [];

  listPaidMonths(accountId: number): Promise<string[]> {
    return Promise.resolve(
      this.paid.filter((p) => p.accountId === accountId).map((p) => p.invoiceMonth),
    );
  }

  markPaid(payment: NewInvoicePayment): Promise<void> {
    const exists = this.paid.some(
      (p) => p.accountId === payment.accountId && p.invoiceMonth === payment.invoiceMonth,
    );
    if (!exists) this.paid.push(payment);
    return Promise.resolve();
  }

  sumPaidFrom(bankAccountId: number): Promise<number> {
    return Promise.resolve(
      this.paid
        .filter((p) => p.paidFromAccountId === bankAccountId)
        .reduce((total, p) => total + p.amountCents, 0),
    );
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

export class InMemoryBudgetRepository implements BudgetRepository {
  readonly rows: BudgetLimit[] = [];

  list(): Promise<BudgetLimit[]> {
    return Promise.resolve([...this.rows]);
  }

  upsert(category: Category, limitCents: number): Promise<void> {
    const row = this.rows.find((r) => r.category === category);
    if (row) row.limitCents = limitCents;
    else this.rows.push({ category, limitCents });
    return Promise.resolve();
  }

  remove(category: Category): Promise<void> {
    const index = this.rows.findIndex((r) => r.category === category);
    if (index >= 0) this.rows.splice(index, 1);
    return Promise.resolve();
  }
}

export class InMemoryRecurringRepository implements RecurringRepository {
  readonly rows: RecurringEntry[] = [];
  private sequence = 0;

  list(): Promise<RecurringEntry[]> {
    return Promise.resolve(this.rows.map((row) => ({ ...row })));
  }

  create(entry: NewRecurringEntry): Promise<RecurringEntry> {
    const created = {
      mode: 'AUTO' as const,
      ...entry,
      id: ++this.sequence,
      active: true,
      createdAt: new Date(),
    };
    this.rows.push(created);
    return Promise.resolve({ ...created });
  }

  update(id: number, patch: RecurringPatch): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
    return Promise.resolve();
  }

  remove(id: number): Promise<void> {
    const index = this.rows.findIndex((r) => r.id === id);
    if (index >= 0) this.rows.splice(index, 1);
    return Promise.resolve();
  }
}

export class InMemorySheetSnapshotRepository implements SheetSnapshotRepository {
  entries = new Map<string, string>();

  getAll(): Promise<Map<string, string>> {
    return Promise.resolve(new Map(this.entries));
  }

  replaceAll(entries: ReadonlyMap<string, string>): Promise<void> {
    this.entries = new Map(entries);
    return Promise.resolve();
  }
}

export class InMemoryTrashRepository implements TrashRepository {
  readonly items = new Map<number, Transaction>();
  private sequence = 0;

  put(transaction: Transaction): Promise<number> {
    this.items.set(++this.sequence, structuredClone(transaction));
    return Promise.resolve(this.sequence);
  }

  take(id: number): Promise<Transaction | null> {
    const item = this.items.get(id) ?? null;
    this.items.delete(id);
    return Promise.resolve(item);
  }
}

/** JobState em memória. */
export function inMemoryJobState(): JobStateRepository & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

/** Lembretes avulsos em memória (mesmas regras de filtro do Prisma). */
export class InMemoryReminderRepository implements ReminderRepository {
  readonly rows: Reminder[] = [];
  private sequence = 0;

  create(reminder: NewReminder): Promise<Reminder> {
    const row: Reminder = {
      id: ++this.sequence,
      description: reminder.description,
      amountCents: reminder.amountCents,
      category: reminder.category,
      dueDate: parseDateOnly(reminder.dueDate),
      remindOn: parseDateOnly(reminder.remindOn),
      sentAt: reminder.sentAt ?? null,
      doneAt: null,
      canceledAt: null,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return Promise.resolve({ ...row });
  }

  find(id: number): Promise<Reminder | null> {
    const row = this.rows.find((r) => r.id === id);
    return Promise.resolve(row ? { ...row } : null);
  }

  listOpen(fromDate: string): Promise<Reminder[]> {
    const from = parseDateOnly(fromDate).getTime();
    return Promise.resolve(
      this.rows
        .filter((r) => !r.doneAt && !r.canceledAt && r.dueDate.getTime() >= from)
        .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.id - b.id)
        .map((r) => ({ ...r })),
    );
  }

  listDue(today: string): Promise<Reminder[]> {
    const day = parseDateOnly(today).getTime();
    return Promise.resolve(
      this.rows
        .filter(
          (r) =>
            !r.doneAt &&
            !r.canceledAt &&
            !r.sentAt &&
            r.remindOn.getTime() <= day &&
            r.dueDate.getTime() >= day,
        )
        .map((r) => ({ ...r })),
    );
  }

  markSent(id: number, at: Date): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.sentAt = at;
    return Promise.resolve();
  }

  markDone(id: number, at: Date): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id && !r.doneAt && !r.canceledAt);
    if (row) row.doneAt = at;
    return Promise.resolve(row !== undefined);
  }

  cancel(id: number, at: Date): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id && !r.doneAt && !r.canceledAt);
    if (row) row.canceledAt = at;
    return Promise.resolve(row !== undefined);
  }
}
