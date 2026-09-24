import { z } from 'zod';
import type { ParseResult } from '../ai/transaction-parser.js';
import type { ActionReply, OutgoingMessage, ReplyAction } from '../channels/message-channel.js';
import { formatDateOnly } from '../lib/dates.js';
import type { AccountService } from '../modules/accounts/account.service.js';
import type { RecurringEntry } from '../modules/recurring/recurring.repository.js';
import type { RecurringService } from '../modules/recurring/recurring.service.js';
import { transactionDraftSchema } from '../modules/transactions/transaction.schemas.js';
import type { ConversationState } from './conversation-state.js';
import type { PaymentFlow } from './payment-flow.js';
import { formatRecurringLine } from './replies.js';

const stateSchema = z.discriminatedUnion('flow', [
  z.object({ flow: z.literal('recurring_text') }),
  /** O rascunho já interpretado pela IA, guardado como JSON até o dia ser informado. */
  z.object({ flow: z.literal('recurring_day'), draft: z.string() }),
]);

const CANCEL: ReplyAction = { label: '❌ Cancelar', id: 'fx:cancel' };

export interface RecurringFlowDeps {
  recurring: RecurringService;
  accounts: AccountService;
  payments: PaymentFlow;
  state: ConversationState;
  today: () => string;
  now: () => Date;
  /** Interpreta o texto com a IA (mesmo caminho das mensagens normais). */
  interpret: (text: string) => Promise<ParseResult | OutgoingMessage>;
}

/**
 * Menu /fixos. Botões com prefixo "fx:": add, manage, open:<id>, tog:<id>, rm:<id>,
 * rmok:<id>, list, cancel.
 */
export class RecurringFlow {
  constructor(private readonly deps: RecurringFlowDeps) {}

  async menu(prefix = ''): Promise<OutgoingMessage> {
    const entries = await this.deps.recurring.list();
    const accounts = await this.accountsById();
    const today = this.deps.today();
    const body =
      entries.length > 0
        ? [
            '🔁 Seus gastos fixos',
            '',
            ...entries.map(
              (entry) =>
                `${formatRecurringLine(entry, accounts)}${entry.active ? `\n   próximo: ${this.nextRun(entry, today)}` : ''}`,
            ),
          ].join('\n')
        : 'Você ainda não tem gastos fixos. Cadastre aluguel, assinaturas, academia… e eu lanço sozinho todo mês.';

    const buttons: ReplyAction[] = [{ label: '➕ Adicionar', id: 'fx:add' }];
    if (entries.length > 0) buttons.push({ label: '⚙️ Gerenciar', id: 'fx:manage' });
    return { text: prefix + body, actions: [buttons] };
  }

  async handleAction(actionId: string): Promise<ActionReply | null> {
    if (!actionId.startsWith('fx:')) return null;
    const [command = '', arg = ''] = actionId.slice(3).split(':');

    switch (command) {
      case 'add':
        await this.deps.state.set({ flow: 'recurring_text' });
        return this.replace({
          text: 'Mande o gasto fixo do jeito que você falaria, ex.: "aluguel 1200 no pix" ou "netflix 55 no crédito do itaú".',
          actions: [[CANCEL]],
        });
      case 'manage': {
        const accounts = await this.accountsById();
        const entries = await this.deps.recurring.list();
        return this.replace({
          text: 'Qual você quer gerenciar?',
          actions: [
            ...entries.map((entry) => [
              { label: formatRecurringLine(entry, accounts), id: `fx:open:${entry.id}` },
            ]),
            [{ label: '↩️ Voltar', id: 'fx:list' }],
          ],
        });
      }
      case 'open':
        return this.withEntry(arg, async (entry) => this.details(entry));
      case 'tog':
        return this.withEntry(arg, async (entry) => {
          await this.deps.recurring.setActive(entry.id, !entry.active);
          return this.details({ ...entry, active: !entry.active });
        });
      case 'rm':
        return this.withEntry(arg, (entry) => ({
          text: `Remover o gasto fixo "${entry.description}"? Os lançamentos já feitos continuam salvos.`,
          actions: [
            [
              { label: '🗑️ Sim, remover', id: `fx:rmok:${entry.id}` },
              { label: '↩️ Voltar', id: `fx:open:${entry.id}` },
            ],
          ],
        }));
      case 'rmok':
        return this.withEntry(arg, async (entry) => {
          await this.deps.recurring.remove(entry.id);
          return this.menu(`🗑️ "${entry.description}" removido.\n\n`);
        });
      case 'cancel':
        await this.deps.state.clear();
        return this.replace(await this.menu());
      default:
        return this.replace(await this.menu());
    }
  }

  /** Respostas digitadas: primeiro o gasto, depois o dia do mês. */
  async handleText(text: string): Promise<OutgoingMessage | null> {
    const state = await this.deps.state.read(stateSchema);
    if (!state) return null;

    if (state.flow === 'recurring_text') {
      const result = await this.deps.interpret(text);
      if (!('intent' in result)) return { ...result, actions: [[CANCEL]] };
      const [draft, ...others] = result.transactions;
      if (result.intent !== 'register' || !draft || others.length > 0) {
        return {
          text: 'Mande um gasto fixo de cada vez, com o valor. Ex.: "aluguel 1200 no pix".',
          actions: [[CANCEL]],
        };
      }
      await this.deps.state.set({ flow: 'recurring_day', draft: JSON.stringify(draft) });
      return {
        text: `Em que dia do mês "${draft.description}" é lançado? Digite só o dia, ex.: 5`,
        actions: [[CANCEL]],
      };
    }

    const day = parseDay(text);
    if (day === null) {
      return { text: 'Não entendi o dia. Digite um número de 1 a 31, ex.: 5', actions: [[CANCEL]] };
    }
    const draft = transactionDraftSchema.safeParse(JSON.parse(state.draft));
    await this.deps.state.clear();
    if (!draft.success) return this.menu('Não consegui recuperar esse gasto. Tente de novo.\n\n');

    const { message } = await this.deps.payments.start({
      drafts: [draft.data],
      rawInput: draft.data.description,
      source: 'TEXT',
      receivedAt: this.deps.now(),
      recurringDay: day,
    });
    return message;
  }

  private async details(entry: RecurringEntry): Promise<OutgoingMessage> {
    const accounts = await this.accountsById();
    return {
      text: `${formatRecurringLine(entry, accounts)}${entry.active ? `\npróximo: ${this.nextRun(entry, this.deps.today())}` : ''}`,
      actions: [
        [
          entry.active
            ? { label: '⏸️ Pausar', id: `fx:tog:${entry.id}` }
            : { label: '▶️ Retomar', id: `fx:tog:${entry.id}` },
          { label: '🗑️ Remover', id: `fx:rm:${entry.id}` },
        ],
        [{ label: '↩️ Voltar', id: 'fx:manage' }],
      ],
    };
  }

  private async withEntry(
    idText: string,
    render: (entry: RecurringEntry) => OutgoingMessage | Promise<OutgoingMessage>,
  ): Promise<ActionReply> {
    const entry = /^\d+$/.test(idText) ? await this.deps.recurring.find(Number(idText)) : null;
    if (!entry) return this.replace(await this.menu('Esse gasto fixo não existe mais.\n\n'));
    return this.replace(await render(entry));
  }

  private nextRun(entry: RecurringEntry, today: string): string {
    return formatDateOnly(new Date(`${this.deps.recurring.nextRun(entry, today)}T00:00:00.000Z`));
  }

  private async accountsById() {
    const accounts = await this.deps.accounts.listAll();
    return new Map(accounts.map((account) => [account.id, account]));
  }

  private replace(message: OutgoingMessage): ActionReply {
    return { mode: 'replace', ...message };
  }
}

function parseDay(text: string): number | null {
  const match = /^\s*(?:dia\s+)?(\d{1,2})\s*$/i.exec(text);
  const day = match ? Number(match[1]) : NaN;
  return day >= 1 && day <= 31 ? day : null;
}
