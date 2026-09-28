import { z } from 'zod';
import type { JobStateRepository } from '../../jobs/job-state.repository.js';
import type { OutgoingMessage } from '../message-channel.js';

const LAST_INBOUND_KEY = 'whatsapp.lastInboundAt';
const OUTBOX_KEY = 'whatsapp.outbox';
const RECIPIENT_KEY = 'whatsapp.recipient';

/**
 * Regra da Meta: o bot só manda mensagem livre até 24h depois da sua última mensagem.
 * Fora disso, só modelos aprovados. Usamos 23h50 para não errar por pouco.
 */
const WINDOW_MS = 24 * 60 * 60 * 1000 - 10 * 60 * 1000;

const outboxSchema = z.array(
  z.object({
    text: z.string(),
    actions: z.array(z.array(z.object({ label: z.string(), id: z.string() }))).optional(),
  }),
);

/**
 * A janela de 24h e a fila de avisos que chegaram com ela fechada. Tudo no banco
 * (`JobState`), para um reinício do bot não perder avisos nem "reabrir" a janela.
 */
export class WhatsAppWindow {
  constructor(
    private readonly jobState: JobStateRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Você mandou mensagem: a janela abre (ou renova) por 24h. */
  async touch(): Promise<void> {
    await this.jobState.set(LAST_INBOUND_KEY, this.now().toISOString());
  }

  async isOpen(): Promise<boolean> {
    const last = await this.jobState.get(LAST_INBOUND_KEY);
    return last !== null && this.now().getTime() - new Date(last).getTime() < WINDOW_MS;
  }

  /**
   * O identificador com que o WhatsApp entrega suas mensagens (o "wa_id"). As respostas
   * vão para ele, e não para o número digitado no .env: em celulares brasileiros, o
   * WhatsApp às vezes usa o número sem o 9º dígito, e a Meta só entrega para o wa_id.
   */
  async rememberRecipient(waId: string): Promise<void> {
    if ((await this.jobState.get(RECIPIENT_KEY)) !== waId) {
      await this.jobState.set(RECIPIENT_KEY, waId);
    }
  }

  async recipient(): Promise<string | null> {
    return this.jobState.get(RECIPIENT_KEY);
  }

  /** Guarda um aviso para depois e devolve quantos estão esperando. */
  async enqueue(message: OutgoingMessage): Promise<number> {
    const queue = [...(await this.read()), message];
    await this.jobState.set(OUTBOX_KEY, JSON.stringify(queue));
    return queue.length;
  }

  /** Tira e devolve todos os avisos guardados, na ordem em que chegaram. */
  async drain(): Promise<OutgoingMessage[]> {
    const queue = await this.read();
    if (queue.length > 0) await this.jobState.set(OUTBOX_KEY, '[]');
    return queue;
  }

  private async read(): Promise<OutgoingMessage[]> {
    const stored = await this.jobState.get(OUTBOX_KEY);
    if (!stored) return [];
    const parsed = outboxSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : [];
  }
}
