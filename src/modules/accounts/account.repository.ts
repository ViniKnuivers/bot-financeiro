import type { Account, PrismaClient } from '../../generated/prisma/client.js';
import type { AccountKind } from '../../generated/prisma/enums.js';

export type { Account } from '../../generated/prisma/client.js';

export interface NewAccount {
  name: string;
  kind: AccountKind;
  initialBalanceCents: number;
  creditLimitCents: number | null;
  closingDay: number | null;
  dueDay: number | null;
}

/** Campos que podem mudar depois do cadastro. */
export type AccountPatch = Partial<
  Pick<
    Account,
    | 'name'
    | 'initialBalanceCents'
    | 'creditLimitCents'
    | 'closingDay'
    | 'dueDay'
    | 'creditAdjustmentCents'
  >
>;

export interface AccountRepository {
  listActive(): Promise<Account[]>;
  /** Inclui as arquivadas: lançamentos antigos ainda precisam do nome delas. */
  listAll(): Promise<Account[]>;
  createMany(items: NewAccount[]): Promise<Account[]>;
  update(id: number, patch: AccountPatch): Promise<void>;
  archive(id: number): Promise<void>;
}

const DISPLAY_ORDER = [{ kind: 'asc' as const }, { name: 'asc' as const }];

export class PrismaAccountRepository implements AccountRepository {
  constructor(private readonly prisma: PrismaClient) {}

  listActive(): Promise<Account[]> {
    return this.prisma.account.findMany({ where: { archivedAt: null }, orderBy: DISPLAY_ORDER });
  }

  listAll(): Promise<Account[]> {
    return this.prisma.account.findMany({ orderBy: DISPLAY_ORDER });
  }

  createMany(items: NewAccount[]): Promise<Account[]> {
    return this.prisma.account.createManyAndReturn({ data: items });
  }

  async update(id: number, patch: AccountPatch): Promise<void> {
    await this.prisma.account.update({ where: { id }, data: patch });
  }

  async archive(id: number): Promise<void> {
    await this.prisma.account.update({ where: { id }, data: { archivedAt: new Date() } });
  }
}
