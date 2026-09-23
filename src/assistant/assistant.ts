import { z } from 'zod';
import {
  TransactionParserError,
  type ParseInput,
  type ParseResult,
  type TransactionParser,
} from '../ai/transaction-parser.js';
import type {
  IncomingAudioMessage,
  IncomingTextMessage,
  MessageHandler,
  OutgoingMessage,
} from '../channels/message-channel.js';
import type { InputSource } from '../generated/prisma/enums.js';
import type { Logger } from '../lib/logger.js';
import type { TransactionService } from '../modules/transactions/transaction.service.js';
import {
  formatHeard,
  formatParserError,
  formatRegistered,
  formatUndone,
  WELCOME,
} from './replies.js';

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

  handleText(message: IncomingTextMessage): Promise<OutgoingMessage> {
    return this.process({
      // `receivedAt` (e não "agora"): mensagens que ficaram na fila enquanto o bot estava
      // desligado têm "ontem" resolvido em relação a quando foram enviadas.
      parseInput: { text: message.text, now: message.receivedAt },
      source: 'TEXT',
      rawInputFor: () => message.text,
    });
  }

  handleAudio(message: IncomingAudioMessage): Promise<OutgoingMessage> {
    return this.process({
      parseInput: { audio: message.audio, mimeType: message.mimeType, now: message.receivedAt },
      source: 'AUDIO',
      // Para áudio, o que fica registrado para auditoria é a transcrição feita pela IA.
      rawInputFor: (result) => {
        if (result.transcript) return result.transcript;
        this.deps.logger.warn('ia: áudio registrado sem transcrição');
        return '[áudio sem transcrição]';
      },
    });
  }

  /** Fluxo comum a texto e áudio: interpretar → (talvez) salvar → responder. */
  private async process({
    parseInput,
    source,
    rawInputFor,
  }: {
    parseInput: ParseInput;
    source: InputSource;
    rawInputFor: (result: ParseResult) => string;
  }): Promise<OutgoingMessage> {
    const { parser, transactions, logger } = this.deps;

    let result;
    try {
      result = await parser.parse(parseInput);
    } catch (error) {
      if (error instanceof TransactionParserError) {
        logger.error({ err: error, rawResponse: error.rawResponse }, `ia: ${error.reason}`);
        return { text: formatParserError(error.reason) };
      }
      throw error;
    }

    logger.debug(
      { source, intent: result.intent, count: result.transactions.length },
      'ia: interpretado',
    );
    // No áudio, mostrar o que a IA ouviu ajuda a entender um registro errado.
    const heard = source === 'AUDIO' && result.transcript ? formatHeard(result.transcript) : '';

    // "clarify" e "other" nunca salvam nada: só repassam a resposta da IA.
    if (result.intent !== 'register') {
      return { text: heard + result.reply };
    }

    const batch = await transactions.register({
      drafts: result.transactions,
      rawInput: rawInputFor(result),
      source,
    });
    logger.info(
      { batchId: batch.batchId, source, count: batch.transactions.length },
      'lançamentos salvos',
    );

    return {
      text: heard + formatRegistered(batch.transactions),
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
