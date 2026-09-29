import type { RecurringMode } from '../../generated/prisma/enums.js';
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

  /** AUTO: lança sozinho no dia. REMIND: lembra na véspera e lança no [Paguei]. */
  setMode(id: number, mode: RecurringMode): Promise<void> {
    return this.recurring.update(id, { mode });
  }

  /**
   * [Paguei] de um fixo em modo lembrete: lança agora (com a data de hoje) e marca o mês,
   * para não lembrar nem lançar de novo. Retorna null se esse mês já foi lançado.
   */
  async payNow(
    entry: RecurringEntry,
    month: string,
    today: string,
  ): Promise<RegisteredBatch | null> {
    const current = await this.find(entry.id);
    if (!current || current.lastRunMonth === month) return null;
    await this.recurring.update(entry.id, { lastRunMonth: month });
    return this.register(current, today);
  }

  /** [Pular este mês]: marca o mês sem lançar nada. */
  skipMonth(id: number, month: string): Promise<void> {
    return this.recurring.update(id, { lastRunMonth: month });
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
      // Os de lembrete só são lançados quando você toca em [Paguei].
      if (entry.mode === 'REMIND' || !isDue(entry, today)) continue;
      await this.recurring.update(entry.id, { lastRunMonth: month });
      const batch = await this.register(entry, dueDate(entry.dayOfMonth, month));
      runs.push({ entry, batch });
    }
    return runs;
  }

  private register(entry: RecurringEntry, occurredAt: string): Promise<RegisteredBatch> {
    return this.transactions.register({
      drafts: [
        {
          type: entry.type,
          amountCents: entry.amountCents,
          description: entry.description,
          category: entry.category,
          paymentMethod: entry.paymentMethod,
          accountId: entry.accountId,
          installments: 1,
          occurredAt,
        },
      ],
      rawInput: `Gasto fixo: ${entry.description}`,
      source: 'RECURRING',
    });
  }
}
