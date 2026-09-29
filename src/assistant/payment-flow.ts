import type { ActionReply, OutgoingMessage, ReplyAction } from '../channels/message-channel.js';
import type { Category, InputSource, PaymentMethod } from '../generated/prisma/enums.js';
import type { Logger } from '../lib/logger.js';
import { ACCOUNT_KIND_BY_METHOD, normalizeName } from '../modules/accounts/account-kinds.js';
import type { Account } from '../modules/accounts/account.repository.js';
import { hasBalance, type AccountService } from '../modules/accounts/account.service.js';
import { crossedThreshold, type BudgetService } from '../modules/budgets/budget.service.js';
import type { RecurringService } from '../modules/recurring/recurring.service.js';
import { canonicalDestination, monthlyShares } from '../modules/reports/monthly-report.js';
import type { ReportService } from '../modules/reports/report.service.js';
import type { Transaction } from '../modules/transactions/transaction.repository.js';
import {
  applyAccount,
  applyMethod,
  nextQuestion,
  resetMethod,
  resolveDraft,
  type NextQuestion,
} from '../modules/payments/payment-resolver.js';
import type {
  PendingDraft,
  PendingEntry,
  PendingRepository,
} from '../modules/pending/pending.repository.js';
import { PAYMENT_METHOD_LABELS } from '../modules/transactions/transaction.labels.js';
import type { TransactionDraft } from '../modules/transactions/transaction.schemas.js';
import type {
  ResolvedDraft,
  TransactionService,
} from '../modules/transactions/transaction.service.js';
import {
  formatBalances,
  formatBudgetAlert,
  formatCreditAfterPurchase,
  formatInvestmentPosition,
  formatRecurringCreated,
  formatDraftItems,
  formatPaymentQuestion,
  formatRegistered,
  MISSING_ACCOUNT_HINT,
  PAYMENT_METHOD_ICONS,
} from './replies.js';

export const UNDO_PREFIX = 'undo:';

/**
 * Botões da pergunta de pagamento (curtos por causa do limite de 64 bytes):
 * pm:<pendência>:<forma>  escolheu a forma     pa:<pendência>:<conta>  escolheu o cartão
 * pb:<pendência>          voltar para a forma  pc:<pendência>          cancelar
 */
const ACTION_PATTERN = /^p([mabc]):(\d+)(?::([A-Z]+|\d+))?$/;

export interface PaymentFlowDeps {
  pending: PendingRepository;
  accounts: AccountService;
  transactions: TransactionService;
  recurring: RecurringService;
  reports: ReportService;
  budgets: BudgetService;
  logger: Logger;
  /** Hoje ("YYYY-MM-DD") no fuso do usuário, para saber qual fatura está aberta. */
  today: () => string;
}

export interface StartInput {
  drafts: TransactionDraft[];
  rawInput: string;
  source: InputSource;
  receivedAt: Date;
  /** Cadastro de gasto fixo: no fim, cria o fixo em vez de lançar. */
  recurringDay?: number;
}

/**
 * Do rascunho da IA até o lançamento salvo. Se faltar a forma de pagamento ou o cartão,
 * guarda uma pendência e pergunta com botões; só salva quando tudo estiver respondido.
 */
export class PaymentFlow {
  constructor(private readonly deps: PaymentFlowDeps) {}

  /** Retorna a resposta e, se ficou pendente, o id da pendência criada. */
  async start(input: StartInput): Promise<{ message: OutgoingMessage; pendingId: number | null }> {
    const accounts = await this.deps.accounts.listActive();
    const drafts: PendingDraft[] = input.drafts.map((draft) => ({ ...draft, accountId: null }));

    const question = nextQuestion(drafts, accounts);
    if (!question) {
      const message =
        input.recurringDay === undefined
          ? await this.save(drafts, input, accounts)
          : await this.createRecurring(drafts, input.recurringDay, accounts);
      return { message, pendingId: null };
    }

    const { recurringDay, ...rest } = input;
    const entry = await this.deps.pending.create({
      ...rest,
      drafts,
      purpose: recurringDay === undefined ? 'TRANSACTION' : 'RECURRING',
      recurringDay: recurringDay ?? null,
    });
    this.deps.logger.info({ pendingId: entry.id }, 'lançamento pendente: aguardando pagamento');
    return { message: renderQuestion(entry, question), pendingId: entry.id };
  }

  /** Trata os botões pm/pa/pb/pc. Retorna null se o botão não for deste fluxo. */
  async handleAction(actionId: string): Promise<ActionReply | null> {
    const match = ACTION_PATTERN.exec(actionId);
    if (!match) return null;
    const [, kind, pendingIdText, arg] = match;
    const pendingId = Number(pendingIdText);

    const entry = await this.deps.pending.findById(pendingId);
    if (!entry) {
      return { mode: 'replace', text: 'Esse lançamento já foi registrado ou cancelado.' };
    }

    if (kind === 'c') {
      await this.deps.pending.take(pendingId);
      return {
        mode: 'replace',
        text: `❌ Cancelado. Nada foi salvo.\n${formatDraftItems(entry.drafts)}`,
      };
    }

    const accounts = await this.deps.accounts.listActive();
    const current = nextQuestion(entry.drafts, accounts);
    if (!current) return this.finish(entry, entry.drafts, accounts);

    const drafts = applyAnswer(entry.drafts, current, kind, arg);
    if (!drafts) {
      // Botão de uma pergunta antiga (ex.: tocado duas vezes): mostra a pergunta atual.
      return { mode: 'replace', ...renderQuestion(entry, current) };
    }

    const next = nextQuestion(drafts, accounts);
    if (!next) return this.finish(entry, drafts, accounts);

    await this.deps.pending.updateDrafts(pendingId, drafts);
    return { mode: 'replace', ...renderQuestion({ ...entry, drafts }, next) };
  }

  /** Uma mensagem por pendência, com a pergunta e os botões de novo. */
  async listPending(): Promise<OutgoingMessage[]> {
    const entries = await this.deps.pending.list();
    if (entries.length === 0) return [{ text: '✅ Nenhum lançamento esperando resposta.' }];

    const accounts = await this.deps.accounts.listActive();
    const messages: OutgoingMessage[] = [];
    for (const entry of entries) {
      const question = nextQuestion(entry.drafts, accounts);
      // Pode ter ficado resolvida (ex.: um cartão foi removido e sobrou só um).
      messages.push(
        question
          ? renderQuestion(entry, question)
          : await this.finish(entry, entry.drafts, accounts),
      );
    }
    return messages;
  }

  countPending(): Promise<number> {
    return this.deps.pending.count();
  }

  private async finish(
    entry: PendingEntry,
    drafts: PendingDraft[],
    accounts: Account[],
  ): Promise<ActionReply> {
    // Reserva a pendência antes de salvar: um segundo toque não salva em dobro.
    const taken = await this.deps.pending.take(entry.id);
    if (!taken) return { mode: 'replace', text: 'Esse lançamento já foi registrado ou cancelado.' };
    const message =
      entry.purpose === 'RECURRING' && entry.recurringDay !== null
        ? await this.createRecurring(drafts, entry.recurringDay, accounts)
        : await this.save(drafts, entry, accounts);
    return { mode: 'replace', ...message };
  }

  private async save(
    drafts: PendingDraft[],
    meta: { rawInput: string; source: InputSource },
    accounts: Account[],
  ): Promise<OutgoingMessage> {
    const { transactions, logger } = this.deps;

    const resolved = await this.withCanonicalDestinations(resolveAll(drafts, accounts));
    const batch = await transactions.register({
      drafts: resolved,
      rawInput: meta.rawInput,
      source: meta.source,
    });
    logger.info(
      { batchId: batch.batchId, source: meta.source, count: batch.transactions.length },
      'lançamentos salvos',
    );

    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    const parts = [formatRegistered(batch.transactions, accountsById)];

    const balances = await this.accountBalances(batch.transactions, accountsById);
    if (balances.length > 0) parts.push(formatBalances(balances));
    parts.push(...(await this.creditLines(batch.transactions, accountsById)));
    parts.push(...(await this.investmentLines(batch.transactions)));
    parts.push(...(await this.budgetLines(batch.transactions)));

    const missingAccount = batch.transactions.some(
      (t) =>
        t.type === 'EXPENSE' &&
        t.paymentMethod &&
        ACCOUNT_KIND_BY_METHOD[t.paymentMethod] &&
        t.accountId === null,
    );
    if (missingAccount) parts.push(MISSING_ACCOUNT_HINT);

    return {
      text: parts.join('\n\n'),
      // "undo:" + UUID = 41 bytes, dentro do limite de 64 do callback_data do Telegram.
      actions: [[{ label: '↩️ Desfazer', id: `${UNDO_PREFIX}${batch.batchId}` }]],
    };
  }

  /** Uma linha por cartão de crédito usado: fatura aberta e disponível. */
  private async creditLines(
    saved: { accountId: number | null }[],
    accountsById: ReadonlyMap<number, Account>,
  ): Promise<string[]> {
    const cards = uniqueAccounts(saved, accountsById).filter((a) => a.kind === 'CREDIT_CARD');
    const today = this.deps.today();
    return Promise.all(
      cards.map(async (card) =>
        formatCreditAfterPurchase(card, await this.deps.accounts.creditSummary(card, today)),
      ),
    );
  }

  /** Aportes e resgates usam o nome de um destino já existente, quando for o mesmo. */
  private async withCanonicalDestinations(drafts: ResolvedDraft[]): Promise<ResolvedDraft[]> {
    if (!drafts.some((d) => d.type === 'INVESTMENT' || d.type === 'REDEMPTION')) return drafts;
    const known = (await this.deps.reports.investments()).map((p) => p.destination);
    return drafts.map((draft) =>
      draft.type === 'INVESTMENT' || draft.type === 'REDEMPTION'
        ? { ...draft, description: canonicalDestination(draft.description, known) }
        : draft,
    );
  }

  /** Saldo das contas bancárias e dos vales usados. */
  private async accountBalances(
    saved: { accountId: number | null }[],
    accountsById: ReadonlyMap<number, Account>,
  ): Promise<{ account: Account; cents: number }[]> {
    const withBalance = uniqueAccounts(saved, accountsById).filter((a) => hasBalance(a.kind));
    return Promise.all(
      withBalance.map(async (account) => ({
        account,
        cents: await this.deps.accounts.balance(account),
      })),
    );
  }

  /** Depois de um aporte ou resgate: total já investido em cada destino envolvido. */
  private async investmentLines(saved: Transaction[]): Promise<string[]> {
    const destinations = new Set(
      saved
        .filter((t) => t.type === 'INVESTMENT' || t.type === 'REDEMPTION')
        .map((t) => normalizeName(t.description)),
    );
    if (destinations.size === 0) return [];
    const positions = await this.deps.reports.investments();
    return positions
      .filter((p) => destinations.has(normalizeName(p.destination)))
      .map(formatInvestmentPosition);
  }

  /**
   * Alertas de orçamento: se uma despesa deste lote fez a categoria passar de 80% ou de
   * 100% no mês atual. "Antes" = total do mês menos a parte deste lote.
   */
  private async budgetLines(saved: Transaction[]): Promise<string[]> {
    const budgets = await this.deps.budgets.list();
    const month = this.deps.today().slice(0, 7);
    const batchByCategory = new Map<Category, number>();
    for (const t of saved) {
      if (t.type !== 'EXPENSE') continue;
      const share = monthlyShares(t).find((s) => s.month === month)?.cents ?? 0;
      if (share > 0)
        batchByCategory.set(t.category, (batchByCategory.get(t.category) ?? 0) + share);
    }
    const relevant = budgets.filter((b) => batchByCategory.has(b.category));
    if (relevant.length === 0) return [];

    const summary = await this.deps.reports.month(month);
    const spent = new Map(summary.byCategory.map((c) => [c.category, c.cents]));
    return relevant.flatMap((budget) => {
      const after = spent.get(budget.category) ?? 0;
      const before = after - (batchByCategory.get(budget.category) ?? 0);
      const threshold = crossedThreshold(budget.limitCents, before, after);
      return threshold ? [formatBudgetAlert(budget, after, threshold)] : [];
    });
  }

  /** Fim do cadastro de um gasto fixo: cria o fixo (não lança nada agora). */
  private async createRecurring(
    drafts: PendingDraft[],
    dayOfMonth: number,
    accounts: Account[],
  ): Promise<OutgoingMessage> {
    const [draft] = resolveAll(drafts, accounts);
    if (!draft) throw new Error('gasto fixo sem rascunho');
    const today = this.deps.today();
    const entry = await this.deps.recurring.create(
      {
        type: draft.type,
        amountCents: draft.amountCents,
        description: draft.description,
        category: draft.category,
        paymentMethod: draft.paymentMethod,
        accountId: draft.accountId,
        dayOfMonth,
      },
      today,
    );
    this.deps.logger.info({ recurringId: entry.id }, 'gasto fixo cadastrado');
    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    return {
      text: formatRecurringCreated(entry, this.deps.recurring.nextRun(entry, today), accountsById),
      actions: [[{ label: '🔔 Prefiro o lembrete', id: `fx:mode:${entry.id}` }]],
    };
  }
}

/** Troca o nome citado pela IA pela forma e conta decididas (tudo já respondido). */
function resolveAll(drafts: PendingDraft[], accounts: Account[]): ResolvedDraft[] {
  return drafts.map((draft) => {
    const resolution = resolveDraft(draft, accounts);
    if (resolution.status !== 'resolved') {
      throw new Error('rascunho ainda tem pergunta pendente');
    }
    const { account: _mentionedName, ...rest } = draft;
    return { ...rest, paymentMethod: resolution.paymentMethod, accountId: resolution.accountId };
  });
}

/** As contas envolvidas num lote salvo, sem repetir. */
function uniqueAccounts(
  saved: { accountId: number | null }[],
  accountsById: ReadonlyMap<number, Account>,
): Account[] {
  const ids = [...new Set(saved.map((t) => t.accountId))];
  return ids
    .map((id) => (id === null ? undefined : accountsById.get(id)))
    .filter((account): account is Account => account !== undefined);
}

/** Aplica o botão tocado; null se ele não corresponde à pergunta atual. */
function applyAnswer(
  drafts: PendingDraft[],
  { question, indices }: NextQuestion,
  kind: string | undefined,
  arg: string | undefined,
): PendingDraft[] | null {
  if (kind === 'm' && question.status === 'needs_method') {
    const method = question.methods.find((m) => m === arg);
    return method ? applyMethod(drafts, indices, method) : null;
  }
  if (kind === 'a' && question.status === 'needs_account') {
    const account = question.accounts.find((a) => String(a.id) === arg);
    return account ? applyAccount(drafts, indices, account.id) : null;
  }
  if (kind === 'b' && question.status === 'needs_account') {
    return resetMethod(drafts, indices);
  }
  return null;
}

function renderQuestion(entry: PendingEntry, { question, indices }: NextQuestion): OutgoingMessage {
  const asked = entry.drafts.filter((_draft, index) => indices.includes(index));
  const cancel: ReplyAction = { label: '❌ Cancelar', id: `pc:${entry.id}` };

  if (question.status === 'needs_method') {
    const buttons = question.methods.map((method: PaymentMethod) => ({
      label: `${PAYMENT_METHOD_ICONS[method]} ${PAYMENT_METHOD_LABELS[method]}`,
      id: `pm:${entry.id}:${method}`,
    }));
    // Três por linha; "Cancelar" aproveita a última linha se ela tiver espaço.
    const rows = chunk<ReplyAction>(buttons, 3);
    const last = rows.at(-1);
    if (last && last.length < 3) last.push(cancel);
    else rows.push([cancel]);
    return { text: formatPaymentQuestion(asked, question), actions: rows };
  }

  const buttons = question.accounts.map((account) => ({
    label: account.name,
    id: `pa:${entry.id}:${account.id}`,
  }));
  return {
    text: formatPaymentQuestion(asked, question),
    // "Voltar" só faz sentido quando a forma foi escolhida (despesas); receitas e
    // investimentos só perguntam a conta.
    actions: [
      ...chunk(buttons, 2),
      question.paymentMethod === null
        ? [cancel]
        : [{ label: '↩️ Voltar', id: `pb:${entry.id}` }, cancel],
    ],
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}
