import type { JobStateRepository } from '../../jobs/job-state.repository.js';
import type { Logger } from '../../lib/logger.js';

export interface WhatsAppUsageOptions {
  jobState: JobStateRepository;
  /** Mensagens grátis por mês (regra da Meta desde 01/10/2026: 1.000 por número). */
  freeMonthlyMessages: number;
  /** A partir de quantas enviadas no mês avisar (uma vez por mês). */
  warnAt: number;
  /** Mês atual, "YYYY-MM", no fuso do usuário. */
  month: () => string;
  /** Recebe o aviso pronto. Chamado fora da contagem, então pode enviar mensagens. */
  onNearLimit: (text: string) => Promise<void>;
  /** Com Telegram ligado, o aviso sugere usá-lo até o fim do mês. */
  hasTelegram: boolean;
  logger: Logger;
}

/**
 * Conta as mensagens que o bot manda pelo WhatsApp no mês, para avisar antes de a Meta
 * começar a cobrar. A contagem fica no banco (sobrevive a reinícios) e zera sozinha na
 * virada do mês, porque a chave inclui o mês.
 */
export class WhatsAppUsage {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: WhatsAppUsageOptions) {}

  /** Registra mensagens enviadas; avisa uma vez ao cruzar o ponto de aviso do mês. */
  async record(count = 1): Promise<void> {
    // Em fila: duas mensagens ao mesmo tempo não podem ler o mesmo total.
    const step = this.chain.then(() => this.increment(count));
    this.chain = step.catch(() => undefined);
    const crossed = await step;
    if (crossed !== null) {
      // Fora da fila: o próprio aviso também é uma mensagem e passa por aqui.
      this.options.onNearLimit(nearLimitMessage(crossed, this.options)).catch((error: unknown) => {
        this.options.logger.error({ err: error }, 'whatsapp: falha ao avisar do limite grátis');
      });
    }
  }

  /** Total enviado no mês atual. */
  async sentThisMonth(): Promise<number> {
    return Number((await this.options.jobState.get(sentKey(this.options.month()))) ?? 0);
  }

  /** Soma e devolve o total se o aviso deve sair agora (senão null). */
  private async increment(count: number): Promise<number | null> {
    const { jobState, month, warnAt } = this.options;
    const current = month();
    const total = (await this.sentThisMonth()) + count;
    await jobState.set(sentKey(current), String(total));
    if (total < warnAt || (await jobState.get(warnedKey(current))) !== null) return null;
    await jobState.set(warnedKey(current), String(total));
    return total;
  }
}

const sentKey = (month: string) => `whatsapp.sent.${month}`;
const warnedKey = (month: string) => `whatsapp.usageWarned.${month}`;

export function nearLimitMessage(
  sent: number,
  options: Pick<WhatsAppUsageOptions, 'freeMonthlyMessages' | 'hasTelegram'>,
): string {
  const limit = options.freeMonthlyMessages.toLocaleString('pt-BR');
  const header = `⚠️ O limite grátis do WhatsApp deste mês está próximo: já foram ${sent.toLocaleString('pt-BR')} de ${limit} mensagens.`;
  return options.hasTelegram
    ? `${header}\n\nPara evitar gastos, use o Telegram até o fim do mês. No dia 1 o limite zera.`
    : `${header}\n\nDepois de ${limit}, a Meta cobra alguns centavos por mensagem. No dia 1 o limite zera.`;
}
