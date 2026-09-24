import { z } from 'zod';
import type { ActionReply, OutgoingMessage, ReplyAction } from '../channels/message-channel.js';
import { parseBrlToCents } from '../lib/money.js';
import type { BudgetService } from '../modules/budgets/budget.service.js';
import type { ReportService } from '../modules/reports/report.service.js';
import { CATEGORY_LABELS } from '../modules/transactions/transaction.labels.js';
import { EXPENSE_CATEGORIES } from '../modules/transactions/transaction.schemas.js';
import type { ConversationState } from './conversation-state.js';
import { formatBudgetStatus, formatMonthLong } from './replies.js';

const stateSchema = z.object({
  flow: z.literal('budget_amount'),
  category: z.enum(EXPENSE_CATEGORIES),
});

const CANCEL: ReplyAction = { label: '❌ Cancelar', id: 'bg:cancel' };

export interface BudgetFlowDeps {
  budgets: BudgetService;
  reports: ReportService;
  state: ConversationState;
  today: () => string;
}

/**
 * Menu /orcamento. Botões com prefixo "bg:": set, cat:<categoria>, rm, del:<categoria>,
 * list, cancel.
 */
export class BudgetFlow {
  constructor(private readonly deps: BudgetFlowDeps) {}

  async menu(prefix = ''): Promise<OutgoingMessage> {
    const month = this.deps.today().slice(0, 7);
    const status = await this.deps.budgets.status(await this.deps.reports.month(month));
    const body =
      status.length > 0
        ? [`🎯 Orçamento de ${formatMonthLong(month)}`, '', ...status.map(formatBudgetStatus)].join(
            '\n\n',
          )
        : 'Você ainda não definiu nenhum orçamento. Defina um limite mensal para uma categoria e eu aviso quando passar de 80% e de 100%.';

    const buttons: ReplyAction[] = [{ label: '➕ Definir limite', id: 'bg:set' }];
    if (status.length > 0) buttons.push({ label: '🗑️ Remover', id: 'bg:rm' });
    return { text: prefix + body, actions: [buttons] };
  }

  async handleAction(actionId: string): Promise<ActionReply | null> {
    if (!actionId.startsWith('bg:')) return null;
    const [command = '', arg = ''] = actionId.slice(3).split(':');

    switch (command) {
      case 'set':
        return this.replace({
          text: 'Para qual categoria?',
          actions: [
            ...chunk(
              EXPENSE_CATEGORIES.map((category) => ({
                label: CATEGORY_LABELS[category],
                id: `bg:cat:${category}`,
              })),
              3,
            ),
            [CANCEL],
          ],
        });
      case 'cat': {
        const category = EXPENSE_CATEGORIES.find((c) => c === arg);
        if (!category) return this.replace(await this.menu());
        await this.deps.state.set({ flow: 'budget_amount', category });
        return this.replace({
          text: `Qual o limite mensal para ${CATEGORY_LABELS[category]}? Digite o valor, ex.: 800`,
          actions: [[CANCEL]],
        });
      }
      case 'rm': {
        const budgets = await this.deps.budgets.list();
        return this.replace({
          text: 'Remover o orçamento de qual categoria?',
          actions: [
            ...chunk(
              budgets.map((b) => ({
                label: CATEGORY_LABELS[b.category],
                id: `bg:del:${b.category}`,
              })),
              3,
            ),
            [{ label: '↩️ Voltar', id: 'bg:list' }],
          ],
        });
      }
      case 'del': {
        const category = EXPENSE_CATEGORIES.find((c) => c === arg);
        if (category) await this.deps.budgets.remove(category);
        return this.replace(
          await this.menu(
            category ? `🗑️ Orçamento de ${CATEGORY_LABELS[category]} removido.\n\n` : '',
          ),
        );
      }
      case 'cancel':
        await this.deps.state.clear();
        return this.replace(await this.menu());
      default:
        return this.replace(await this.menu());
    }
  }

  /** O valor digitado depois de escolher a categoria. */
  async handleText(text: string): Promise<OutgoingMessage | null> {
    const state = await this.deps.state.read(stateSchema);
    if (!state) return null;

    const cents = parseBrlToCents(text);
    if (cents === null || cents === 0) {
      return { text: 'Não entendi o valor. Digite só o número, ex.: 800', actions: [[CANCEL]] };
    }
    await this.deps.state.clear();
    await this.deps.budgets.set(state.category, cents);
    return this.menu(`✅ Limite de ${CATEGORY_LABELS[state.category]} definido.\n\n`);
  }

  private replace(message: OutgoingMessage): ActionReply {
    return { mode: 'replace', ...message };
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}
