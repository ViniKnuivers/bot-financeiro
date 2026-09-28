import type { Logger } from '../lib/logger.js';
import type { MessageChannel, Notifier, OutgoingMessage } from './message-channel.js';

/**
 * Manda os avisos do bot (dia 1, gastos fixos, planilha...) em todos os canais ligados.
 * Um canal com problema não impede os outros; só dá erro se nenhum conseguir.
 */
export class BroadcastNotifier implements Notifier {
  constructor(
    private readonly channels: readonly Pick<MessageChannel, 'name' | 'notify'>[],
    private readonly logger: Logger,
  ) {}

  async notify(message: OutgoingMessage): Promise<void> {
    const results = await Promise.allSettled(this.channels.map((c) => c.notify(message)));
    const failures = results.flatMap((result, i) =>
      result.status === 'rejected'
        ? [{ channel: this.channels[i]?.name, error: result.reason as unknown }]
        : [],
    );
    for (const { channel, error } of failures) {
      this.logger.error({ err: error, channel }, 'aviso não entregue neste canal');
    }
    if (failures.length > 0 && failures.length === this.channels.length) {
      throw failures[0]?.error instanceof Error
        ? failures[0].error
        : new Error('nenhum canal conseguiu entregar o aviso');
    }
  }
}
