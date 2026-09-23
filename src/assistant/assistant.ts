import { TransactionParserError, type TransactionParser } from '../ai/transaction-parser.js';
import type {
  IncomingTextMessage,
  MessageHandler,
  OutgoingMessage,
} from '../channels/message-channel.js';
import { z } from 'zod';
import type { Logger } from '../lib/logger.js';
import type { TransactionService } from '../modules/transactions/transaction.service.js';
import { formatParserError, formatRegistered, formatUndone, WELCOME } from './replies.js';

const UNDO_PREFIX = 'undo:';

export interface AssistantDeps {
  parser: TransactionParser;
  transactions: TransactionService;
  logger: Logger;
}

/**
 * O "cérebro" do bot, independente de canal: recebe a mensagem, pede para a IA
 * interpretar, decide se salva, e monta a resposta.
 */
export class Assistant implements MessageHandler {
  constructor(private readonly deps: AssistantDeps) {}

  handleStart(): OutgoingMessage {
    return { text: WELCOME };
  }

  async handleText(message: IncomingTextMessage): Promise<OutgoingMessage> {
    const { parser, transactions, logger } = this.deps;

    let result;
    try {
      // `receivedAt` (e não "agora"): mensagens que ficaram na fila enquanto o bot estava
      // desligado têm "ontem" resolvido em relação a quando foram enviadas.
      result = await parser.parse({ text: message.text, now: message.receivedAt });
    } catch (error) {
      if (error instanceof TransactionParserError) {
        logger.error({ err: error, rawResponse: error.rawResponse }, `ia: ${error.reason}`);
        return { text: formatParserError(error.reason) };
      }
      throw error;
    }

    logger.debug({ intent: result.intent, count: result.transactions.length }, 'ia: interpretado');

    // "clarify" e "other" nunca salvam nada: só repassam a resposta da IA.
    if (result.intent !== 'register') {
      return { text: result.reply };
    }

    const batch = await transactions.register({
      drafts: result.transactions,
      rawInput: message.text,
      source: 'TEXT',
    });
    logger.info({ batchId: batch.batchId, count: batch.transactions.length }, 'lançamentos salvos');

    return {
      text: formatRegistered(batch.transactions),
      // "undo:" + UUID = 41 bytes, dentro do limite de 64 do callback_data do Telegram.
      actions: [{ label: '↩️ Desfazer', id: `${UNDO_PREFIX}${batch.batchId}` }],
    };
  }

  async handleAction(actionId: string): Promise<OutgoingMessage> {
    const batchId = actionId.startsWith(UNDO_PREFIX) ? actionId.slice(UNDO_PREFIX.length) : '';
    // Valida antes de ir ao banco: um id malformado viraria erro de sintaxe de UUID no Postgres.
    if (!z.uuid().safeParse(batchId).success) {
      this.deps.logger.warn({ actionId }, 'ação desconhecida');
      return { text: 'Esse botão não é mais válido.' };
    }

    const count = await this.deps.transactions.undoBatch(batchId);
    this.deps.logger.info({ batchId, count }, 'lote desfeito');
    return { text: formatUndone(count) };
  }
}
