import type { PrismaClient } from '../../generated/prisma/client.js';

/** Estado simples (valores primitivos), que o Postgres guarda como JSON. */
export type ChatStateValue = Record<string, string | number | boolean | null>;

export interface StoredChatState {
  /** Conteúdo cru; quem lê valida com o próprio schema (ex.: accounts-flow). */
  state: unknown;
  updatedAt: Date;
}

/** Estado de uma conversa de vários passos. Há no máximo um por vez (bot de um usuário). */
export interface ChatStateRepository {
  get(): Promise<StoredChatState | null>;
  set(state: ChatStateValue): Promise<void>;
  clear(): Promise<void>;
}

const SINGLE_ROW_ID = 1;

export class PrismaChatStateRepository implements ChatStateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async get(): Promise<StoredChatState | null> {
    const row = await this.prisma.chatState.findUnique({ where: { id: SINGLE_ROW_ID } });
    return row ? { state: row.state, updatedAt: row.updatedAt } : null;
  }

  async set(state: ChatStateValue): Promise<void> {
    await this.prisma.chatState.upsert({
      where: { id: SINGLE_ROW_ID },
      create: { id: SINGLE_ROW_ID, state },
      update: { state },
    });
  }

  async clear(): Promise<void> {
    await this.prisma.chatState.deleteMany({ where: { id: SINGLE_ROW_ID } });
  }
}
