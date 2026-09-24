import { z } from 'zod';
import type { ActionReply, OutgoingMessage, ReplyAction } from '../channels/message-channel.js';
import { formatCents, parseBrlToCents } from '../lib/money.js';
import type { Logger } from '../lib/logger.js';
import { accountLabel, isVoucher } from '../modules/accounts/account-kinds.js';
import type { Account } from '../modules/accounts/account.repository.js';
import {
  AccountError,
  type AccountService,
  type NewAccountChoice,
} from '../modules/accounts/account.service.js';
import type { ChatStateRepository } from '../modules/conversation/chat-state.repository.js';
import { formatAccountLine } from './replies.js';

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

/** Passos em que o próximo texto digitado é uma resposta, e não um lançamento. */
const chatStateSchema = z.discriminatedUnion('flow', [
  z.object({ flow: z.literal('new_account_name'), choice: z.enum(NEW_ACCOUNT_CHOICES) }),
  z.object({
    flow: z.literal('new_account_balance'),
    choice: z.enum(['MEAL_VOUCHER', 'FOOD_VOUCHER']),
    name: z.string(),
  }),
  z.object({ flow: z.literal('adjust_balance'), accountId: z.int() }),
]);
type ChatState = z.infer<typeof chatStateSchema>;

/**
 * Um passo esquecido não pode sequestrar mensagens para sempre: depois deste tempo sem
 * resposta, o texto volta a ser tratado como lançamento.
 */
export const CHAT_STATE_TTL_MS = 15 * 60 * 1000;

const CANCEL: ReplyAction = { label: '❌ Cancelar', id: 'ac:cancel' };

export interface AccountsFlowDeps {
  accounts: AccountService;
  chatState: ChatStateRepository;
  logger: Logger;
  now?: () => Date;
}

/**
 * Menu /cartoes. Botões com prefixo "ac:":
 * add, new:<tipo>, qn:<tipo> (nome sugerido), manage, open:<id>, rm:<id>, rmok:<id>,
 * adj:<id>, list, cancel.
 */
export class AccountsFlow {
  constructor(private readonly deps: AccountsFlowDeps) {}

  async menu(prefix = ''): Promise<OutgoingMessage> {
    const accounts = await this.deps.accounts.listActive();
    const lines = await Promise.all(
      accounts.map(async (account) =>
        formatAccountLine(
          account,
          isVoucher(account.kind) ? await this.deps.accounts.balance(account) : undefined,
        ),
      ),
    );
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
    return this.deps.chatState.clear();
  }

  async handleAction(actionId: string): Promise<ActionReply | null> {
    if (!actionId.startsWith('ac:')) return null;
    const [command = '', arg = ''] = actionId.slice(3).split(':');

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
      case 'manage':
        return this.replace(await this.manageMenu());
      case 'open':
        return this.withAccount(arg, (account) => this.accountDetails(account));
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
        return this.withAccount(arg, async (account) => {
          await this.deps.chatState.set({ flow: 'adjust_balance', accountId: account.id });
          return {
            text: `Qual o saldo atual do ${accountLabel(account)}? Digite o valor, ex.: 230,50`,
            actions: [[CANCEL]],
          };
        });
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
        if (cents === null) return this.invalidAmount();
        return this.createAccount(state.choice, state.name, cents);
      }
      case 'adjust_balance': {
        const cents = parseBrlToCents(text);
        if (cents === null) return this.invalidAmount();
        const account = await this.deps.accounts.findActive(state.accountId);
        await this.clear();
        if (!account) return this.menu('Esse cartão não existe mais.\n\n');
        await this.deps.accounts.adjustBalance(account, cents);
        return this.menu(
          `✅ Saldo do ${accountLabel(account)} ajustado para ${formatCents(cents)}.\n\n`,
        );
      }
    }
  }

  private async activeState(): Promise<ChatState | null> {
    const stored = await this.deps.chatState.get();
    if (!stored) return null;

    const now = this.deps.now?.() ?? new Date();
    const parsed = chatStateSchema.safeParse(stored.state);
    if (!parsed.success || now.getTime() - stored.updatedAt.getTime() > CHAT_STATE_TTL_MS) {
      await this.clear();
      return null;
    }
    return parsed.data;
  }

  private async startNewAccount(command: string, arg: string): Promise<ActionReply> {
    const choice = NEW_ACCOUNT_CHOICES.find((c) => c === arg);
    if (!choice) return this.replace(await this.menu());

    const suggested = DEFAULT_VOUCHER_NAMES[choice];
    if (command === 'qn' && suggested) {
      return this.replace(await this.receiveName(choice, suggested));
    }

    await this.deps.chatState.set({ flow: 'new_account_name', choice });
    const suggestion: ReplyAction[] = suggested
      ? [{ label: `Usar "${suggested}"`, id: `ac:qn:${choice}` }]
      : [];
    return this.replace({
      text: suggested
        ? `Qual o nome do cartão? Ex.: Flash, Alelo, Caju. Ou use "${suggested}".`
        : 'Qual o nome? Ex.: Itaú, Nubank, Santander.',
      actions: [[...suggestion, CANCEL]],
    });
  }

  private async receiveName(choice: NewAccountChoice, name: string): Promise<OutgoingMessage> {
    if (choice === 'MEAL_VOUCHER' || choice === 'FOOD_VOUCHER') {
      await this.deps.chatState.set({ flow: 'new_account_balance', choice, name: name.trim() });
      return {
        text: `Qual o saldo atual do ${name.trim()}? Digite o valor, ex.: 230,50 (ou 0).`,
        actions: [[CANCEL]],
      };
    }
    return this.createAccount(choice, name, 0);
  }

  private async createAccount(
    choice: NewAccountChoice,
    name: string,
    initialBalanceCents: number,
  ): Promise<OutgoingMessage> {
    try {
      const created = await this.deps.accounts.create(choice, name, initialBalanceCents);
      await this.clear();
      this.deps.logger.info({ ids: created.map((a) => a.id) }, 'conta cadastrada');
      const labels = created.map((account) => accountLabel(account)).join(' e ');
      return await this.menu(`✅ Cadastrado: ${labels}.\n\n`);
    } catch (error) {
      if (error instanceof AccountError) {
        await this.clear();
        return this.menu(`⚠️ ${error.message}\n\n`);
      }
      throw error;
    }
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

  private async accountDetails(account: Account): Promise<OutgoingMessage> {
    const balance = isVoucher(account.kind) ? await this.deps.accounts.balance(account) : undefined;
    const buttons: ReplyAction[] = [];
    if (isVoucher(account.kind))
      buttons.push({ label: '✏️ Ajustar saldo', id: `ac:adj:${account.id}` });
    buttons.push({ label: '🗑️ Remover', id: `ac:rm:${account.id}` });
    return {
      text: formatAccountLine(account, balance),
      actions: [buttons, [{ label: '↩️ Voltar', id: 'ac:manage' }]],
    };
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

  private invalidAmount(): OutgoingMessage {
    return {
      text: 'Não entendi o valor. Digite só o número, ex.: 230,50',
      actions: [[CANCEL]],
    };
  }

  private choiceButton(choice: NewAccountChoice): ReplyAction {
    return { label: CHOICE_LABELS[choice], id: `ac:new:${choice}` };
  }

  private replace(message: OutgoingMessage): ActionReply {
    return { mode: 'replace', ...message };
  }
}
