import type { TransactionParserErrorReason } from '../ai/transaction-parser.js';
import type { PaymentMethod } from '../generated/prisma/enums.js';
import { formatDateOnly, formatDayMonth, formatMonthLong } from '../lib/dates.js';

export { formatMonthLong, formatMonthShort as formatMonth } from '../lib/dates.js';
import { formatCents } from '../lib/money.js';
import {
  ACCOUNT_KIND_ICONS,
  accountLabel,
  normalizeName,
} from '../modules/accounts/account-kinds.js';
import type { Account } from '../modules/accounts/account.repository.js';
import type { CreditSummary } from '../modules/accounts/credit-invoice.js';
import type { BudgetLimit } from '../modules/budgets/budget.repository.js';
import {
  percentOf,
  type BudgetStatus,
  type BudgetThreshold,
} from '../modules/budgets/budget.service.js';
import type { RecurringEntry } from '../modules/recurring/recurring.repository.js';
import {
  forecastBreakdown,
  forecastSentence,
  hasForecast,
  type Forecast,
} from '../modules/insights/forecast.js';
import type { InvestmentPosition, MonthSummary } from '../modules/reports/monthly-report.js';
import type { AccountBalance } from '../modules/reports/report.service.js';
import type { PendingDraft } from '../modules/pending/pending.repository.js';
import type { Question } from '../modules/payments/payment-resolver.js';
import {
  CATEGORY_LABELS,
  PAYMENT_METHOD_LABELS,
  TYPE_ICONS,
  TYPE_LABELS,
} from '../modules/transactions/transaction.labels.js';
import type { Transaction } from '../modules/transactions/transaction.repository.js';

// Textos que o usuário vê. Em texto puro (sem Markdown/HTML) para servir a qualquer canal.

export const WELCOME = [
  'Olá! Eu registro seus gastos e receitas a partir de mensagens.',
  '',
  'É só escrever do jeito que você falaria, por exemplo:',
  '• almoço 32 no pix',
  '• uber 18,50 e café 7',
  '• ontem gastei 120 no mercado',
  '• tênis 300 em 3x no crédito',
  '• recebi 600 de VA',
  '',
  'Também entendo mensagens de voz.',
  'Se faltar a forma de pagamento, eu pergunto. Depois de cada registro, você pode tocar',
  'em "Desfazer" se algo sair errado.',
  '',
  'Investimentos também: "investi 500 no tesouro", "resgatei 200 da caixinha".',
  '',
  'E pode me perguntar sobre seus gastos:',
  '• quanto gastei com uber em setembro?',
  '• gastei mais com delivery que no mês passado?',
  '• qual foi meu maior gasto este mês?',
  '• posso gastar 300 num tênis?',
  '',
  'E lembro você de contas: "me lembra de pagar o IPVA dia 10, 800 reais".',
  '',
  'Comandos:',
  '/resumo: quanto entrou, saiu, sobrou e foi investido no mês',
  '/orcamento: limites por categoria, com aviso ao passar de 80%',
  '/fixos: gastos fixos que eu lanço sozinho (ou lembro) todo mês',
  '/lembretes: contas e faturas que vencem nos próximos dias',
  '/metas: metas de economia ("Viagem": R$ 5.000 até dezembro)',
  '/semana: resumo da semana (chega sozinho todo domingo às 19h)',
  '/retrospectiva: o seu ano em números',
  '/planilha e /grafico: sua planilha Google com tudo (se configurada)',
  '/relatorio: o relatório do mês em PDF',
  '/backup: cópia diária dos seus dados no Google Drive (se configurado)',
  '/cartoes: seus cartões, contas e saldos',
  '/pendentes: lançamentos esperando sua resposta',
  '/ultimos: seus 10 últimos lançamentos',
  '/desfazer: apaga o último lançamento',
].join('\n');

export type AccountsById = ReadonlyMap<number, Account>;

export const PAYMENT_METHOD_ICONS: Record<PaymentMethod, string> = {
  PIX: '⚡',
  DEBITO: '🏧',
  CREDITO: '💳',
  VR: '🍽️',
  VA: '🛒',
  DINHEIRO: '💵',
  OUTRO: '❔',
};

/** "Crédito Santander", "Pix Itaú", "VA" (não repete quando o cartão se chama "VA"). */
function paymentLabel(
  method: PaymentMethod | null,
  accountId: number | null,
  accounts: AccountsById,
): string | null {
  if (!method) return null;
  const methodLabel = PAYMENT_METHOD_LABELS[method];
  const account = accountId === null ? undefined : accounts.get(accountId);
  if (!account || normalizeName(account.name) === normalizeName(methodLabel)) return methodLabel;
  return `${methodLabel} ${account.name}`;
}

function formatAmount(t: { amountCents: number; installments: number }): string {
  return t.installments > 1
    ? `${formatCents(t.amountCents)} em ${t.installments}x`
    : formatCents(t.amountCents);
}

/**
 * Resumo montado a partir do que foi de fato salvo no banco (e não do texto da IA),
 * para o que você lê ser exatamente o que ficou registrado.
 */
export function formatRegistered(transactions: Transaction[], accounts: AccountsById): string {
  const header =
    transactions.length === 1
      ? '✅ Registrado:'
      : `✅ Registrei ${transactions.length} lançamentos:`;

  const items = transactions.map((t) => {
    const icon = TYPE_ICONS[t.type];
    const when = [formatDateOnly(t.occurredAt)];
    const payment = paymentLabel(t.paymentMethod, t.accountId, accounts);
    if (payment) when.push(payment);

    return [
      `${icon} ${TYPE_LABELS[t.type]} · ${formatAmount(t)}`,
      `${t.description} · ${CATEGORY_LABELS[t.category]}`,
      `📅 ${when.join(' · ')}`,
    ].join('\n');
  });

  return [header, ...items].join('\n\n');
}

/** Saldos dos vales depois de um registro: "🛒 Saldo VA: R$ 520,00". */
export function formatBalances(balances: { account: Account; cents: number }[]): string {
  return balances
    .map(({ account, cents }) => {
      const line = `${ACCOUNT_KIND_ICONS[account.kind]} Saldo ${accountLabel(account)}: ${formatCents(cents)}`;
      return cents < 0 ? `⚠️ ${line} (ficou negativo; ajuste em /cartoes)` : line;
    })
    .join('\n');
}

export const MISSING_ACCOUNT_HINT =
  '💡 Cadastre seus cartões em /cartoes para eu saber de qual cartão saiu.';

export function formatLatest(transactions: Transaction[], accounts: AccountsById): string {
  if (transactions.length === 0) {
    return 'Você ainda não tem lançamentos. Manda algo como "almoço 32 no pix".';
  }

  const lines = transactions.map((t) => {
    const icon = TYPE_ICONS[t.type];
    const payment = paymentLabel(t.paymentMethod, t.accountId, accounts);
    return `${formatDayMonth(t.occurredAt)} ${icon} ${formatAmount(t)} · ${t.description} (${CATEGORY_LABELS[t.category]}${payment ? `, ${payment}` : ''})`;
  });
  return ['🧾 Últimos lançamentos (mais recentes primeiro):', '', ...lines].join('\n');
}

export function formatUndoneLast(transaction: Transaction | null): string {
  if (!transaction) return 'Não há lançamentos para desfazer.';

  const t = transaction;
  return [
    '↩️ Apaguei o último lançamento:',
    `${TYPE_LABELS[t.type]} · ${formatAmount(t)} · ${t.description} (${CATEGORY_LABELS[t.category]}) · ${formatDateOnly(t.occurredAt)}`,
  ].join('\n');
}

/** Cabeçalho das respostas a áudio, com o que a IA entendeu. */
export function formatHeard(transcript: string): string {
  return `🎙️ "${transcript}"\n\n`;
}

export function formatUndone(count: number): string {
  if (count === 0) return 'Esse registro já tinha sido desfeito.';
  return count === 1
    ? '↩️ Desfeito: 1 lançamento apagado.'
    : `↩️ Desfeito: ${count} lançamentos apagados.`;
}

/** Os itens a que uma pergunta se refere: "• Cadeira: R$ 500,00". */
export function formatDraftItems(drafts: PendingDraft[]): string {
  return drafts.map((d) => `• ${d.description}: ${formatAmount(d)}`).join('\n');
}

export function formatPaymentQuestion(drafts: PendingDraft[], question: Question): string {
  const plural = drafts.length > 1;
  let title: string;
  if (question.status === 'needs_method') {
    title = plural ? `🤔 Como você pagou estes ${drafts.length}?` : '🤔 Como você pagou?';
  } else if (question.paymentMethod === null) {
    title = drafts.every((d) => d.type === 'INVESTMENT')
      ? '🏦 De qual conta saiu?'
      : '🏦 Em qual conta caiu?';
  } else if (question.paymentMethod === 'CREDITO') {
    title = '💳 Em qual cartão de crédito?';
  } else if (question.paymentMethod === 'PIX' || question.paymentMethod === 'DEBITO') {
    title = `🏦 De qual conta saiu o ${PAYMENT_METHOD_LABELS[question.paymentMethod].toLowerCase()}?`;
  } else {
    title = `Qual cartão de ${PAYMENT_METHOD_LABELS[question.paymentMethod]}?`;
  }
  return `${title}\n${formatDraftItems(drafts)}`;
}

export function formatPendingFooter(count: number): string {
  if (count <= 0) return '';
  return count === 1
    ? '\n\n⏳ 1 lançamento esperando resposta: /pendentes'
    : `\n\n⏳ ${count} lançamentos esperando resposta: /pendentes`;
}

export interface AccountDetails {
  /** Saldo, só para vales. */
  balanceCents?: number;
  /** Fatura e disponível, só para crédito (null se o fechamento não foi configurado). */
  credit?: CreditSummary | null;
}

/** "2026-10-05" → "05/10". */
function formatShortDate(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

/** "fatura R$ 820,00 (fecha 05/10) · disponível R$ 2.180,00" */
function creditDetails(summary: CreditSummary): string {
  const parts = [
    `fatura ${formatCents(summary.openInvoiceCents)} (fecha ${formatShortDate(summary.openInvoiceClosesOn)})`,
  ];
  if (summary.availableCents !== null) {
    parts.push(`disponível ${formatCents(summary.availableCents)}`);
  }
  return parts.join(' · ');
}

/** Linha de uma conta no menu /cartoes. */
export function formatAccountLine(account: Account, details: AccountDetails = {}): string {
  const icon = ACCOUNT_KIND_ICONS[account.kind];
  const label = accountLabel(account);
  switch (account.kind) {
    case 'MEAL_VOUCHER':
    case 'FOOD_VOUCHER':
      return `${icon} ${label}: saldo ${formatCents(details.balanceCents ?? 0)}`;
    case 'BANK':
      return details.balanceCents === undefined
        ? `${icon} ${label}: débito e pix`
        : `${icon} ${label}: saldo ${formatCents(details.balanceCents)}`;
    case 'CREDIT_CARD':
      return details.credit
        ? `${icon} ${label}: ${creditDetails(details.credit)}`
        : `${icon} ${label}: configure o fechamento em ⚙️ Gerenciar`;
  }
}

/** Depois de uma compra no crédito: "💳 Santander: fatura R$ 820,00 (fecha 05/10) · …". */
export function formatCreditAfterPurchase(account: Account, summary: CreditSummary | null): string {
  if (!summary) {
    return `💳 Configure o fechamento do ${account.name} em /cartoes para eu mostrar a fatura.`;
  }
  return `💳 ${account.name}: ${creditDetails(summary)}`;
}

/** "📈 Tesouro Selic: R$ 700,00 investidos no total" */
export function formatInvestmentPosition(position: InvestmentPosition): string {
  return `📈 ${position.destination}: ${formatCents(position.balanceCents)} investidos no total`;
}

export function formatBudgetAlert(
  budget: BudgetLimit,
  spentCents: number,
  threshold: BudgetThreshold,
): string {
  const label = CATEGORY_LABELS[budget.category];
  const amounts = `${formatCents(spentCents)} de ${formatCents(budget.limitCents)}`;
  return threshold === 100
    ? `🚨 ${label}: passou do orçamento do mês (${amounts})`
    : `⚠️ ${label}: ${percentOf(spentCents, budget.limitCents)}% do orçamento do mês (${amounts})`;
}

/** "Aluguel · R$ 1.200,00 · todo dia 5 · Pix Itaú" */
export function formatRecurringLine(entry: RecurringEntry, accounts: AccountsById): string {
  const parts = [
    `${TYPE_ICONS[entry.type]} ${entry.description}`,
    formatCents(entry.amountCents),
    `todo dia ${entry.dayOfMonth}`,
  ];
  const payment = paymentLabel(entry.paymentMethod, entry.accountId, accounts);
  if (payment) parts.push(payment);
  const mode = entry.mode === 'REMIND' ? ' 🔔' : '';
  return parts.join(' · ') + mode + (entry.active ? '' : ' (pausado)');
}

export function formatRecurringCreated(
  entry: RecurringEntry,
  nextRun: string,
  accounts: AccountsById,
): string {
  return [
    '✅ Gasto fixo cadastrado:',
    formatRecurringLine(entry, accounts),
    '',
    `Primeiro lançamento: ${formatDateOnly(new Date(`${nextRun}T00:00:00.000Z`))}. Eu lanço sozinho e aviso.`,
    'Se você paga na mão (boleto, pix), prefira o lembrete: eu aviso na véspera e só lanço quando você tocar em [Paguei].',
    'Para pausar ou remover: /fixos',
  ].join('\n');
}

export function progressBar(percent: number): string {
  const filled = Math.min(10, Math.round(percent / 10));
  return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

export function formatBudgetStatus(status: BudgetStatus): string {
  const warning = status.percent >= 100 ? ' 🚨' : status.percent >= 80 ? ' ⚠️' : '';
  return `${CATEGORY_LABELS[status.category]}: ${formatCents(status.spentCents)} de ${formatCents(status.limitCents)} (${status.percent}%)${warning}\n${progressBar(status.percent)}`;
}

/** Texto do /resumo e do aviso do dia 1. */
export function formatMonthSummary(
  summary: MonthSummary,
  balances: AccountBalance[],
  budgets: BudgetStatus[],
  /** Só no mês atual: a previsão para o fim do mês. */
  forecast?: Forecast,
): string {
  const lines = [
    `📊 ${capitalize(formatMonthLong(summary.month))}`,
    '',
    `💰 Receitas: ${formatCents(summary.incomeCents)}`,
    `💸 Despesas: ${formatCents(summary.expenseCents)}`,
    `✅ Sobra: ${formatCents(summary.surplusCents)}` +
      (summary.redeemedCents > 0 ? ` (com ${formatCents(summary.redeemedCents)} de resgate)` : ''),
    `📈 Investido: ${formatCents(summary.investedCents)}`,
    ...(summary.redeemedCents > 0 ? [`↩️ Resgatado: ${formatCents(summary.redeemedCents)}`] : []),
    `🟢 Livre depois de investir: ${formatCents(summary.freeCents)}`,
  ];
  if (forecast) {
    lines.push('', forecastSentence(forecast));
    if (hasForecast(forecast)) lines.push(forecastBreakdown(forecast));
  }
  if (summary.voucherIncomeCents > 0 || summary.voucherExpenseCents > 0) {
    lines.push(
      `🍽️ VR/VA (fora da sobra): entrou ${formatCents(summary.voucherIncomeCents)}, saiu ${formatCents(summary.voucherExpenseCents)}`,
    );
  }
  if (balances.length > 0) {
    lines.push('', 'Saldos agora:');
    for (const { account, cents } of balances) {
      lines.push(
        `${ACCOUNT_KIND_ICONS[account.kind]} ${accountLabel(account)}: ${formatCents(cents)}`,
      );
    }
  }
  const top = summary.byCategory.slice(0, 5);
  if (top.length > 0) {
    const budgetByCategory = new Map(budgets.map((b) => [b.category, b]));
    lines.push('', 'Maiores gastos:');
    for (const { category, cents } of top) {
      const budget = budgetByCategory.get(category);
      lines.push(
        `• ${CATEGORY_LABELS[category]}: ${formatCents(cents)}${budget ? ` (${budget.percent}% do orçamento)` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const PARSER_ERROR_MESSAGES: Record<TransactionParserErrorReason, string> = {
  timeout: 'A IA demorou demais para responder. Pode mandar de novo?',
  rate_limit:
    'Atingi o limite de uso gratuito da IA por agora. Espera um minutinho e manda de novo.',
  daily_quota:
    'A cota gratuita de hoje da IA acabou em todos os modelos. Ela renova de madrugada (por volta das 4h ou 5h, horário de Brasília). Se precisar, anote e mande de novo amanhã.',
  unavailable: 'A IA está instável no momento. Tenta de novo em alguns instantes.',
  invalid_response: 'Não consegui entender essa direito. Pode reformular? Ex.: "almoço 32 no pix".',
  invalid_api_key: 'A chave do Gemini foi recusada. Confira o GEMINI_API_KEY no .env.',
  unexpected: 'Tive um problema para falar com a IA. O erro foi registrado no log.',
};

export function formatParserError(reason: TransactionParserErrorReason): string {
  return `${PARSER_ERROR_MESSAGES[reason]}\n(Nada foi salvo.)`;
}
