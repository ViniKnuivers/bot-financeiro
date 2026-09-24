import type { z } from 'zod';
import type {
  ChatStateRepository,
  ChatStateValue,
} from '../modules/conversation/chat-state.repository.js';

/**
 * Um passo esquecido não pode sequestrar mensagens para sempre: depois deste tempo sem
 * resposta, o texto volta a ser tratado como lançamento.
 */
export const CHAT_STATE_TTL_MS = 15 * 60 * 1000;

/**
 * O passo atual de uma conversa com vários passos ("Qual o nome do cartão?"). Vários
 * fluxos compartilham o mesmo espaço (só um passo por vez); cada um lê com o próprio
 * schema e ignora, sem apagar, os passos dos outros.
 */
export class ConversationState {
  constructor(
    private readonly repository: ChatStateRepository,
    private readonly now: () => Date,
  ) {}

  /** O passo atual, se for deste fluxo e não tiver expirado. */
  async read<T>(schema: z.ZodType<T>): Promise<T | null> {
    const stored = await this.repository.get();
    if (!stored) return null;
    if (this.now().getTime() - stored.updatedAt.getTime() > CHAT_STATE_TTL_MS) {
      await this.repository.clear();
      return null;
    }
    const parsed = schema.safeParse(stored.state);
    return parsed.success ? parsed.data : null;
  }

  set(state: ChatStateValue): Promise<void> {
    return this.repository.set(state);
  }

  clear(): Promise<void> {
    return this.repository.clear();
  }
}
