import { z } from 'zod';
import {
  TransactionParserError,
  type ParseInput,
  type ParseResult,
  type TransactionParser,
} from '../ai/transaction-parser.js';
import type {
  ActionReply,
  IncomingAudioMessage,
  IncomingTextMessage,
  MessageHandler,
  OutgoingMessage,
} from '../channels/message-channel.js';
import type { InputSource } from '../generated/prisma/enums.js';
import type { Logger } from '../lib/logger.js';
import type { AccountService } from '../modules/accounts/account.service.js';
import type { ChatStateRepository } from '../modules/conversation/chat-state.repository.js';
import type { PendingRepository } from '../modules/pending/pending.repository.js';
import type { TransactionService } from '../modules/transactions/transaction.service.js';
import { AccountsFlow } from './accounts-flow.js';
import { PaymentFlow, UNDO_PREFIX } from './payment-flow.js';
import {
  formatHeard,
  formatLatest,
  formatParserError,
  formatPendingFooter,
  formatUndone,
  formatUndoneLast,
  WELCOME,
} from './replies.js';

export interface AssistantDeps {
  parser: TransactionParser;
  transactions: TransactionService;
  accounts: AccountService;
  pending: PendingRepository;
  chatState: ChatStateRepository;
  logger: Logger;
  /** Relógio injetável, para testar a expiração dos passos de conversa. */
  now?: () => Date;
}

/**
 * O "cérebro" do bot, independente de canal. Recebe a mensagem e decide o caminho:
 * um passo de conversa em andamento (ex.: nome do cartão), a IA e o fluxo de pagamento,
 * ou um botão tocado.
 */
export class Assistant implements MessageHandler {
  private readonly payments: PaymentFlow;
  private readonly accountsFlow: AccountsFlow;

  constructor(private readonly deps: AssistantDeps) {
    this.payments = new PaymentFlow(deps);
    this.accountsFlow = new AccountsFlow({
      accounts: deps.accounts,
      chatState: deps.chatState,
      logger: deps.logger,
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  handleStart(): OutgoingMessage {
    return { text: WELCOME };
  }

  async handleText(message: IncomingTextMessage): Promise<OutgoingMessage> {
    // Se o bot acabou de perguntar algo (ex.: "Qual o nome do cartão?"), o texto é a resposta.
    const flowReply = await this.accountsFlow.handleText(message.text);
    if (flowReply) return flowReply;

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

  /** Fluxo comum a texto e áudio: interpretar → salvar ou perguntar → responder. */
  private async process({
    parseInput,
    source,
    rawInputFor,
  }: {
    parseInput: ParseInput;
    source: InputSource;
    rawInputFor: (result: ParseResult) => string;
  }): Promise<OutgoingMessage> {
    const { parser, accounts, logger } = this.deps;

    let result;
    try {
      const known = await accounts.listActive();
      result = await parser.parse({
        ...parseInput,
        accounts: known.map(({ name, kind }) => ({ name, kind })),
      });
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
      return this.withPendingFooter({ text: heard + result.reply }, null);
    }

    const { message, pendingId } = await this.payments.start({
      drafts: result.transactions,
      rawInput: rawInputFor(result),
      source,
      receivedAt: parseInput.now,
    });
    return this.withPendingFooter({ ...message, text: heard + message.text }, pendingId);
  }

  async handleAction(actionId: string): Promise<ActionReply> {
    if (actionId.startsWith(UNDO_PREFIX)) return this.undoBatch(actionId);

    const reply =
      (await this.payments.handleAction(actionId)) ??
      (await this.accountsFlow.handleAction(actionId));
    if (reply) return reply;

    this.deps.logger.warn({ actionId }, 'ação desconhecida');
    return { mode: 'append', text: 'Esse botão não é mais válido.' };
  }

  async handleLatest(): Promise<OutgoingMessage> {
    const [transactions, accounts] = await Promise.all([
      this.deps.transactions.listLatest(10),
      this.deps.accounts.listAll(),
    ]);
    return {
      text: formatLatest(transactions, new Map(accounts.map((account) => [account.id, account]))),
    };
  }

  async handleUndoLast(): Promise<OutgoingMessage> {
    const deleted = await this.deps.transactions.undoLast();
    if (deleted) {
      this.deps.logger.info({ id: deleted.id }, 'último lançamento desfeito');
    }
    return { text: formatUndoneLast(deleted) };
  }

  async handleAccounts(): Promise<OutgoingMessage> {
    await this.accountsFlow.clear();
    return this.accountsFlow.menu();
  }

  handlePending(): Promise<OutgoingMessage[]> {
    return this.payments.listPending();
  }

  private async undoBatch(actionId: string): Promise<ActionReply> {
    const batchId = actionId.slice(UNDO_PREFIX.length);
    // Valida antes de ir ao banco: um id malformado viraria erro de sintaxe de UUID no Postgres.
    if (!z.uuid().safeParse(batchId).success) {
      this.deps.logger.warn({ actionId }, 'ação desconhecida');
      return { mode: 'append', text: 'Esse botão não é mais válido.' };
    }

    const count = await this.deps.transactions.undoBatch(batchId);
    this.deps.logger.info({ batchId, count }, 'lote desfeito');
    return { mode: 'append', text: formatUndone(count) };
  }

  /** Lembra das outras perguntas em aberto, sem contar a que acabou de ser feita. */
  private async withPendingFooter(
    message: OutgoingMessage,
    justCreatedId: number | null,
  ): Promise<OutgoingMessage> {
    const others = (await this.payments.countPending()) - (justCreatedId === null ? 0 : 1);
    return { ...message, text: message.text + formatPendingFooter(others) };
  }
}
