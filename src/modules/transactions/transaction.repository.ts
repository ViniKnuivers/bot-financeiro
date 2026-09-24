import type { Prisma, PrismaClient, Transaction } from '../../generated/prisma/client.js';
import type { CreditPurchase } from '../accounts/credit-invoice.js';
import type {
  Category,
  InputSource,
  PaymentMethod,
  TransactionType,
} from '../../generated/prisma/enums.js';

export type { Transaction } from '../../generated/prisma/client.js';

export interface NewTransaction {
  type: TransactionType;
  amountCents: number;
  description: string;
  category: Category;
  paymentMethod: PaymentMethod | null;
  occurredAt: Date;
  rawInput: string;
  source: InputSource;
  accountId: number | null;
  installments: number;
}

export interface AccountTotals {
  incomeCents: number;
  expenseCents: number;
}

/** Acesso a dados isolado atrás de uma interface: o service é testável sem banco. */
export interface TransactionRepository {
  createBatch(batchId: string, items: NewTransaction[]): Promise<Transaction[]>;
  /** Retorna quantas transações foram apagadas (0 se o lote já não existia). */
  deleteBatch(batchId: string): Promise<number>;
  /** Registradas mais recentemente primeiro. */
  findLatest(limit: number): Promise<Transaction[]>;
  /** Apaga a transação registrada mais recentemente e a retorna (null se não houver). */
  deleteLatest(): Promise<Transaction | null>;
  /** Totais de entradas e saídas de uma conta (base do saldo de VR/VA). */
  sumByAccount(accountId: number): Promise<AccountTotals>;
  /** Compras (despesas) de um cartão, para calcular faturas e limite. */
  listPurchasesByAccount(accountId: number): Promise<CreditPurchase[]>;
}

/**
 * Ordem de registro. As transações de um mesmo lote têm o mesmo createdAt (um único
 * INSERT), então o desempate é pelo id: UUIDv7 cresce com o tempo de geração.
 */
const LATEST_FIRST: Prisma.TransactionOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

export class PrismaTransactionRepository implements TransactionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  createBatch(batchId: string, items: NewTransaction[]): Promise<Transaction[]> {
    // Um único INSERT com várias linhas: ou salva o lote inteiro, ou nada.
    return this.prisma.transaction.createManyAndReturn({
      data: items.map((item) => ({ ...item, batchId })),
    });
  }

  async deleteBatch(batchId: string): Promise<number> {
    const { count } = await this.prisma.transaction.deleteMany({ where: { batchId } });
    return count;
  }

  findLatest(limit: number): Promise<Transaction[]> {
    return this.prisma.transaction.findMany({ orderBy: LATEST_FIRST, take: limit });
  }

  async deleteLatest(): Promise<Transaction | null> {
    const latest = await this.prisma.transaction.findFirst({ orderBy: LATEST_FIRST });
    if (!latest) return null;
    // deleteMany (e não delete) para não lançar erro se ela sumir entre as duas queries,
    // por exemplo com um toque simultâneo no botão "Desfazer".
    const { count } = await this.prisma.transaction.deleteMany({ where: { id: latest.id } });
    return count > 0 ? latest : null;
  }

  async sumByAccount(accountId: number): Promise<AccountTotals> {
    const groups = await this.prisma.transaction.groupBy({
      by: ['type'],
      where: { accountId },
      _sum: { amountCents: true },
    });
    const total = (type: string) =>
      groups.find((group) => group.type === type)?._sum.amountCents ?? 0;
    return { incomeCents: total('INCOME'), expenseCents: total('EXPENSE') };
  }

  listPurchasesByAccount(accountId: number): Promise<CreditPurchase[]> {
    return this.prisma.transaction.findMany({
      where: { accountId, type: 'EXPENSE' },
      select: { amountCents: true, installments: true, occurredAt: true },
    });
  }
}
