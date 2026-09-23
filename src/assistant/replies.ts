import type { TransactionParserErrorReason } from '../ai/transaction-parser.js';
import { formatDateOnly } from '../lib/dates.js';
import { formatCents } from '../lib/money.js';
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
  '• recebi 1500 do estágio',
  '',
  'Também entendo mensagens de voz.',
  'Depois de cada registro, você pode tocar em "Desfazer" se algo sair errado.',
].join('\n');

/**
 * Resumo montado a partir do que foi de fato salvo no banco (e não do texto da IA),
 * para o que você lê ser exatamente o que ficou registrado.
 */
export function formatRegistered(transactions: Transaction[]): string {
  const header =
    transactions.length === 1
      ? '✅ Registrado:'
      : `✅ Registrei ${transactions.length} lançamentos:`;

  const items = transactions.map((t) => {
    const icon = t.type === 'INCOME' ? '💰' : '💸';
    const details = [t.description, CATEGORY_LABELS[t.category]];
    const when = [formatDateOnly(t.occurredAt)];
    if (t.paymentMethod) when.push(PAYMENT_METHOD_LABELS[t.paymentMethod]);

    return [
      `${icon} ${TYPE_LABELS[t.type]} · ${formatCents(t.amountCents)}`,
      details.join(' · '),
      `📅 ${when.join(' · ')}`,
    ].join('\n');
  });

  return [header, ...items].join('\n\n');
}

export function formatUndone(count: number): string {
  if (count === 0) return 'Esse registro já tinha sido desfeito.';
  return count === 1
    ? '↩️ Desfeito: 1 lançamento apagado.'
    : `↩️ Desfeito: ${count} lançamentos apagados.`;
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
