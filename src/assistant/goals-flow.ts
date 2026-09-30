import { z } from 'zod';
import type { ActionReply, OutgoingMessage, ReplyAction } from '../channels/message-channel.js';
import { formatMonthShort } from '../lib/dates.js';
import { formatCents, parseBrlToCents } from '../lib/money.js';
import { normalizeName } from '../modules/accounts/account-kinds.js';
import { MAX_GOALS, type GoalService } from '../modules/goals/goal.service.js';
import type { ReportService } from '../modules/reports/report.service.js';
import { chunk } from './budget-flow.js';
import type { ConversationState } from './conversation-state.js';
import { formatGoal } from './goal-replies.js';

const MAX_NAME_LENGTH = 40;

const nameStep = z.object({ flow: z.literal('goal_name') });
const amountStep = z.object({ flow: z.literal('goal_amount'), name: z.string() });
const deadlineStep = z.object({
  flow: z.literal('goal_deadline'),
  name: z.string(),
  target: z.number().int().positive(),
});
const destinationStep = z.object({
  flow: z.literal('goal_destination'),
  name: z.string(),
  target: z.number().int().positive(),
  deadline: z.string().nullable(),
});

const CANCEL: ReplyAction = { label: '❌ Cancelar', id: 'gl:cancel' };

const MONTHS: Record<string, number> = {
  jan: 1,
  janeiro: 1,
  fev: 2,
  fevereiro: 2,
  mar: 3,
  marco: 3,
  abr: 4,
  abril: 4,
  mai: 5,
  maio: 5,
  jun: 6,
  junho: 6,
  jul: 7,
  julho: 7,
  ago: 8,
  agosto: 8,
  set: 9,
  setembro: 9,
  out: 10,
  outubro: 10,
  nov: 11,
  novembro: 11,
  dez: 12,
  dezembro: 12,
};

/**
 * Prazo digitado → "YYYY-MM". Aceita "12/2026", "12/26", "dez/2026", "dezembro de 2026" e
 * só o mês ("dezembro": o próximo dezembro, contando o atual). Mês que já passou: null.
 */
export function parseDeadline(text: string, currentMonth: string): string | null {
  const clean = normalizeName(text)
    .replace(/^ate\s+/, '')
    .replace(/\s+de\s+/, ' ')
    .trim();
  let month: number | undefined;
  let year: number | undefined;

  const numeric = /^(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})$/.exec(clean);
  const named = /^([a-z]+)\.?(?:\s*[/-]?\s*(\d{2}|\d{4}))?$/.exec(clean);
  if (numeric) {
    month = Number(numeric[1]);
    year = Number(numeric[2]);
  } else if (named) {
    month = MONTHS[named[1] ?? ''];
    year = named[2] === undefined ? undefined : Number(named[2]);
  }
  if (month === undefined || month < 1 || month > 12) return null;

  const [currentYear = 0, currentMonthNumber = 0] = currentMonth.split('-').map(Number);
  if (year === undefined) year = month >= currentMonthNumber ? currentYear : currentYear + 1;
  else if (year < 100) year += 2000;

  const result = `${String(year)}-${String(month).padStart(2, '0')}`;
  return result < currentMonth ? null : result;
}

export interface GoalsFlowDeps {
  goals: GoalService;
  reports: ReportService;
  state: ConversationState;
  today: () => string;
}

/**
 * Menu /metas. Botões com prefixo "gl:": new, nodl (sem prazo), dst:<índice|new>, rm,
 * del:<id>, list, cancel.
 */
export class GoalsFlow {
  constructor(private readonly deps: GoalsFlowDeps) {}

  async menu(prefix = ''): Promise<OutgoingMessage> {
    const goals = await this.deps.goals.list();
    const body =
      goals.length > 0
        ? goals.map(formatGoal).join('\n\n')
        : [
            'Você ainda não tem metas. Crie uma (ex.: "Viagem", R$ 5.000 até dezembro) e eu mostro quanto já juntou e quanto guardar por mês.',
            '',
            'O que conta para a meta são os aportes com o nome dela: "guardei 300 pra viagem".',
          ].join('\n');
    const buttons: ReplyAction[] = [];
    if (goals.length < MAX_GOALS) buttons.push({ label: '➕ Nova meta', id: 'gl:new' });
    if (goals.length > 0) buttons.push({ label: '🗑️ Remover', id: 'gl:rm' });
    return { text: prefix + body, ...(buttons.length > 0 ? { actions: [buttons] } : {}) };
  }

  async handleAction(actionId: string): Promise<ActionReply | null> {
    if (!actionId.startsWith('gl:')) return null;
    const [command = '', arg = ''] = actionId.slice(3).split(':');

    switch (command) {
      case 'new':
        await this.deps.state.set({ flow: 'goal_name' });
        return this.replace({
          text: 'Qual o nome da meta? Ex.: Viagem, Reserva de emergência, Notebook',
          actions: [[CANCEL]],
        });
      case 'nodl': {
        const state = await this.deps.state.read(deadlineStep);
        if (!state) return this.replace(await this.menu());
        return this.replace(await this.askDestination(state.name, state.target, null));
      }
      case 'dst': {
        const state = await this.deps.state.read(destinationStep);
        if (!state) return this.replace(await this.menu());
        const options = await this.destinationOptions();
        const destination = arg === 'new' ? state.name : options[Number(arg)];
        if (destination === undefined) return this.replace(await this.menu());
        return this.replace(
          await this.create(state.name, state.target, state.deadline, destination),
        );
      }
      case 'rm': {
        const goals = await this.deps.goals.list();
        return this.replace({
          text: 'Remover qual meta? Os aportes continuam registrados.',
          actions: [
            ...chunk(
              goals.map(({ goal }) => ({ label: goal.name, id: `gl:del:${String(goal.id)}` })),
              2,
            ),
            [{ label: '↩️ Voltar', id: 'gl:list' }],
          ],
        });
      }
      case 'del': {
        const removed = await this.deps.goals.remove(Number(arg));
        return this.replace(await this.menu(removed ? '🗑️ Meta removida.\n\n' : ''));
      }
      case 'cancel':
        await this.deps.state.clear();
        return this.replace(await this.menu());
      default:
        return this.replace(await this.menu());
    }
  }

  /** Nome, valor e prazo digitados, um de cada vez. */
  async handleText(text: string): Promise<OutgoingMessage | null> {
    const { state } = this.deps;

    if (await state.read(nameStep)) {
      const name = text.trim().replace(/\s+/g, ' ');
      if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
        return {
          text: `Um nome curto, de até ${String(MAX_NAME_LENGTH)} letras.`,
          actions: [[CANCEL]],
        };
      }
      const exists = (await this.deps.goals.list()).some(
        ({ goal }) => normalizeName(goal.name) === normalizeName(name),
      );
      if (exists) return { text: `Você já tem a meta ${name}. Outro nome?`, actions: [[CANCEL]] };
      await state.set({ flow: 'goal_amount', name });
      return { text: `Quanto você quer juntar para ${name}? Ex.: 5000`, actions: [[CANCEL]] };
    }

    const amount = await state.read(amountStep);
    if (amount) {
      const cents = parseBrlToCents(text);
      if (cents === null || cents === 0) {
        return { text: 'Não entendi o valor. Digite só o número, ex.: 5000', actions: [[CANCEL]] };
      }
      await state.set({ flow: 'goal_deadline', name: amount.name, target: cents });
      return {
        text: 'Até quando? Ex.: dezembro, 06/2027. Ou toque em Sem prazo.',
        actions: [[{ label: '♾️ Sem prazo', id: 'gl:nodl' }, CANCEL]],
      };
    }

    const deadline = await state.read(deadlineStep);
    if (deadline) {
      const month = parseDeadline(text, this.deps.today().slice(0, 7));
      if (!month) {
        return {
          text: 'Não entendi o prazo (ou ele já passou). Ex.: dezembro, 06/2027.',
          actions: [[{ label: '♾️ Sem prazo', id: 'gl:nodl' }, CANCEL]],
        };
      }
      return this.askDestination(deadline.name, deadline.target, month);
    }

    return null;
  }

  /**
   * Se já existem destinos de aporte (ex.: "Caixinha Nubank"), a meta pode acompanhar um
   * deles; senão, usa aportes com o próprio nome da meta.
   */
  private async askDestination(
    name: string,
    target: number,
    deadline: string | null,
  ): Promise<OutgoingMessage> {
    const options = await this.destinationOptions();
    if (options.length === 0) return this.create(name, target, deadline, name);
    await this.deps.state.set({ flow: 'goal_destination', name, target, deadline });
    return {
      text: `De onde vem o dinheiro de ${name}? Pode ser um investimento que você já tem, ou aportes novos com o nome da meta.`,
      actions: [
        ...chunk(
          options.map((destination, index) => ({
            label: `📈 ${destination}`,
            id: `gl:dst:${String(index)}`,
          })),
          2,
        ),
        [{ label: `🆕 Aportes para "${name}"`, id: 'gl:dst:new' }],
        [CANCEL],
      ],
    };
  }

  /** Destinos de aporte com saldo, em ordem alfabética (o índice vai no botão). */
  private async destinationOptions(): Promise<string[]> {
    return (await this.deps.reports.investments())
      .filter((p) => p.balanceCents > 0)
      .map((p) => p.destination)
      .sort((a, b) => a.localeCompare(b, 'pt-BR'))
      .slice(0, 8);
  }

  private async create(
    name: string,
    target: number,
    deadline: string | null,
    destination: string,
  ): Promise<OutgoingMessage> {
    await this.deps.state.clear();
    await this.deps.goals.create({ name, destination, targetCents: target, deadline });
    const how =
      normalizeName(destination) === normalizeName(name)
        ? `Para somar, registre os aportes com o nome dela: "guardei 300 pra ${name.toLowerCase()}".`
        : `Ela acompanha o saldo de ${destination}: cada aporte ali conta para a meta.`;
    const when = deadline ? ` até ${formatMonthShort(deadline)}` : '';
    return this.menu(`✅ Meta criada: ${name}, ${formatCents(target)}${when}.\n${how}\n\n`);
  }

  private replace(message: OutgoingMessage): ActionReply {
    return { mode: 'replace', ...message };
  }
}
