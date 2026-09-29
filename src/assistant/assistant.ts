import { z } from 'zod';
import {
  TransactionParserError,
  type ParseInput,
  type ParseResult,
  type TransactionParser,
} from '../ai/transaction-parser.js';
import type {
  ActionReply,
  IncomingAudioMessage,
  IncomingTextMessage,
  MessageHandler,
  OutgoingMessage,
} from '../channels/message-channel.js';
import type { InputSource } from '../generated/prisma/enums.js';
import { formatMonthLong, toDateOnlyString } from '../lib/dates.js';
import type { Logger } from '../lib/logger.js';
import { addMonths } from '../modules/accounts/credit-invoice.js';
import type { AccountService } from '../modules/accounts/account.service.js';
import type { BudgetService } from '../modules/budgets/budget.service.js';
import type { InsightsService } from '../modules/insights/insights.service.js';
import type { JobStateRepository } from '../jobs/job-state.repository.js';
import type { ReminderService } from '../modules/reminders/reminder.service.js';
import type { ChatStateRepository } from '../modules/conversation/chat-state.repository.js';
import type { PendingRepository } from '../modules/pending/pending.repository.js';
import type { RecurringRun, RecurringService } from '../modules/recurring/recurring.service.js';
import type { ReportService } from '../modules/reports/report.service.js';
import type { SheetSyncService } from '../modules/sheets/sheet-sync.service.js';
import type { TransactionService } from '../modules/transactions/transaction.service.js';
import { AccountsFlow } from './accounts-flow.js';
import { BudgetFlow } from './budget-flow.js';
import { formatInsight } from './insight-replies.js';
import { ConversationState } from './conversation-state.js';
import { PaymentFlow, UNDO_PREFIX } from './payment-flow.js';
import { RecurringFlow } from './recurring-flow.js';
import { RemindersFlow } from './reminders-flow.js';
import {
  formatHeard,
  formatLatest,
  formatMonthSummary,
  formatParserError,
  formatPendingFooter,
  formatRegistered,
  formatUndone,
  formatUndoneLast,
  WELCOME,
} from './replies.js';

export interface AssistantDeps {
  parser: TransactionParser;
  transactions: TransactionService;
  accounts: AccountService;
  pending: PendingRepository;
  chatState: ChatStateRepository;
  recurring: RecurringService;
  reports: ReportService;
  budgets: BudgetService;
  /** Respostas às perguntas e previsão do mês. */
  insights: Pick<InsightsService, 'answer' | 'forecast'>;
  /** Lembretes avulsos ("me lembra de pagar o IPVA dia 10"). */
  reminders: ReminderService;
  /** Guarda quais avisos de fatura e de conta fixa já saíram. */
  jobState: JobStateRepository;
  logger: Logger;
  /** Relógio injetável, para testar expirações, faturas e gastos fixos. */
  now?: () => Date;
  /** Fuso do usuário, para saber que dia é hoje. Padrão: São Paulo. */
  timeZone?: string;
  /** Planilha Google; ausente quando não configurada. */
  sheets?: SpreadsheetLink;
}

/** O que o assistente usa da sincronização com a planilha. */
export type SpreadsheetLink = Pick<
  SheetSyncService,
  'url' | 'status' | 'syncNow' | 'requestSync' | 'failureMessage' | 'handleAction'
>;

const SPREADSHEET_SYNC_ACTION = 'sh:sync';

const SUMMARY_PREFIX = 'rs:';

/**
 * O "cérebro" do bot, independente de canal. Recebe a mensagem e decide o caminho:
 * um passo de conversa em andamento (ex.: nome do cartão), a IA e o fluxo de pagamento,
 * ou um botão tocado.
 */
export class Assistant implements MessageHandler {
  private readonly payments: PaymentFlow;
  private readonly accountsFlow: AccountsFlow;
  private readonly budgetFlow: BudgetFlow;
  private readonly recurringFlow: RecurringFlow;
  private readonly remindersFlow: RemindersFlow;
  private readonly now: () => Date;
  private readonly today: () => string;

  constructor(private readonly deps: AssistantDeps) {
    this.now = deps.now ?? (() => new Date());
    const timeZone = deps.timeZone ?? 'America/Sao_Paulo';
    this.today = () => toDateOnlyString(this.now(), timeZone);
    const state = new ConversationState(deps.chatState, this.now);

    this.payments = new PaymentFlow({ ...deps, today: this.today });
    this.accountsFlow = new AccountsFlow({
      accounts: deps.accounts,
      state,
      logger: deps.logger,
      today: this.today,
    });
    this.budgetFlow = new BudgetFlow({ ...deps, state, today: this.today });
    this.recurringFlow = new RecurringFlow({
      ...deps,
      payments: this.payments,
      state,
      today: this.today,
      now: this.now,
      interpret: (text) => this.interpret({ text, now: this.now() }),
    });
    this.remindersFlow = new RemindersFlow({
      ...deps,
      payments: this.payments,
      today: this.today,
      now: this.now,
    });
  }

  handleStart(): OutgoingMessage {
    return { text: WELCOME };
  }

  async handleText(message: IncomingTextMessage): Promise<OutgoingMessage> {
    return this.afterChange(await this.routeText(message));
  }

  private async routeText(message: IncomingTextMessage): Promise<OutgoingMessage> {
    // Se o bot acabou de perguntar algo (ex.: "Qual o nome do cartão?"), o texto é a resposta.
    const flowReply =
      (await this.accountsFlow.handleText(message.text)) ??
      (await this.budgetFlow.handleText(message.text)) ??
      (await this.recurringFlow.handleText(message.text));
    if (flowReply) return flowReply;

    return this.process({
      // `receivedAt` (e não "agora"): mensagens que ficaram na fila enquanto o bot estava
      // desligado têm "ontem" resolvido em relação a quando foram enviadas.
      parseInput: { text: message.text, now: message.receivedAt },
      source: 'TEXT',
      rawInputFor: () => message.text,
    });
  }

  async handleAudio(message: IncomingAudioMessage): Promise<OutgoingMessage> {
    return this.afterChange(await this.processAudio(message));
  }

  private processAudio(message: IncomingAudioMessage): Promise<OutgoingMessage> {
    return this.process({
      parseInput: { audio: message.audio, mimeType: message.mimeType, now: message.receivedAt },
      source: 'AUDIO',
      // Para áudio, o que fica registrado para auditoria é a transcrição feita pela IA.
      rawInputFor: (result) => {
        if (result.transcript) return result.transcript;
        this.deps.logger.warn('ia: áudio registrado sem transcrição');
        return '[áudio sem transcrição]';
      },
    });
  }

  /**
   * Chama a IA com o contexto do usuário (cartões e destinos de investimento já usados).
   * Erros da IA viram uma mensagem pronta para responder.
   */
  private async interpret(input: ParseInput): Promise<ParseResult | OutgoingMessage> {
    const { parser, accounts, reports, logger } = this.deps;
    try {
      const [known, investments] = await Promise.all([
        accounts.listActive(),
        reports.investments(),
      ]);
      const result = await parser.parse({
        ...input,
        accounts: known.map(({ name, kind }) => ({ name, kind })),
        investmentDestinations: investments.map((p) => p.destination),
      });
      logger.debug(
        { intent: result.intent, count: result.transactions.length },
        'ia: interpretado',
      );
      return result;
    } catch (error) {
      if (error instanceof TransactionParserError) {
        logger.error({ err: error, rawResponse: error.rawResponse }, `ia: ${error.reason}`);
        return { text: formatParserError(error.reason) };
      }
      throw error;
    }
  }

  /** Fluxo comum a texto e áudio: interpretar → salvar ou perguntar → responder. */
  private async process({
    parseInput,
    source,
    rawInputFor,
  }: {
    parseInput: ParseInput;
    source: InputSource;
    rawInputFor: (result: ParseResult) => string;
  }): Promise<OutgoingMessage> {
    const result = await this.interpret(parseInput);
    if (!('intent' in result)) return result;

    // No áudio, mostrar o que a IA ouviu ajuda a entender um registro errado.
    const heard = source === 'AUDIO' && result.transcript ? formatHeard(result.transcript) : '';

    // Pergunta: a IA só entendeu o que foi perguntado; a conta é do bot.
    if (result.intent === 'query' && result.query) {
      const [answer, accounts] = await Promise.all([
        this.deps.insights.answer(result.query),
        this.deps.accounts.listAll(),
      ]);
      const text = formatInsight(answer, new Map(accounts.map((a) => [a.id, a])));
      return this.withPendingFooter({ text: heard + text }, null);
    }

    if (result.intent === 'reminder' && result.reminder) {
      const reply = await this.remindersFlow.create(result.reminder);
      return this.withPendingFooter({ ...reply, text: heard + reply.text }, null);
    }

    // "clarify" e "other" nunca salvam nada: só repassam a resposta da IA.
    if (result.intent !== 'register') {
      return this.withPendingFooter({ text: heard + result.reply }, null);
    }

    const { message, pendingId } = await this.payments.start({
      drafts: result.transactions,
      rawInput: rawInputFor(result),
      source,
      receivedAt: parseInput.now,
    });
    return this.withPendingFooter({ ...message, text: heard + message.text }, pendingId);
  }

  async handleAction(actionId: string): Promise<ActionReply> {
    if (actionId === SPREADSHEET_SYNC_ACTION) {
      await this.deps.sheets?.syncNow({ force: true });
      return { mode: 'replace', ...(await this.handleSpreadsheet()) };
    }
    return this.afterChange(await this.routeAction(actionId));
  }

  private async routeAction(actionId: string): Promise<ActionReply> {
    if (actionId.startsWith(UNDO_PREFIX)) return this.undoBatch(actionId);
    if (actionId.startsWith(SUMMARY_PREFIX)) {
      const month = actionId.slice(SUMMARY_PREFIX.length);
      if (/^\d{4}-\d{2}$/.test(month))
        return { mode: 'replace', ...(await this.handleSummary(month)) };
    }

    const reply =
      (await this.deps.sheets?.handleAction(actionId)) ??
      (await this.payments.handleAction(actionId)) ??
      (await this.accountsFlow.handleAction(actionId)) ??
      (await this.budgetFlow.handleAction(actionId)) ??
      (await this.recurringFlow.handleAction(actionId)) ??
      (await this.remindersFlow.handleAction(actionId));
    if (reply) return reply;

    this.deps.logger.warn({ actionId }, 'ação desconhecida');
    return { mode: 'append', text: 'Esse botão não é mais válido.' };
  }

  async handleLatest(): Promise<OutgoingMessage> {
    const [transactions, accounts] = await Promise.all([
      this.deps.transactions.listLatest(10),
      this.deps.accounts.listAll(),
    ]);
    return {
      text: formatLatest(transactions, new Map(accounts.map((account) => [account.id, account]))),
    };
  }

  async handleUndoLast(): Promise<OutgoingMessage> {
    const deleted = await this.deps.transactions.undoLast();
    if (deleted) {
      this.deps.logger.info({ id: deleted.id }, 'último lançamento desfeito');
    }
    return this.afterChange({ text: formatUndoneLast(deleted) });
  }

  async handleAccounts(): Promise<OutgoingMessage> {
    await this.accountsFlow.clear();
    return this.accountsFlow.menu();
  }

  handlePending(): Promise<OutgoingMessage[]> {
    return this.payments.listPending();
  }

  /** Resumo de um mês (padrão: o atual), com botões para navegar entre meses. */
  async handleSummary(month = this.today().slice(0, 7)): Promise<OutgoingMessage> {
    const { reports, budgets } = this.deps;
    const summary = await reports.month(month);
    const current = this.today().slice(0, 7);
    const [balances, status, forecast] = await Promise.all([
      month === current ? reports.balances() : Promise.resolve([]),
      budgets.status(summary),
      month === current ? this.deps.insights.forecast() : Promise.resolve(undefined),
    ]);
    const navigation = [
      { label: '◀ Mês anterior', id: `${SUMMARY_PREFIX}${addMonths(month, -1)}` },
    ];
    if (month < current) {
      navigation.push({ label: 'Mês seguinte ▶', id: `${SUMMARY_PREFIX}${addMonths(month, 1)}` });
    }
    return {
      text: formatMonthSummary(summary, balances, status, forecast),
      actions: [navigation],
    };
  }

  handleBudgets(): Promise<OutgoingMessage> {
    return this.budgetFlow.menu();
  }

  handleRecurring(): Promise<OutgoingMessage> {
    return this.recurringFlow.menu();
  }

  handleReminders(): Promise<OutgoingMessage> {
    return this.remindersFlow.menu();
  }

  /** Avisos das 9h: lembretes avulsos, faturas e contas fixas que vencem amanhã. */
  dueReminders(): Promise<OutgoingMessage[]> {
    return this.remindersFlow.dueNotices();
  }

  handleSpreadsheet(): Promise<OutgoingMessage> {
    const { sheets } = this.deps;
    if (!sheets) {
      return Promise.resolve({
        text: '📄 A planilha ainda não está configurada. O passo a passo está no README do projeto, na seção "Planilha Google".',
      });
    }
    const { lastSyncAt, lastError } = sheets.status();
    const lines = [`📄 Sua planilha:\n${sheets.url()}`, ''];
    lines.push(
      lastSyncAt
        ? `Última sincronização: ${this.formatTime(lastSyncAt)}`
        : 'Ainda não sincronizou desde que o bot ligou.',
    );
    if (lastError) lines.push('', sheets.failureMessage(lastError));
    return Promise.resolve({
      text: lines.join('\n'),
      actions: [[{ label: '🔄 Sincronizar agora', id: SPREADSHEET_SYNC_ACTION }]],
    });
  }

  handleCharts(): Promise<OutgoingMessage> {
    const { sheets } = this.deps;
    if (!sheets) return this.handleSpreadsheet();
    return Promise.resolve({
      text: `📊 Seu painel, com os gráficos (atualizado a cada lançamento):\n${sheets.url('dashboard')}`,
    });
  }

  /** Depois de qualquer mudança, pede para a planilha sincronizar (junta mudanças seguidas). */
  private afterChange<T>(reply: T): T {
    this.deps.sheets?.requestSync();
    return reply;
  }

  private formatTime(date: Date): string {
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: this.deps.timeZone ?? 'America/Sao_Paulo',
    }).format(date);
  }

  /**
   * Aviso do dia 1: sincroniza a planilha por completo e manda o resumo do mês que fechou,
   * com os links da planilha e dos gráficos.
   */
  async monthClosedMessage(month: string): Promise<OutgoingMessage> {
    const { reports, budgets, sheets } = this.deps;
    const summary = await reports.month(month);
    const [balances, status] = await Promise.all([reports.balances(), budgets.status(summary)]);
    const body = formatMonthSummary(summary, balances, status);
    const title = capitalizeFirst(formatMonthLong(month));

    if (!sheets) return { text: `🗓️ ${title} fechado!\n\n${body}` };

    await sheets.syncNow({ force: true });
    const { lastError } = sheets.status();
    const header = lastError
      ? `🗓️ ${title} fechado!\n${sheets.failureMessage(lastError)}`
      : `🗓️ ${title} fechado! A planilha e os gráficos estão 100% atualizados.`;
    return {
      text: `${header}\n\n${body}\n\n📊 Painel: ${sheets.url('dashboard')}\n📄 Planilha: ${sheets.url()}`,
    };
  }

  /** Mensagens avisando dos gastos fixos que a tarefa automática acabou de lançar. */
  async announceRecurring(runs: readonly RecurringRun[]): Promise<OutgoingMessage[]> {
    if (runs.length === 0) return [];
    const accounts = new Map((await this.deps.accounts.listAll()).map((a) => [a.id, a]));
    return runs.map(({ batch }) => ({
      text: `🔁 Lancei um gasto fixo:\n\n${formatRegistered(batch.transactions, accounts)}`,
      actions: [[{ label: '↩️ Desfazer', id: `${UNDO_PREFIX}${batch.batchId}` }]],
    }));
  }

  private async undoBatch(actionId: string): Promise<ActionReply> {
    const batchId = actionId.slice(UNDO_PREFIX.length);
    // Valida antes de ir ao banco: um id malformado viraria erro de sintaxe de UUID no Postgres.
    if (!z.uuid().safeParse(batchId).success) {
      this.deps.logger.warn({ actionId }, 'ação desconhecida');
      return { mode: 'append', text: 'Esse botão não é mais válido.' };
    }

    const count = await this.deps.transactions.undoBatch(batchId);
    this.deps.logger.info({ batchId, count }, 'lote desfeito');
    return { mode: 'append', text: formatUndone(count) };
  }

  /** Lembra das outras perguntas em aberto, sem contar a que acabou de ser feita. */
  private async withPendingFooter(
    message: OutgoingMessage,
    justCreatedId: number | null,
  ): Promise<OutgoingMessage> {
    const others = (await this.payments.countPending()) - (justCreatedId === null ? 0 : 1);
    return { ...message, text: message.text + formatPendingFooter(others) };
  }
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
