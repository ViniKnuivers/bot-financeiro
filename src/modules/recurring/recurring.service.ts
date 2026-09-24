import type { RegisteredBatch, TransactionService } from '../transactions/transaction.service.js';
import { dueDate, initialLastRunMonth, isDue } from './recurring-schedule.js';
import type {
  NewRecurringEntry,
  RecurringEntry,
  RecurringRepository,
} from './recurring.repository.js';

export interface RecurringRun {
  entry: RecurringEntry;
  batch: RegisteredBatch;
}

export class RecurringService {
  constructor(
    private readonly recurring: RecurringRepository,
    private readonly transactions: TransactionService,
  ) {}

  list(): Promise<RecurringEntry[]> {
    return this.recurring.list();
  }

  async find(id: number): Promise<RecurringEntry | null> {
    return (await this.recurring.list()).find((entry) => entry.id === id) ?? null;
  }

  /** Cadastra; se o dia deste mês já passou, o primeiro lançamento é no mês que vem. */
  create(entry: Omit<NewRecurringEntry, 'lastRunMonth'>, today: string): Promise<RecurringEntry> {
    return this.recurring.create({
      ...entry,
      lastRunMonth: initialLastRunMonth(entry.dayOfMonth, today),
    });
  }

  setActive(id: number, active: boolean): Promise<void> {
    return this.recurring.update(id, { active });
  }

  remove(id: number): Promise<void> {
    return this.recurring.remove(id);
  }

  /** Próxima data em que será lançado ("YYYY-MM-DD"). */
  nextRun(entry: RecurringEntry, today: string): string {
    const month = today.slice(0, 7);
    const thisMonth = dueDate(entry.dayOfMonth, month);
    if (entry.lastRunMonth !== month && today <= thisMonth) return thisMonth;
    const next = new Date(`${month}-01T00:00:00.000Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return dueDate(entry.dayOfMonth, next.toISOString().slice(0, 7));
  }

  /**
   * Lança os gastos fixos que venceram. Marca o mês ANTES de lançar: se o bot cair no
   * meio, o pior caso é deixar de lançar (e você vê que faltou), nunca lançar duas vezes.
   */
  async runDue(today: string): Promise<RecurringRun[]> {
    const month = today.slice(0, 7);
    const runs: RecurringRun[] = [];
    for (const entry of await this.recurring.list()) {
      if (!isDue(entry, today)) continue;
      await this.recurring.update(entry.id, { lastRunMonth: month });
      const batch = await this.transactions.register({
        drafts: [
          {
            type: entry.type,
            amountCents: entry.amountCents,
            description: entry.description,
            category: entry.category,
            paymentMethod: entry.paymentMethod,
            accountId: entry.accountId,
            installments: 1,
            occurredAt: dueDate(entry.dayOfMonth, month),
          },
        ],
        rawInput: `Gasto fixo: ${entry.description}`,
        source: 'RECURRING',
      });
      runs.push({ entry, batch });
    }
    return runs;
  }
}
