import { z } from 'zod';
import type { ActionReply, OutgoingMessage, ReplyAction } from '../channels/message-channel.js';
import type { Logger } from '../lib/logger.js';
import { formatCents, parseBrlToCents } from '../lib/money.js';
import { accountLabel } from '../modules/accounts/account-kinds.js';
import type { Account } from '../modules/accounts/account.repository.js';
import {
  AccountError,
  hasBalance,
  type AccountService,
  type NewAccountChoice,
} from '../modules/accounts/account.service.js';
import type { ConversationState } from './conversation-state.js';
import { formatAccountLine, formatMonth } from './replies.js';

const NEW_ACCOUNT_CHOICES = [
  'BANK',
  'CREDIT_CARD',
  'BANK_AND_CREDIT',
  'MEAL_VOUCHER',
  'FOOD_VOUCHER',
] as const satisfies readonly NewAccountChoice[];

const CHOICE_LABELS: Record<NewAccountChoice, string> = {
  BANK: '🏦 Conta (débito/pix)',
  CREDIT_CARD: '💳 Crédito',
  BANK_AND_CREDIT: '🏦💳 Conta + crédito',
  MEAL_VOUCHER: '🍽️ VR',
  FOOD_VOUCHER: '🛒 VA',
};

/** Nome sugerido para vales, oferecido num botão para não precisar digitar. */
const DEFAULT_VOUCHER_NAMES: Partial<Record<NewAccountChoice, string>> = {
  MEAL_VOUCHER: 'VR',
  FOOD_VOUCHER: 'VA',
};

const accountId = z.int();
const creditChoice = z.enum(['CREDIT_CARD', 'BANK_AND_CREDIT']);
const optionalCents = z.int().nullable();

/** Passos em que o próximo texto digitado é uma resposta, e não um lançamento. */
const chatStateSchema = z.discriminatedUnion('flow', [
  z.object({ flow: z.literal('new_account_name'), choice: z.enum(NEW_ACCOUNT_CHOICES) }),
  z.object({
    flow: z.literal('new_account_balance'),
    choice: z.enum(['BANK', 'BANK_AND_CREDIT', 'MEAL_VOUCHER', 'FOOD_VOUCHER']),
    name: z.string(),
  }),
  z.object({
    flow: z.literal('new_account_limit'),
    choice: creditChoice,
    name: z.string(),
    initialBalanceCents: z.int().default(0),
  }),
  z.object({
    flow: z.literal('new_account_closing'),
    choice: creditChoice,
    name: z.string(),
    initialBalanceCents: z.int().default(0),
    limitCents: optionalCents,
  }),
  z.object({ flow: z.literal('adjust_balance'), accountId }),
  z.object({ flow: z.literal('config_limit'), accountId }),
  z.object({ flow: z.literal('config_closing'), accountId, limitCents: optionalCents }),
  z.object({ flow: z.literal('adjust_available'), accountId }),
  z.object({ flow: z.literal('rename'), accountId }),
]);
type ChatState = z.infer<typeof chatStateSchema>;

const CANCEL: ReplyAction = { label: '❌ Cancelar', id: 'ac:cancel' };
const SKIP: ReplyAction = { label: '⏭️ Pular', id: 'ac:skip' };

const LIMIT_QUESTION =
  'Qual o limite do cartão? Ex.: 3000. Se não quiser acompanhar o limite, toque em Pular.';
const CLOSING_QUESTION =
  'Em que dia a fatura fecha? Digite só o dia, ex.: 5. Se não quiser acompanhar a fatura, toque em Pular.';

export interface AccountsFlowDeps {
  accounts: AccountService;
  state: ConversationState;
  logger: Logger;
  /** Hoje ("YYYY-MM-DD") no fuso do usuário. */
  today: () => string;
}

/**
 * Menu /cartoes. Botões com prefixo "ac:":
 * add, new:<tipo>, qn:<tipo> (nome sugerido), skip, manage, open:<id>, ren:<id>,
 * rm:<id>, rmok:<id>, adj:<id>, cfg:<id>, avail:<id>, pay:<id>, payok:<id>:<mês>,
 * list, cancel.
 */
export class AccountsFlow {
  constructor(private readonly deps: AccountsFlowDeps) {}

  async menu(prefix = ''): Promise<OutgoingMessage> {
    const accounts = await this.deps.accounts.listActive();
    const lines = await Promise.all(accounts.map((account) => this.accountLine(account)));
    const body =
      lines.length > 0
        ? ['💳 Seus cartões e contas', '', ...lines].join('\n')
        : 'Você ainda não cadastrou cartões nem contas. Toque em ➕ Adicionar.';

    const buttons: ReplyAction[] = [{ label: '➕ Adicionar', id: 'ac:add' }];
    if (accounts.length > 0) buttons.push({ label: '⚙️ Gerenciar', id: 'ac:manage' });
    return { text: prefix + body, actions: [buttons] };
  }

  /** Esquece qualquer passo em andamento (ex.: ao abrir o menu de novo). */
  clear(): Promise<void> {
    return this.deps.state.clear();
  }

  async handleAction(actionId: string): Promise<ActionReply | null> {
    if (!actionId.startsWith('ac:')) return null;
    const [command = '', arg = '', extra = '', fromId = ''] = actionId.slice(3).split(':');

    switch (command) {
      case 'list':
        return this.replace(await this.menu());
      case 'cancel':
        await this.clear();
        return this.replace(await this.menu());
      case 'add':
        return this.replace({
          text: 'Que tipo de cartão ou conta?',
          actions: [
            [this.choiceButton('BANK'), this.choiceButton('CREDIT_CARD')],
            [this.choiceButton('BANK_AND_CREDIT')],
            [this.choiceButton('MEAL_VOUCHER'), this.choiceButton('FOOD_VOUCHER')],
            [CANCEL],
          ],
        });
      case 'new':
      case 'qn':
        return this.startNewAccount(command, arg);
      case 'skip':
        return this.replace(await this.skip());
      case 'manage':
        return this.replace(await this.manageMenu());
      case 'open':
        return this.withAccount(arg, (account) => this.accountDetails(account));
      case 'ren':
        return this.withAccount(arg, (account) =>
          this.ask(
            { flow: 'rename', accountId: account.id },
            `Qual o novo nome para ${accountLabel(account)}?`,
          ),
        );
      case 'rm':
        return this.withAccount(arg, (account) => ({
          text: `Remover ${accountLabel(account)}? Os lançamentos antigos continuam salvos.`,
          actions: [
            [
              { label: '🗑️ Sim, remover', id: `ac:rmok:${account.id}` },
              { label: '↩️ Voltar', id: `ac:open:${account.id}` },
            ],
          ],
        }));
      case 'rmok':
        return this.withAccount(arg, async (account) => {
          await this.deps.accounts.archive(account.id);
          this.deps.logger.info({ accountId: account.id }, 'conta removida (arquivada)');
          return this.menu(`🗑️ ${accountLabel(account)} removido.\n\n`);
        });
      case 'adj':
        return this.withAccount(arg, (account) =>
          this.ask(
            { flow: 'adjust_balance', accountId: account.id },
            `Qual o saldo atual do ${accountLabel(account)}? Digite o valor, ex.: 230,50`,
          ),
        );
      case 'cfg':
        return this.withAccount(arg, (account) =>
          this.ask({ flow: 'config_limit', accountId: account.id }, LIMIT_QUESTION, [SKIP]),
        );
      case 'avail':
        return this.withAccount(arg, (account) =>
          this.ask(
            { flow: 'adjust_available', accountId: account.id },
            `Quanto está disponível no limite do ${account.name} agora? Veja no app do banco e digite o valor, ex.: 2180,00`,
          ),
        );
      case 'pay':
        return this.withAccount(arg, (account) => this.confirmInvoicePayment(account));
      case 'payok':
        return this.withAccount(arg, (account) => this.payInvoice(account, extra, fromId));
      default:
        return this.replace(await this.menu());
    }
  }

  /**
   * Trata o texto digitado se houver um passo esperando resposta.
   * Retorna null quando não há, e aí o texto segue para a IA como lançamento.
   */
  async handleText(text: string): Promise<OutgoingMessage | null> {
    const state = await this.activeState();
    if (!state) return null;

    switch (state.flow) {
      case 'new_account_name':
        return this.receiveName(state.choice, text);
      case 'new_account_balance': {
        const cents = parseBrlToCents(text);
        if (cents === null)
          return this.invalidAmount(state.choice.startsWith('BANK') ? [SKIP] : []);
        return this.afterBalance(state.choice, state.name, cents);
      }
      case 'new_account_limit': {
        const cents = parsePositiveCents(text);
        if (cents === null) return this.invalidAmount([SKIP]);
        return this.ask(
          { ...state, flow: 'new_account_closing', limitCents: cents },
          CLOSING_QUESTION,
          [SKIP],
        );
      }
      case 'new_account_closing': {
        const day = parseClosingDay(text);
        if (day === null) return this.invalidDay();
        return this.createAccount(state.choice, state.name, {
          initialBalanceCents: state.initialBalanceCents,
          creditLimitCents: state.limitCents,
          closingDay: day,
        });
      }
      case 'config_limit': {
        const cents = parsePositiveCents(text);
        if (cents === null) return this.invalidAmount([SKIP]);
        return this.ask({ ...state, flow: 'config_closing', limitCents: cents }, CLOSING_QUESTION, [
          SKIP,
        ]);
      }
      case 'config_closing': {
        const day = parseClosingDay(text);
        if (day === null) return this.invalidDay();
        return this.saveCreditSettings(state.accountId, state.limitCents, day);
      }
      case 'adjust_balance':
      case 'adjust_available':
      case 'rename':
        return this.updateAccount(state, text);
    }
  }

  private activeState(): Promise<ChatState | null> {
    return this.deps.state.read(chatStateSchema);
  }

  /** Guarda o passo e faz a pergunta. */
  private async ask(
    state: ChatState,
    text: string,
    extra: ReplyAction[] = [],
  ): Promise<OutgoingMessage> {
    await this.deps.state.set(state);
    return { text, actions: [[...extra, CANCEL]] };
  }

  /** "Pular" no saldo da conta, no limite ou no fechamento. */
  private async skip(): Promise<OutgoingMessage> {
    const state = await this.activeState();
    switch (state?.flow) {
      case 'new_account_balance':
        return this.afterBalance(state.choice, state.name, 0);
      case 'new_account_limit':
        return this.ask(
          { ...state, flow: 'new_account_closing', limitCents: null },
          CLOSING_QUESTION,
          [SKIP],
        );
      case 'new_account_closing':
        return this.createAccount(state.choice, state.name, {
          initialBalanceCents: state.initialBalanceCents,
          creditLimitCents: state.limitCents,
          closingDay: null,
        });
      case 'config_limit':
        return this.ask({ ...state, flow: 'config_closing', limitCents: null }, CLOSING_QUESTION, [
          SKIP,
        ]);
      case 'config_closing':
        return this.saveCreditSettings(state.accountId, state.limitCents, null);
      default:
        return this.menu();
    }
  }

  private async startNewAccount(command: string, arg: string): Promise<ActionReply> {
    const choice = NEW_ACCOUNT_CHOICES.find((c) => c === arg);
    if (!choice) return this.replace(await this.menu());

    const suggested = DEFAULT_VOUCHER_NAMES[choice];
    if (command === 'qn' && suggested) {
      return this.replace(await this.receiveName(choice, suggested));
    }

    const suggestion: ReplyAction[] = suggested
      ? [{ label: `Usar "${suggested}"`, id: `ac:qn:${choice}` }]
      : [];
    return this.replace(
      await this.ask(
        { flow: 'new_account_name', choice },
        suggested
          ? `Qual o nome do cartão? Ex.: Flash, Alelo, Caju. Ou use "${suggested}".`
          : 'Qual o nome? Ex.: Itaú, Nubank, Santander.',
        suggestion,
      ),
    );
  }

  private async receiveName(choice: NewAccountChoice, rawName: string): Promise<OutgoingMessage> {
    const name = rawName.trim();
    switch (choice) {
      case 'MEAL_VOUCHER':
      case 'FOOD_VOUCHER':
        return this.ask(
          { flow: 'new_account_balance', choice, name },
          `Qual o saldo atual do ${name}? Digite o valor, ex.: 230,50 (ou 0).`,
        );
      case 'BANK':
      case 'BANK_AND_CREDIT':
        return this.ask(
          { flow: 'new_account_balance', choice, name },
          `Qual o saldo atual da conta ${name}? Veja no app do banco, ex.: 2340,50. Se não quiser acompanhar o saldo, toque em Pular.`,
          [SKIP],
        );
      case 'CREDIT_CARD':
        return this.ask(
          { flow: 'new_account_limit', choice, name, initialBalanceCents: 0 },
          LIMIT_QUESTION,
          [SKIP],
        );
    }
  }

  /** Depois do saldo: "Conta + crédito" ainda pergunta limite e fechamento. */
  private async afterBalance(
    choice: 'BANK' | 'BANK_AND_CREDIT' | 'MEAL_VOUCHER' | 'FOOD_VOUCHER',
    name: string,
    initialBalanceCents: number,
  ): Promise<OutgoingMessage> {
    if (choice === 'BANK_AND_CREDIT') {
      return this.ask(
        { flow: 'new_account_limit', choice, name, initialBalanceCents },
        LIMIT_QUESTION,
        [SKIP],
      );
    }
    return this.createAccount(choice, name, { initialBalanceCents });
  }

  /**
   * Marca a fatura como paga. O dinheiro sai da única conta bancária; se houver mais de
   * uma, pergunta qual (o botão volta aqui com `fromId`).
   */
  private async payInvoice(card: Account, month: string, fromId: string): Promise<OutgoingMessage> {
    if (!/^\d{4}-\d{2}$/.test(month)) return this.accountDetails(card);

    const banks = (await this.deps.accounts.listActive()).filter((a) => a.kind === 'BANK');
    let from: Account | undefined = banks.find((a) => String(a.id) === fromId);
    if (!from && banks.length > 1) {
      return {
        text: `De qual conta saiu o pagamento da fatura de ${formatMonth(month)}?`,
        actions: [
          ...banks.map((bank) => [
            { label: bank.name, id: `ac:payok:${card.id}:${month}:${bank.id}` },
          ]),
          [{ label: '↩️ Voltar', id: `ac:open:${card.id}` }],
        ],
      };
    }
    from ??= banks[0];

    await this.deps.accounts.markInvoicePaid(card, month, from?.id ?? null);
    this.deps.logger.info(
      { accountId: card.id, month, from: from?.id },
      'fatura marcada como paga',
    );
    const source = from ? ` (saiu da conta ${from.name})` : '';
    return this.accountDetails(
      card,
      `✅ Fatura de ${formatMonth(month)} marcada como paga${source}.\n\n`,
    );
  }

  private async createAccount(
    choice: NewAccountChoice,
    name: string,
    options: Parameters<AccountService['create']>[2],
  ): Promise<OutgoingMessage> {
    await this.clear();
    try {
      const created = await this.deps.accounts.create(choice, name, options);
      this.deps.logger.info({ ids: created.map((a) => a.id) }, 'conta cadastrada');
      const labels = created.map((account) => accountLabel(account)).join(' e ');
      return await this.menu(`✅ Cadastrado: ${labels}.\n\n`);
    } catch (error) {
      if (error instanceof AccountError) return this.menu(`⚠️ ${error.message}\n\n`);
      throw error;
    }
  }

  private async saveCreditSettings(
    id: number,
    creditLimitCents: number | null,
    closingDay: number | null,
  ): Promise<OutgoingMessage> {
    await this.clear();
    const account = await this.deps.accounts.findActive(id);
    if (!account) return this.menu('Esse cartão não existe mais.\n\n');
    await this.deps.accounts.configureCredit(account, { creditLimitCents, closingDay });
    const updated = { ...account, creditLimitCents, closingDay };
    return this.accountDetails(updated, '✅ Configuração salva.\n\n');
  }

  /** Passos de um valor só, sobre uma conta existente: saldo, disponível e nome. */
  private async updateAccount(
    state: Extract<ChatState, { flow: 'adjust_balance' | 'adjust_available' | 'rename' }>,
    text: string,
  ): Promise<OutgoingMessage> {
    const cents = state.flow === 'rename' ? null : parseBrlToCents(text);
    if (state.flow !== 'rename' && cents === null) return this.invalidAmount();

    await this.clear();
    const account = await this.deps.accounts.findActive(state.accountId);
    if (!account) return this.menu('Esse cartão não existe mais.\n\n');

    try {
      if (state.flow === 'rename') {
        await this.deps.accounts.rename(account, text);
        return await this.menu(`✅ Renomeado para ${text.trim()}.\n\n`);
      }
      const value = cents ?? 0;
      if (state.flow === 'adjust_balance') {
        await this.deps.accounts.adjustBalance(account, value);
        return await this.menu(
          `✅ Saldo do ${accountLabel(account)} ajustado para ${formatCents(value)}.\n\n`,
        );
      }
      await this.deps.accounts.adjustAvailable(account, value, this.deps.today());
      return await this.menu(
        `✅ Disponível do ${account.name} ajustado para ${formatCents(value)}.\n\n`,
      );
    } catch (error) {
      if (error instanceof AccountError) return this.menu(`⚠️ ${error.message}\n\n`);
      throw error;
    }
  }

  private async confirmInvoicePayment(account: Account): Promise<OutgoingMessage> {
    const summary = await this.deps.accounts.creditSummary(account, this.deps.today());
    const invoice = summary?.oldestUnpaidClosed;
    if (!invoice) return this.accountDetails(account, 'Não há fatura fechada em aberto.\n\n');

    return {
      text: `Marcar a fatura de ${formatMonth(invoice.month)} do ${account.name} (${formatCents(invoice.cents)}) como paga? Isso libera esse valor no disponível.`,
      actions: [
        [
          { label: '✅ Sim, paguei', id: `ac:payok:${account.id}:${invoice.month}` },
          { label: '↩️ Voltar', id: `ac:open:${account.id}` },
        ],
      ],
    };
  }

  private async manageMenu(): Promise<OutgoingMessage> {
    const accounts = await this.deps.accounts.listActive();
    return {
      text: 'Qual você quer gerenciar?',
      actions: [
        ...accounts.map((account) => [
          { label: accountLabel(account), id: `ac:open:${account.id}` },
        ]),
        [{ label: '↩️ Voltar', id: 'ac:list' }],
      ],
    };
  }

  private async accountDetails(account: Account, prefix = ''): Promise<OutgoingMessage> {
    const lines = [await this.accountLine(account)];
    const rows: ReplyAction[][] = [];
    const first: ReplyAction[] = [{ label: '✏️ Renomear', id: `ac:ren:${account.id}` }];

    if (hasBalance(account.kind)) {
      first.push({ label: '✏️ Ajustar saldo', id: `ac:adj:${account.id}` });
    }
    rows.push(first);

    if (account.kind === 'CREDIT_CARD') {
      const settings = [
        account.creditLimitCents === null
          ? 'sem limite informado'
          : `limite ${formatCents(account.creditLimitCents)}`,
        account.closingDay === null ? 'sem dia de fechamento' : `fecha dia ${account.closingDay}`,
      ];
      lines.push(settings.join(' · '));
      rows.push([{ label: '⚙️ Limite e fechamento', id: `ac:cfg:${account.id}` }]);

      const summary = await this.deps.accounts.creditSummary(account, this.deps.today());
      if (summary?.availableCents != null) {
        rows.push([{ label: '✏️ Ajustar disponível', id: `ac:avail:${account.id}` }]);
      }
      const unpaid = summary?.oldestUnpaidClosed;
      if (unpaid) {
        lines.push(
          `⚠️ Fatura de ${formatMonth(unpaid.month)} fechada: ${formatCents(unpaid.cents)}, não marcada como paga.`,
        );
        rows.push([
          {
            label: `💸 Paguei a fatura de ${formatMonth(unpaid.month)}`,
            id: `ac:pay:${account.id}`,
          },
        ]);
      }
    }

    rows.push([
      { label: '🗑️ Remover', id: `ac:rm:${account.id}` },
      { label: '↩️ Voltar', id: 'ac:manage' },
    ]);
    return { text: prefix + lines.join('\n'), actions: rows };
  }

  private async accountLine(account: Account): Promise<string> {
    if (hasBalance(account.kind)) {
      return formatAccountLine(account, {
        balanceCents: await this.deps.accounts.balance(account),
      });
    }
    if (account.kind === 'CREDIT_CARD') {
      return formatAccountLine(account, {
        credit: await this.deps.accounts.creditSummary(account, this.deps.today()),
      });
    }
    return formatAccountLine(account);
  }

  /** Executa `render` para uma conta ativa; se ela não existir mais, volta ao menu. */
  private async withAccount(
    idText: string,
    render: (account: Account) => OutgoingMessage | Promise<OutgoingMessage>,
  ): Promise<ActionReply> {
    const account = /^\d+$/.test(idText)
      ? await this.deps.accounts.findActive(Number(idText))
      : null;
    if (!account) return this.replace(await this.menu('Esse cartão não existe mais.\n\n'));
    return this.replace(await render(account));
  }

  private invalidAmount(extra: ReplyAction[] = []): OutgoingMessage {
    return {
      text: 'Não entendi o valor. Digite só o número, ex.: 230,50',
      actions: [[...extra, CANCEL]],
    };
  }

  private invalidDay(): OutgoingMessage {
    return {
      text: 'Não entendi o dia. Digite só um número de 1 a 31, ex.: 5',
      actions: [[SKIP, CANCEL]],
    };
  }

  private choiceButton(choice: NewAccountChoice): ReplyAction {
    return { label: CHOICE_LABELS[choice], id: `ac:new:${choice}` };
  }

  private replace(message: OutgoingMessage): ActionReply {
    return { mode: 'replace', ...message };
  }
}

function parsePositiveCents(text: string): number | null {
  const cents = parseBrlToCents(text);
  return cents !== null && cents > 0 ? cents : null;
}

function parseClosingDay(text: string): number | null {
  const match = /^\s*(?:dia\s+)?(\d{1,2})\s*$/i.exec(text);
  const day = match ? Number(match[1]) : NaN;
  return day >= 1 && day <= 31 ? day : null;
}
