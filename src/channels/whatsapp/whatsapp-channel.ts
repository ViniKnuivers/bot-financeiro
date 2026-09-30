import type { Logger } from '../../lib/logger.js';
import type { MessageChannel, MessageHandler, OutgoingMessage } from '../message-channel.js';
import { MediaTooLargeError, WhatsAppApiError, type WhatsAppApi } from './whatsapp-api.js';
import { toWhatsAppMessages } from './whatsapp-format.js';
import type { WhatsAppUsage } from './whatsapp-usage.js';
import type { IncomingWhatsApp } from './whatsapp-webhook.js';
import type { WhatsAppWindow } from './whatsapp-window.js';

/** Payload do botão [Ver] do modelo de avisos: manda os avisos guardados. */
export const SHOW_NOTICES_ACTION = 'wa:ver';

/**
 * Áudios maiores que isso são recusados antes do download (o webhook não informa a
 * duração). Voz do WhatsApp (Opus) ocupa ~2 KB/s: 400 KB são uns 3 minutos.
 */
const MAX_AUDIO_BYTES = 400_000;

/** Quantos ids de mensagem lembrar para ignorar reenvios da Meta. */
const REMEMBERED_IDS = 500;

const OOPS = 'Ops, algo deu errado aqui. Tenta de novo em instantes.';

type Command = (handler: MessageHandler) => Promise<OutgoingMessage[]>;
const one = (reply: Promise<OutgoingMessage>) => reply.then((message) => [message]);

/** Os mesmos comandos do Telegram (no WhatsApp não há menu de comandos, mas digitar funciona). */
const COMMANDS: Record<string, Command> = {
  start: (h) => Promise.resolve([h.handleStart()]),
  menu: (h) => Promise.resolve([h.handleStart()]),
  ajuda: (h) => Promise.resolve([h.handleStart()]),
  ultimos: (h) => one(h.handleLatest()),
  desfazer: (h) => one(h.handleUndoLast()),
  cartoes: (h) => one(h.handleAccounts()),
  resumo: (h) => one(h.handleSummary()),
  orcamento: (h) => one(h.handleBudgets()),
  fixos: (h) => one(h.handleRecurring()),
  lembretes: (h) => one(h.handleReminders()),
  relatorio: (h) => one(h.handleReport()),
  planilha: (h) => one(h.handleSpreadsheet()),
  grafico: (h) => one(h.handleCharts()),
  pendentes: (h) => h.handlePending(),
};

export interface WhatsAppChannelOptions {
  api: WhatsAppApi;
  handler: MessageHandler;
  /** Seu número (só dígitos). Só ele é atendido. */
  allowedNumber: string;
  window: WhatsAppWindow;
  usage: WhatsAppUsage;
  /** Modelo aprovado na Meta, usado quando a janela de 24h está fechada. */
  noticeTemplate: { name: string; language: string };
  logger: Logger;
}

/**
 * Canal WhatsApp (Cloud API da Meta). Recebe pelo webhook (ver `whatsapp-webhook.ts`),
 * traduz para o `MessageHandler` e responde. Mesmo papel do `TelegramChannel`.
 */
export class WhatsAppChannel implements MessageChannel {
  readonly name = 'whatsapp';
  /** Uma mensagem por vez, na ordem de chegada (como no Telegram). */
  private chain: Promise<void> = Promise.resolve();
  private readonly seen = new Set<string>();

  constructor(private readonly options: WhatsAppChannelOptions) {}

  /** As mensagens chegam pelo webhook, que é registrado no servidor HTTP. */
  start(): Promise<void> {
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    await this.chain;
  }

  /** Entrada do webhook: enfileira e volta na hora (a Meta espera resposta rápida). */
  receive(messages: readonly IncomingWhatsApp[]): void {
    for (const message of messages) {
      this.chain = this.chain
        .then(() => this.process(message))
        .catch((error: unknown) => {
          this.options.logger.error({ err: error }, 'whatsapp: erro ao processar mensagem');
        });
    }
  }

  /** Espera a fila esvaziar (testes e encerramento). */
  idle(): Promise<void> {
    return this.chain;
  }

  /**
   * Mensagem por iniciativa do bot. Com a janela de 24h aberta, vai direto; fechada, fica
   * guardada e sai um modelo "Você tem N aviso(s) [Ver]" (só um enquanto houver fila).
   */
  async notify(message: OutgoingMessage): Promise<void> {
    const { window, api, noticeTemplate, usage } = this.options;
    if (await window.isOpen()) {
      await this.deliver(message);
      return;
    }
    const pending = await window.enqueue(message);
    if (pending > 1) return;
    await api.sendTemplate(await this.recipient(), {
      name: noticeTemplate.name,
      language: noticeTemplate.language,
      bodyParameters: [String(pending)],
      quickReplyPayload: SHOW_NOTICES_ACTION,
    });
    await usage.record();
  }

  private async process(message: IncomingWhatsApp): Promise<void> {
    const { logger, window, api } = this.options;
    if (!sameWhatsAppNumber(message.from, this.options.allowedNumber)) {
      logger.warn({ from: message.from }, 'whatsapp: mensagem ignorada (número não autorizado)');
      return;
    }
    if (this.seen.has(message.id)) return;
    this.remember(message.id);

    // Qualquer mensagem sua reabre a janela: os avisos guardados saem primeiro.
    await window.rememberRecipient(message.from);
    await window.touch();
    const queued = await window.drain();
    for (const notice of queued) await this.deliver(notice);
    if (message.kind === 'action' && message.actionId === SHOW_NOTICES_ACTION) {
      if (queued.length === 0) await this.deliver({ text: 'Nenhum aviso pendente. 👍' });
      return;
    }

    api.markReadAndTyping(message.id).catch((error: unknown) => {
      logger.debug({ err: error }, 'whatsapp: não consegui mostrar "digitando"');
    });
    try {
      for (const reply of await this.route(message)) await this.deliver(reply);
    } catch (error) {
      logger.error({ err: error, kind: message.kind }, 'whatsapp: erro ao responder');
      await this.deliver({ text: OOPS }).catch(() => undefined);
    }
  }

  private async route(message: IncomingWhatsApp): Promise<OutgoingMessage[]> {
    const { handler, api } = this.options;
    switch (message.kind) {
      case 'text': {
        const text = message.text.trim();
        if (!text.startsWith('/')) {
          return [await handler.handleText({ text, receivedAt: message.receivedAt })];
        }
        const command = COMMANDS[commandName(text)];
        return command
          ? command(handler)
          : [{ text: 'Comando desconhecido. Mande /start para ver o que eu sei fazer.' }];
      }
      case 'audio': {
        let media: { data: Buffer; mimeType: string };
        try {
          media = await api.downloadMedia(message.mediaId, MAX_AUDIO_BYTES);
        } catch (error) {
          if (error instanceof MediaTooLargeError) {
            return [
              { text: 'Esse áudio é longo demais (máximo uns 2 minutos). Pode mandar em partes?' },
            ];
          }
          throw error;
        }
        return [
          await handler.handleAudio({
            audio: media.data,
            // "audio/ogg; codecs=opus" → "audio/ogg", como a IA espera.
            mimeType: (media.mimeType.split(';')[0] ?? 'audio/ogg').trim(),
            receivedAt: message.receivedAt,
          }),
        ];
      }
      case 'action':
        return [await handler.handleAction(message.actionId)];
      case 'unsupported':
        return [{ text: 'Por enquanto eu entendo só mensagens de texto e de voz.' }];
    }
  }

  /** Para onde responder: o id com que o WhatsApp te identifica (ou o número do .env). */
  private async recipient(): Promise<string> {
    return (await this.options.window.recipient()) ?? this.options.allowedNumber;
  }

  /** Envia uma resposta do bot (pode virar várias mensagens) e conta cada uma. */
  private async deliver(message: OutgoingMessage): Promise<void> {
    const to = await this.recipient();
    for (const outgoing of toWhatsAppMessages(message)) {
      try {
        await this.options.api.send(to, outgoing);
      } catch (error) {
        if (error instanceof WhatsAppApiError && error.code === 131030) {
          this.options.logger.error(
            'whatsapp: seu número não está na lista de destinatários do número de teste (Meta → WhatsApp → Configuração da API → "Para")',
          );
        }
        throw error;
      }
      await this.options.usage.record();
    }
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > REMEMBERED_IDS) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

/** "/Cartões extra" → "cartoes". */
function commandName(text: string): string {
  return (text.slice(1).split(/\s+/)[0] ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * Compara números aceitando celular brasileiro com e sem o 9º dígito: o WhatsApp às
 * vezes identifica "55 11 9XXXX-XXXX" como "55 11 XXXX-XXXX".
 */
export function sameWhatsAppNumber(a: string, b: string): boolean {
  const [x, y] = [a.replace(/\D/g, ''), b.replace(/\D/g, '')];
  if (x === y) return true;
  const withoutNinth = (n: string) =>
    n.length === 13 && n.startsWith('55') && n[4] === '9' ? n.slice(0, 4) + n.slice(5) : n;
  return withoutNinth(x) === withoutNinth(y);
}
