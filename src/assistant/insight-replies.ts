import type { TransactionType } from '../generated/prisma/enums.js';
import { formatDayMonth, formatMonthLong } from '../lib/dates.js';
import { formatCents } from '../lib/money.js';
import { accountLabel } from '../modules/accounts/account-kinds.js';
import { daysInMonth } from '../modules/accounts/credit-invoice.js';
import { hasForecast } from '../modules/insights/forecast.js';
import type { CanAffordAnswer, InsightAnswer } from '../modules/insights/insights.service.js';
import type { Period, PeriodTotal, QueryAnswer, QuerySubject } from '../modules/insights/query.js';
import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  PAYMENT_METHOD_LABELS,
} from '../modules/transactions/transaction.labels.js';
import type { AccountsById } from './replies.js';

// Respostas às perguntas ("quanto gastei com uber?"). Os números vêm do bot, nunca da IA.

const TYPE_TITLES: Record<TransactionType, string> = {
  EXPENSE: 'Gastos',
  INCOME: 'Receitas',
  INVESTMENT: 'Aportes',
  REDEMPTION: 'Resgates',
};

const TYPE_NOUNS: Record<TransactionType, string> = {
  EXPENSE: 'gasto',
  INCOME: 'receita',
  INVESTMENT: 'aporte',
  REDEMPTION: 'resgate',
};

const TYPE_TITLE_ICONS: Record<TransactionType, string> = {
  EXPENSE: '🔎',
  INCOME: '💰',
  INVESTMENT: '📈',
  REDEMPTION: '📤',
};

const RANKING_ROWS = 5;

export function formatInsight(answer: InsightAnswer, accounts: AccountsById): string {
  if (answer.kind === 'can_afford') return formatCanAfford(answer);
  const missing = missingAccount(answer.subject);
  if (missing) return missing;
  switch (answer.kind) {
    case 'total':
      return formatTotal(answer);
    case 'compare':
      return formatCompare(answer);
    case 'ranking':
      return formatRanking(answer);
    case 'list':
      return formatList(answer, accounts);
  }
}

function formatTotal(answer: Extract<QueryAnswer, { kind: 'total' }>): string {
  const { icon, title } = subjectTitle(answer.subject);
  const period = describePeriod(answer.period);
  if (answer.count === 0) return `${icon} Nenhum lançamento de ${lower(title)} em ${period}.`;
  return `${icon} ${title} em ${period}: ${formatCents(answer.totalCents)} (${plural(answer.count, 'lançamento')})`;
}

function formatCompare(answer: Extract<QueryAnswer, { kind: 'compare' }>): string {
  const { icon, title } = subjectTitle(answer.subject);
  const { current, other } = answer;
  const line = (total: PeriodTotal) =>
    `• ${capitalize(describePeriod(total.period))}: ${formatCents(total.totalCents)}`;
  const lines = [`${icon} ${title}`, line(current), line(other)];
  const otherLabel = describePeriod(other.period);

  if (current.totalCents === 0 && other.totalCents === 0) {
    lines.push('Nada nos dois períodos.');
  } else if (other.totalCents === 0) {
    lines.push(`Em ${otherLabel} não teve nada.`);
  } else if (current.totalCents === other.totalCents) {
    lines.push(`= Igual a ${otherLabel}.`);
  } else {
    const percent = Math.round(
      (Math.abs(current.totalCents - other.totalCents) * 100) / other.totalCents,
    );
    lines.push(
      current.totalCents > other.totalCents
        ? `▲ ${percent}% a mais que em ${otherLabel}.`
        : `▼ ${percent}% a menos que em ${otherLabel}.`,
    );
  }
  if (isPartialMonth(current.period) && !isPartialMonth(other.period)) {
    lines.push('(o período atual ainda não acabou)');
  }
  return lines.join('\n');
}

function formatRanking(answer: Extract<QueryAnswer, { kind: 'ranking' }>): string {
  const { icon, title } = subjectTitle(answer.subject);
  const period = describePeriod(answer.period);
  const [top] = answer.rows;
  if (!top) return `${icon} Nenhum lançamento de ${lower(title)} em ${period}.`;

  const label = (key: string) =>
    answer.rankBy === 'month'
      ? capitalize(formatMonthLong(key))
      : `${CATEGORY_ICONS[key as keyof typeof CATEGORY_ICONS]} ${CATEGORY_LABELS[key as keyof typeof CATEGORY_LABELS]}`;
  const header =
    answer.rankBy === 'month'
      ? `${icon} ${title}: o mês com mais foi ${formatMonthLong(top.key)} (${formatCents(top.cents)}).`
      : `${icon} Onde mais foram ${lower(title)} em ${period}: ${label(top.key)} (${formatCents(top.cents)}).`;
  const rows = answer.rows
    .slice(0, RANKING_ROWS)
    .map((row, i) => `${i + 1}. ${label(row.key)}: ${formatCents(row.cents)}`);
  return [header, '', ...rows].join('\n');
}

function formatList(
  answer: Extract<QueryAnswer, { kind: 'list' }>,
  accounts: AccountsById,
): string {
  const { icon, title } = subjectTitle(answer.subject);
  const period = describePeriod(answer.period);
  if (answer.items.length === 0)
    return `${icon} Nenhum lançamento de ${lower(title)} em ${period}.`;

  const item = (tx: (typeof answer.items)[number]) => {
    const account = tx.accountId === null ? undefined : accounts.get(tx.accountId);
    return [
      formatDayMonth(new Date(`${tx.date}T00:00:00.000Z`)),
      tx.description,
      formatCents(tx.amountCents) + (tx.installments > 1 ? ` em ${tx.installments}x` : ''),
      ...(account ? [accountLabel(account)] : []),
    ].join(' · ');
  };

  const [first] = answer.items;
  if (answer.sort === 'largest' && answer.items.length === 1 && first) {
    return `${icon} Maior ${TYPE_NOUNS[answer.subject.type]}${aboutWhat(answer.subject)} em ${period}:\n${item(first)}`;
  }
  const heading =
    answer.sort === 'largest'
      ? `${icon} Maiores ${TYPE_NOUNS[answer.subject.type]}s${aboutWhat(answer.subject)} em ${period}:`
      : `${icon} ${title} em ${period} (${plural(answer.matches, 'lançamento')}):`;
  const lines = [heading, ...answer.items.map((tx) => `• ${item(tx)}`)];
  const rest = answer.matches - answer.items.length;
  if (rest > 0) lines.push(`… e mais ${rest} (a lista completa está na planilha).`);
  return lines.join('\n');
}

function formatCanAfford(answer: CanAffordAnswer): string {
  const header = {
    ok: '✅ Cabe!',
    careful: '⚠️ Cabe, mas com atenção:',
    no: '❌ Melhor não agora:',
  }[answer.verdict];
  const month = formatMonthLong(answer.forecast.month).split(' de ')[0] ?? '';
  const lines = [header];
  if (answer.surplusAfterCents === null) {
    lines.push('• Pago com vale (VR/VA): não mexe na sobra do mês.');
  } else if (!hasForecast(answer.forecast)) {
    lines.push('• Ainda não tenho lançamentos suficientes para prever o mês.');
  } else {
    lines.push(
      `• Previsão de sobra em ${month}: ${formatCents(answer.forecast.surplusCents)} → ${formatCents(answer.surplusAfterCents)}`,
    );
  }
  if (answer.budget) {
    const { category, percentAfter } = answer.budget;
    lines.push(
      `• ${CATEGORY_ICONS[category]} ${CATEGORY_LABELS[category]}: ${percentAfter}% do orçamento depois dessa compra`,
    );
  }
  if (answer.card) {
    const { account, availableAfterCents } = answer.card;
    lines.push(
      availableAfterCents >= 0
        ? `• 💳 ${account.name}: sobram ${formatCents(availableAfterCents)} de limite`
        : `• 💳 ${account.name}: faltam ${formatCents(-availableAfterCents)} de limite`,
    );
  }
  return lines.join('\n');
}

/** Cartão citado que não existe: explica em vez de responder "nenhum lançamento". */
function missingAccount(subject: QuerySubject): string | null {
  if (subject.accountName === null || subject.accounts.length > 0) return null;
  return `Não encontrei o cartão ou conta "${subject.accountName}". Veja os seus em /cartoes.`;
}

function subjectTitle(subject: QuerySubject): { icon: string; title: string } {
  const [category] = subject.categories;
  const icon =
    subject.categories.length === 1 && category
      ? CATEGORY_ICONS[category]
      : TYPE_TITLE_ICONS[subject.type];
  const base = subject.text
    ? capitalize(subject.text)
    : subject.categories.length > 0
      ? subject.categories.map((c) => CATEGORY_LABELS[c]).join(' e ')
      : TYPE_TITLES[subject.type];
  return { icon, title: base + where(subject) };
}

/** " de uber", " em Alimentação" (para "Maior gasto de uber em setembro"). */
function aboutWhat(subject: QuerySubject): string {
  if (subject.text) return ` com ${subject.text}`;
  if (subject.categories.length > 0) {
    return ` em ${subject.categories.map((c) => CATEGORY_LABELS[c]).join(' e ')}`;
  }
  return where(subject);
}

/** " no Itaú (crédito)", " no Pix". */
function where(subject: QuerySubject): string {
  const [account] = subject.accounts;
  if (account) return ` no ${subject.accounts.length === 1 ? accountLabel(account) : account.name}`;
  if (subject.paymentMethod) return ` no ${PAYMENT_METHOD_LABELS[subject.paymentMethod]}`;
  return '';
}

/**
 * "setembro de 2026", "2026", "de jul/2026 a set/2026" ou "de 01/09 a 15/09/2026".
 * Mês começando no dia 1 conta como o mês (mesmo que ainda não tenha acabado).
 */
export function describePeriod(period: Period): string {
  const { start, end } = period;
  const startMonth = start.slice(0, 7);
  const endMonth = end.slice(0, 7);
  const startsMonth = start.endsWith('-01');
  if (startsMonth && startMonth === endMonth) return formatMonthLong(startMonth);
  if (start.endsWith('-01-01') && start.slice(0, 4) === end.slice(0, 4)) return start.slice(0, 4);
  if (startsMonth) return `de ${shortMonth(startMonth)} a ${shortMonth(endMonth)}`;
  const day = (iso: string) => formatDayMonth(new Date(`${iso}T00:00:00.000Z`));
  return `de ${day(start)} a ${day(end)}/${end.slice(0, 4)}`;
}

function shortMonth(month: string): string {
  const [name = '', year = ''] = formatMonthLong(month).split(' de ');
  return `${name.slice(0, 3)}/${year}`;
}

/** Período dentro de um mês só que termina antes do fim dele (ex.: "este mês", até hoje). */
function isPartialMonth(period: Period): boolean {
  const month = period.end.slice(0, 7);
  return period.start.slice(0, 7) === month && Number(period.end.slice(8, 10)) < daysInMonth(month);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
