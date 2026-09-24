import type { TransactionParserErrorReason } from '../ai/transaction-parser.js';
import type { PaymentMethod } from '../generated/prisma/enums.js';
import { formatDateOnly, formatDayMonth } from '../lib/dates.js';
import { formatCents } from '../lib/money.js';
import {
  ACCOUNT_KIND_ICONS,
  accountLabel,
  isVoucher,
  normalizeName,
} from '../modules/accounts/account-kinds.js';
import type { Account } from '../modules/accounts/account.repository.js';
import type { PendingDraft } from '../modules/pending/pending.repository.js';
import type { Question } from '../modules/payments/payment-resolver.js';
import {
  CATEGORY_LABELS,
  PAYMENT_METHOD_LABELS,
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
  'Comandos:',
  '/cartoes: seus cartões, contas e saldos de VR/VA',
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
    const icon = t.type === 'INCOME' ? '💰' : '💸';
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
    const icon = t.type === 'INCOME' ? '💰' : '💸';
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

/** Linha de uma conta no menu /cartoes. `balanceCents` só para vales. */
export function formatAccountLine(account: Account, balanceCents?: number): string {
  const icon = ACCOUNT_KIND_ICONS[account.kind];
  if (isVoucher(account.kind)) {
    return `${icon} ${accountLabel(account)}: saldo ${formatCents(balanceCents ?? 0)}`;
  }
  const detail = account.kind === 'BANK' ? ': débito e pix' : '';
  return `${icon} ${accountLabel(account)}${detail}`;
}

const PARSER_ERROR_MESSAGES: Record<TransactionParserErrorReason, string> = {
  timeout: 'A IA demorou demais para responder. Pode mandar de novo?',
  rate_limit:
    'Atingi o limite de uso gratuito da IA por agora. Espera um minutinho e manda de novo.',
  unavailable: 'A IA está instável no momento. Tenta de novo em alguns instantes.',
  invalid_response: 'Não consegui entender essa direito. Pode reformular? Ex.: "almoço 32 no pix".',
  invalid_api_key: 'A chave do Gemini foi recusada. Confira o GEMINI_API_KEY no .env.',
  unexpected: 'Tive um problema para falar com a IA. O erro foi registrado no log.',
};

export function formatParserError(reason: TransactionParserErrorReason): string {
  return `${PARSER_ERROR_MESSAGES[reason]}\n(Nada foi salvo.)`;
}
