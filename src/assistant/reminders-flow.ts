import type { ReminderRequest } from '../ai/parse-result.schema.js';
import type { ActionReply, OutgoingMessage, ReplyAction } from '../channels/message-channel.js';
import type { JobStateRepository } from '../jobs/job-state.repository.js';
import { addDays, formatDayMonth, parseDateOnly } from '../lib/dates.js';
import type { Logger } from '../lib/logger.js';
import { formatCents } from '../lib/money.js';
import type { Account } from '../modules/accounts/account.repository.js';
import type { AccountService } from '../modules/accounts/account.service.js';
import { addMonths, invoiceDueDate } from '../modules/accounts/credit-invoice.js';
import type { RecurringEntry } from '../modules/recurring/recurring.repository.js';
import { dueDate as recurringDueDate } from '../modules/recurring/recurring-schedule.js';
import type { RecurringService } from '../modules/recurring/recurring.service.js';
import type { Reminder } from '../modules/reminders/reminder.repository.js';
import type { ReminderService } from '../modules/reminders/reminder.service.js';
import type { PaymentFlow } from './payment-flow.js';
import { UNDO_PREFIX } from './payment-flow.js';
import { formatMonth, formatRegistered } from './replies.js';

export interface RemindersFlowDeps {
  reminders: ReminderService;
  accounts: AccountService;
  recurring: RecurringService;
  payments: PaymentFlow;
  jobState: JobStateRepository;
  logger: Logger;
  today: () => string;
  now: () => Date;
}

const PREFIX = 'lb:';
const MAX_CANCEL_BUTTONS = 8;

/**
 * Lembretes: avulsos (criados conversando), vencimento das faturas e contas fixas em modo
 * lembrete. Botões com prefixo "lb:": rm:<id>, ok:<id>, pay:<id>, fx:<fixo>:<mês>,
 * fxs:<fixo>:<mês>, list. O [Paguei] da fatura reaproveita o "ac:payok" de /cartoes.
 */
export class RemindersFlow {
  constructor(private readonly deps: RemindersFlowDeps) {}

  /** Resposta a "me lembra de …" (a IA já entendeu descrição, valor e data). */
  async create(request: ReminderRequest): Promise<OutgoingMessage> {
    const result = await this.deps.reminders.create(request);
    if (result.status === 'past') {
      return {
        text: `Essa data (${dm(result.dueDate)}) já passou. Me diga uma data a partir de hoje.`,
      };
    }
    const { reminder } = result;
    this.deps.logger.info({ reminderId: reminder.id }, 'lembrete criado');
    const due = iso(reminder.dueDate);
    const remindOn = iso(reminder.remindOn);
    const what = describe(reminder);
    const text = reminder.sentAt
      ? `📝 Anotei: ${what}, vence hoje. Como já passou das 9h, fica só na lista de /lembretes.`
      : remindOn === due
        ? `⏰ Combinado! ${capitalize(dayLabel(remindOn, this.deps.today()))} às 9h (no próprio dia do vencimento) te lembro: ${what}.`
        : `⏰ Combinado! ${capitalize(dayLabel(remindOn, this.deps.today()))} às 9h te lembro: ${what} (vence ${dm(due)}).`;
    return {
      text,
      actions: [[{ label: '❌ Cancelar lembrete', id: `${PREFIX}rm:${reminder.id}` }]],
    };
  }

  /** /lembretes: tudo que está marcado para os próximos dias. */
  async menu(prefix = ''): Promise<OutgoingMessage> {
    const today = this.deps.today();
    const [open, accounts, fixed] = await Promise.all([
      this.deps.reminders.listOpen(),
      this.deps.accounts.listActive(),
      this.deps.recurring.list(),
    ]);
    const lines = [`${prefix}⏰ Seus lembretes (aviso na véspera, às 9h)`];

    if (open.length > 0) {
      lines.push('', 'Avulsos:');
      for (const reminder of open)
        lines.push(`• ${dm(iso(reminder.dueDate))} · ${describe(reminder)}`);
    }

    const cards = accounts.filter((a) => a.kind === 'CREDIT_CARD');
    const withDue = cards.filter((a) => a.closingDay !== null && a.dueDay !== null);
    if (withDue.length > 0) {
      lines.push('', 'Faturas:');
      for (const card of withDue) lines.push(await this.nextInvoiceLine(card, today));
    }
    const withoutDue = cards.filter((a) => a.closingDay === null || a.dueDay === null);
    if (withoutDue.length > 0) {
      lines.push(
        `(sem vencimento cadastrado: ${withoutDue.map((a) => a.name).join(', ')}; configure em /cartoes → Gerenciar)`,
      );
    }

    const reminding = fixed.filter((entry) => entry.active && entry.mode === 'REMIND');
    if (reminding.length > 0) {
      lines.push('', 'Contas fixas:');
      for (const entry of reminding) {
        const next = this.deps.recurring.nextRun(entry, today);
        lines.push(
          `• 🧾 ${entry.description}: vence ${dm(next)} · ${formatCents(entry.amountCents)}`,
        );
      }
    }

    if (open.length === 0 && withDue.length === 0 && reminding.length === 0) {
      lines.push('', 'Nenhum lembrete por enquanto.');
    }
    lines.push(
      '',
      'Para criar, é só pedir: "me lembra de pagar o IPVA dia 10, 800 reais". Contas fixas: /fixos → Gerenciar → 🔔 Lembrar na véspera.',
    );

    const buttons = open
      .slice(0, MAX_CANCEL_BUTTONS)
      .map((reminder): ReplyAction[] => [
        { label: `❌ ${reminder.description}`.slice(0, 40), id: `${PREFIX}rm:${reminder.id}` },
      ]);
    return { text: lines.join('\n'), actions: buttons };
  }

  async handleAction(actionId: string): Promise<ActionReply | null> {
    if (!actionId.startsWith(PREFIX)) return null;
    const [command = '', arg = '', month = ''] = actionId.slice(PREFIX.length).split(':');
    const id = /^\d+$/.test(arg) ? Number(arg) : null;

    switch (command) {
      case 'rm': {
        const reminder = id === null ? null : await this.deps.reminders.find(id);
        const canceled = id !== null && (await this.deps.reminders.cancel(id));
        return {
          mode: 'replace',
          text:
            canceled && reminder
              ? `🗑️ Lembrete cancelado: ${reminder.description}.`
              : 'Esse lembrete já foi resolvido ou cancelado.',
        };
      }
      case 'ok': {
        const done = id !== null && (await this.deps.reminders.markDone(id));
        return {
          mode: 'append',
          text: done ? '👍 Marcado como feito.' : 'Esse lembrete já foi resolvido.',
        };
      }
      case 'pay':
        return this.payReminder(id);
      case 'fx':
        return this.payFixed(id, month);
      case 'fxs':
        return this.skipFixed(id, month);
      default:
        return { mode: 'replace', ...(await this.menu()) };
    }
  }

  /**
   * Avisos que vencem amanhã (ou hoje, se o bot estava desligado na véspera). Chamado pela
   * tarefa das 9h. Cada aviso é marcado antes de sair: nunca se repete.
   */
  async dueNotices(): Promise<OutgoingMessage[]> {
    const today = this.deps.today();
    const tomorrow = addDays(today, 1);
    const notices: OutgoingMessage[] = [];

    for (const reminder of await this.deps.reminders.takeDue()) {
      notices.push({
        text: `⏰ Lembrete: ${describe(reminder)}. Vence ${dayLabel(iso(reminder.dueDate), today)}.`,
        actions: [
          [
            reminder.amountCents === null
              ? { label: '✅ Feito', id: `${PREFIX}ok:${reminder.id}` }
              : { label: '✅ Paguei e registrar', id: `${PREFIX}pay:${reminder.id}` },
          ],
        ],
      });
    }

    const accounts = await this.deps.accounts.listActive();
    for (const card of accounts) {
      if (card.kind !== 'CREDIT_CARD' || card.closingDay === null || card.dueDay === null) continue;
      const month = today.slice(0, 7);
      for (const invoiceMonth of [addMonths(month, -1), month, addMonths(month, 1)]) {
        const due = invoiceDueDate(invoiceMonth, card.closingDay, card.dueDay);
        if (due !== today && due !== tomorrow) continue;
        const key = `reminder.invoice.${card.id}.${invoiceMonth}`;
        if ((await this.deps.jobState.get(key)) !== null) continue;
        const status = await this.deps.accounts.invoiceStatus(card, invoiceMonth);
        await this.deps.jobState.set(key, today);
        if (status.paid || status.cents <= 0) continue;
        notices.push({
          text: `💳 A fatura de ${formatMonth(invoiceMonth)} do ${card.name} vence ${dayLabel(due, today)}: ${formatCents(status.cents)}.`,
          actions: [[{ label: '✅ Paguei', id: `ac:payok:${card.id}:${invoiceMonth}` }]],
        });
      }
    }

    for (const entry of await this.deps.recurring.list()) {
      if (!entry.active || entry.mode !== 'REMIND') continue;
      for (const month of new Set([today.slice(0, 7), tomorrow.slice(0, 7)])) {
        const due = recurringDueDate(entry.dayOfMonth, month);
        if ((due !== today && due !== tomorrow) || entry.lastRunMonth === month) continue;
        const key = `reminder.fixed.${entry.id}.${month}`;
        if ((await this.deps.jobState.get(key)) !== null) continue;
        await this.deps.jobState.set(key, today);
        notices.push(this.fixedNotice(entry, month, due, today));
      }
    }
    return notices;
  }

  private fixedNotice(
    entry: RecurringEntry,
    month: string,
    due: string,
    today: string,
  ): OutgoingMessage {
    return {
      text: `🧾 ${capitalize(dayLabel(due, today))} vence: ${entry.description} · ${formatCents(entry.amountCents)}. Quando pagar, toque em [Paguei] que eu registro.`,
      actions: [
        [
          { label: '✅ Paguei', id: `${PREFIX}fx:${entry.id}:${month}` },
          { label: '⏭️ Pular este mês', id: `${PREFIX}fxs:${entry.id}:${month}` },
        ],
      ],
    };
  }

  private async payReminder(id: number | null): Promise<ActionReply> {
    const reminder = id === null ? null : await this.deps.reminders.find(id);
    if (reminder?.amountCents == null || !(await this.deps.reminders.markDone(reminder.id))) {
      return { mode: 'append', text: 'Esse lembrete já foi resolvido.' };
    }
    // Segue o fluxo normal: pergunta a forma de pagamento com botões e só então salva.
    const { message } = await this.deps.payments.start({
      drafts: [
        {
          type: 'EXPENSE',
          amountCents: reminder.amountCents,
          description: reminder.description
            .replace(/^pagar\s+/i, '')
            .replace(/^./, (c) => c.toUpperCase()),
          category: reminder.category ?? 'CONTAS',
          paymentMethod: null,
          account: null,
          installments: 1,
          occurredAt: this.deps.today(),
        },
      ],
      rawInput: `Lembrete: ${reminder.description}`,
      source: 'TEXT',
      receivedAt: this.deps.now(),
    });
    return { mode: 'replace', ...message };
  }

  private async payFixed(id: number | null, month: string): Promise<ActionReply> {
    const entry = id === null ? null : await this.deps.recurring.find(id);
    if (!entry || !/^\d{4}-\d{2}$/.test(month)) {
      return { mode: 'append', text: 'Essa conta fixa não existe mais.' };
    }
    const batch = await this.deps.recurring.payNow(entry, month, this.deps.today());
    if (!batch) return { mode: 'append', text: `${entry.description} já está lançado neste mês.` };
    this.deps.logger.info({ recurringId: entry.id, month }, 'conta fixa paga pelo lembrete');
    const accounts = new Map((await this.deps.accounts.listAll()).map((a) => [a.id, a]));
    return {
      mode: 'replace',
      text: `✅ Registrado:\n\n${formatRegistered(batch.transactions, accounts)}`,
      actions: [[{ label: '↩️ Desfazer', id: `${UNDO_PREFIX}${batch.batchId}` }]],
    };
  }

  private async skipFixed(id: number | null, month: string): Promise<ActionReply> {
    const entry = id === null ? null : await this.deps.recurring.find(id);
    if (!entry || !/^\d{4}-\d{2}$/.test(month)) {
      return { mode: 'append', text: 'Essa conta fixa não existe mais.' };
    }
    if (entry.lastRunMonth === month) {
      return { mode: 'append', text: `${entry.description} já está resolvido neste mês.` };
    }
    await this.deps.recurring.skipMonth(entry.id, month);
    return { mode: 'replace', text: `⏭️ Pulei ${entry.description} em ${formatMonth(month)}.` };
  }

  /** "• 💳 Itaú: vence 10/10 · R$ 850,00" — a próxima fatura ainda não paga. */
  private async nextInvoiceLine(card: Account, today: string): Promise<string> {
    const closingDay = card.closingDay ?? 1;
    const dueDay = card.dueDay ?? 1;
    const month = today.slice(0, 7);
    for (const invoiceMonth of [addMonths(month, -1), month, addMonths(month, 1)]) {
      const due = invoiceDueDate(invoiceMonth, closingDay, dueDay);
      if (due < today) continue;
      const status = await this.deps.accounts.invoiceStatus(card, invoiceMonth);
      if (status.paid) continue;
      return `• 💳 ${card.name}: vence ${dm(due)} · ${formatCents(status.cents)}`;
    }
    return `• 💳 ${card.name}: vence dia ${dueDay}`;
  }
}

/** "Pagar IPVA · R$ 800,00" */
function describe(reminder: Reminder): string {
  return reminder.amountCents === null
    ? reminder.description
    : `${reminder.description} · ${formatCents(reminder.amountCents)}`;
}

/** "hoje", "amanhã" ou "dia 10/10". */
function dayLabel(date: string, today: string): string {
  if (date === today) return 'hoje';
  if (date === addDays(today, 1)) return 'amanhã';
  return `dia ${dm(date)}`;
}

function dm(date: string): string {
  return formatDayMonth(parseDateOnly(date));
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
