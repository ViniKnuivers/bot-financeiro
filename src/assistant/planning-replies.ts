import { formatDayMonth, formatMonthLong, parseDateOnly, weekdayName } from '../lib/dates.js';
import { formatCents } from '../lib/money.js';
import type { Forecast } from '../modules/insights/forecast.js';
import { forecastSentence } from '../modules/insights/forecast.js';
import type { WeekInsights } from '../modules/insights/insights.service.js';
import type { WeeklyTip } from '../modules/insights/weekly.js';
import type { YearSummary } from '../modules/insights/yearly.js';
import type { GoalProgress } from '../modules/goals/goal.service.js';
import {
  categoryLabelWithIcon,
  CATEGORY_LABELS,
} from '../modules/transactions/transaction.labels.js';
import { formatGoalShort } from './goal-replies.js';

const TOP_CATEGORIES = 5;

const day = (date: string) => formatDayMonth(parseDateOnly(date));

function formatTip(tip: WeeklyTip): string {
  switch (tip.kind) {
    case 'total_up':
      return `Você gastou ${String(tip.percent)}% a mais que a média das últimas 4 semanas (${formatCents(tip.averageCents)}).`;
    case 'total_down':
      return `Você gastou ${String(tip.percent)}% a menos que a média das últimas 4 semanas (${formatCents(tip.averageCents)}). Boa! 👏`;
    case 'category_up':
      return `${CATEGORY_LABELS[tip.category]} subiu: ${formatCents(tip.cents)} contra ${formatCents(tip.averageCents)} de média (+${String(tip.percent)}%).`;
    case 'category_down':
      return `${CATEGORY_LABELS[tip.category]} caiu ${String(tip.percent)}%: ${formatCents(tip.cents)} contra ${formatCents(tip.averageCents)} de média.`;
    case 'quiet_days':
      return `Em ${String(tip.days)} dias da semana não houve nenhum registro. Esqueceu de anotar algo?`;
  }
}

/**
 * Resumo semanal (domingo às 19h e /semana): quanto foi, para onde, e observações
 * calculadas com os números (comparação com as semanas anteriores, orçamentos, previsão
 * e metas).
 */
export function formatWeek(
  insights: WeekInsights,
  extras: { forecast: Forecast | null; goals: GoalProgress[]; partial: boolean },
): string {
  const { summary, tips, tightBudgets } = insights;
  const title = extras.partial
    ? `📅 Sua semana até agora · ${day(summary.start)} a ${day(summary.end)}`
    : `📅 Sua semana · ${day(summary.start)} a ${day(summary.end)}`;

  if (summary.entries === 0) {
    const lines = [
      title,
      '',
      'Nenhum lançamento nesta semana. Se gastou algo, é só me mandar (ex.: "almoço 32 no pix").',
    ];
    if (extras.goals.length > 0) lines.push('', ...extras.goals.map(formatGoalShort));
    return lines.join('\n');
  }

  const lines = [title, ''];
  const average =
    summary.averageExpenseCents !== null
      ? ` (média: ${formatCents(summary.averageExpenseCents)})`
      : '';
  lines.push(`💸 Gastou ${formatCents(summary.expenseCents)}${average}`);
  if (summary.incomeCents > 0) lines.push(`💰 Recebeu ${formatCents(summary.incomeCents)}`);
  if (summary.netInvestedCents > 0) {
    lines.push(`📈 Guardou ${formatCents(summary.netInvestedCents)}`);
  } else if (summary.netInvestedCents < 0) {
    lines.push(`📉 Resgatou ${formatCents(-summary.netInvestedCents)}`);
  }

  const spent = summary.byCategory.filter((c) => c.cents > 0).slice(0, TOP_CATEGORIES);
  if (spent.length > 0) {
    lines.push('', 'Onde foi:');
    for (const c of spent) {
      lines.push(`• ${categoryLabelWithIcon(c.category)}: ${formatCents(c.cents)}`);
    }
  }
  if (summary.biggest) {
    const { description, cents, date } = summary.biggest;
    lines.push(`Maior gasto: ${description}, ${formatCents(cents)} (${weekdayName(date)})`);
  }

  const notes = tips.map(formatTip);
  for (const budget of tightBudgets) {
    notes.push(
      budget.percent >= 100
        ? `Orçamento de ${CATEGORY_LABELS[budget.category]} estourado: ${formatCents(budget.spentCents)} de ${formatCents(budget.limitCents)}.`
        : `Orçamento de ${CATEGORY_LABELS[budget.category]} em ${String(budget.percent)}% (${formatCents(budget.spentCents)} de ${formatCents(budget.limitCents)}).`,
    );
  }
  if (extras.forecast && extras.forecast.basis !== 'none') {
    notes.push(forecastSentence(extras.forecast).replace(/^\S+\s/, ''));
  }
  notes.push(...extras.goals.map((goal) => formatGoalShort(goal).replace(/^🎯 /, 'Meta ')));
  if (notes.length > 0) lines.push('', '💡 Observações', ...notes.map((note) => `• ${note}`));
  return lines.join('\n');
}

function monthName(month: string): string {
  return formatMonthLong(month).split(' de ')[0] ?? month;
}

/** Retrospectiva do ano (1º de janeiro e /retrospectiva). */
export function formatYear(
  summary: YearSummary,
  extras: { partial: boolean; goalsReached: string[] },
): string {
  const since =
    summary.firstActiveMonth && !summary.firstActiveMonth.endsWith('-01')
      ? ` (desde ${monthName(summary.firstActiveMonth)})`
      : '';
  const title = extras.partial
    ? `🗓️ Seu ${summary.year} até agora${since}`
    : `🗓️ Sua retrospectiva de ${summary.year}${since}`;
  if (summary.entries === 0) {
    return `${title}\n\nNenhum lançamento neste ano ainda.`;
  }

  const entries = summary.entries === 1 ? '1 lançamento' : `${String(summary.entries)} lançamentos`;
  const lines = [title, `📝 ${entries}`, ''];
  lines.push(`💰 Recebeu ${formatCents(summary.incomeCents)}`);
  const vouchers =
    summary.voucherExpenseCents > 0
      ? ` (+ ${formatCents(summary.voucherExpenseCents)} em VR/VA)`
      : '';
  lines.push(`💸 Gastou ${formatCents(summary.expenseCents)}${vouchers}`);
  lines.push(
    summary.surplusCents >= 0
      ? `🪙 Sobrou ${formatCents(summary.surplusCents)}`
      : `🔻 Faltou ${formatCents(-summary.surplusCents)}`,
  );
  if (summary.netInvestedCents !== 0) {
    lines.push(`📈 Investiu ${formatCents(summary.netInvestedCents)} (aportes − resgates)`);
  }

  const highlights: string[] = [];
  if (summary.best && summary.worst) {
    highlights.push(
      `🏆 Melhor mês: ${monthName(summary.best.month)} (sobrou ${formatCents(summary.best.surplusCents)})`,
      `📉 Mês mais apertado: ${monthName(summary.worst.month)} (${summary.worst.surplusCents >= 0 ? 'sobrou' : 'faltou'} ${formatCents(Math.abs(summary.worst.surplusCents))})`,
    );
  }
  highlights.push(`📊 Média de gastos: ${formatCents(summary.averageExpenseCents)} por mês`);
  lines.push('', ...highlights);

  if (summary.byCategory.length > 0) {
    lines.push('', 'Para onde foi o dinheiro:');
    summary.byCategory.slice(0, TOP_CATEGORIES).forEach((c, i) => {
      lines.push(
        `${String(i + 1)}. ${categoryLabelWithIcon(c.category)}: ${formatCents(c.cents)} (${String(c.percent)}%)`,
      );
    });
  }

  const facts: string[] = [];
  if (summary.biggest) {
    facts.push(
      `🛍️ Maior gasto: ${summary.biggest.description}, ${formatCents(summary.biggest.cents)} (${day(summary.biggest.date)})`,
    );
  }
  if (summary.mostFrequent) {
    const { description, count, cents } = summary.mostFrequent;
    facts.push(`📍 Mais frequente: ${description} (${String(count)} vezes, ${formatCents(cents)})`);
  }
  if (extras.goalsReached.length > 0) {
    facts.push(`🎯 Metas alcançadas: ${extras.goalsReached.join(', ')}`);
  }
  if (summary.investments.length > 0) {
    const positions = summary.investments
      .slice(0, 4)
      .map((p) => `${p.destination} ${formatCents(p.balanceCents)}`)
      .join(' · ');
    facts.push(
      `💼 ${extras.partial ? 'Investimentos hoje' : 'Investimentos no fim do ano'}: ${positions}`,
    );
  }
  if (summary.previous && summary.previous.expenseCents > 0) {
    const change = Math.round(
      ((summary.expenseCents - summary.previous.expenseCents) / summary.previous.expenseCents) *
        100,
    );
    const previousYear = String(Number(summary.year) - 1);
    facts.push(
      change === 0
        ? `↔️ Gastou o mesmo que em ${previousYear}.`
        : `↔️ Comparado a ${previousYear}: gastou ${String(Math.abs(change))}% a ${change > 0 ? 'mais' : 'menos'}.`,
    );
  }
  if (facts.length > 0) lines.push('', ...facts);
  return lines.join('\n');
}
