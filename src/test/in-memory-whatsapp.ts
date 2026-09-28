import type { JobStateRepository } from '../jobs/job-state.repository.js';
import {
  MediaTooLargeError,
  type WhatsAppApi,
  type WhatsAppOutgoing,
  type WhatsAppTemplate,
} from '../channels/whatsapp/whatsapp-api.js';

/** WhatsApp falso: guarda o que o bot enviou e serve áudios pré-carregados. */
export class InMemoryWhatsApp implements WhatsAppApi {
  readonly sent: { to: string; message: WhatsAppOutgoing }[] = [];
  readonly templates: { to: string; template: WhatsAppTemplate }[] = [];
  readonly typing: string[] = [];
  readonly media = new Map<string, { data: Buffer; mimeType: string }>();
  /** Próximos envios falham com este erro. */
  failWith: Error | null = null;

  send(to: string, message: WhatsAppOutgoing): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push({ to, message });
    return Promise.resolve();
  }

  sendTemplate(to: string, template: WhatsAppTemplate): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.templates.push({ to, template });
    return Promise.resolve();
  }

  markReadAndTyping(messageId: string): Promise<void> {
    this.typing.push(messageId);
    return Promise.resolve();
  }

  downloadMedia(mediaId: string, maxBytes: number): Promise<{ data: Buffer; mimeType: string }> {
    const media = this.media.get(mediaId);
    if (!media) return Promise.reject(new Error(`mídia ${mediaId} não existe`));
    if (media.data.length > maxBytes) return Promise.reject(new MediaTooLargeError('grande'));
    return Promise.resolve(media);
  }

  /** Textos enviados (o corpo, no caso de botões e listas). */
  texts(): string[] {
    return this.sent.map(({ message }) => (message.kind === 'text' ? message.text : message.body));
  }
}

/** JobState em memória. */
export function inMemoryJobState(): JobStateRepository & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}
