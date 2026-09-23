import { randomUUID } from 'node:crypto';
import type { InputSource } from '../../generated/prisma/enums.js';
import { parseDateOnly } from '../../lib/dates.js';
import type { Transaction, TransactionRepository } from './transaction.repository.js';
import type { TransactionDraft } from './transaction.schemas.js';

export interface RegisterInput {
  drafts: TransactionDraft[];
  /** Texto original ou transcrição do áudio, guardado para auditoria. */
  rawInput: string;
  source: InputSource;
}

export interface RegisteredBatch {
  batchId: string;
  transactions: Transaction[];
}

export class TransactionService {
  constructor(
    private readonly repository: TransactionRepository,
    private readonly generateBatchId: () => string = randomUUID,
  ) {}

  /** Salva todas as transações de uma mensagem como um lote, que pode ser desfeito junto. */
  async register({ drafts, rawInput, source }: RegisterInput): Promise<RegisteredBatch> {
    if (drafts.length === 0) {
      throw new Error('register chamado sem transações');
    }

    const batchId = this.generateBatchId();
    const transactions = await this.repository.createBatch(
      batchId,
      drafts.map((draft) => ({
        type: draft.type,
        amountCents: draft.amountCents,
        description: draft.description,
        category: draft.category,
        paymentMethod: draft.paymentMethod,
        occurredAt: parseDateOnly(draft.occurredAt),
        rawInput,
        source,
      })),
    );
    return { batchId, transactions };
  }

  undoBatch(batchId: string): Promise<number> {
    return this.repository.deleteBatch(batchId);
  }

  listLatest(limit = 10): Promise<Transaction[]> {
    return this.repository.findLatest(limit);
  }

  undoLast(): Promise<Transaction | null> {
    return this.repository.deleteLatest();
  }
}
