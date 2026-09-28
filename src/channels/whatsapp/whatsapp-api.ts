/**
 * O que o bot usa da WhatsApp Cloud API (Graph API da Meta). Fica atrás desta interface
 * para os testes usarem uma versão em memória, sem internet nem conta na Meta.
 */

export interface WhatsAppButton {
  id: string;
  /** Até 20 caracteres. */
  title: string;
}

export interface WhatsAppListRow {
  id: string;
  /** Até 24 caracteres. */
  title: string;
  /** Até 72 caracteres. */
  description?: string;
}

export type WhatsAppOutgoing =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; body: string; buttons: WhatsAppButton[] }
  | { kind: 'list'; body: string; button: string; rows: WhatsAppListRow[] };

export interface WhatsAppTemplate {
  name: string;
  language: string;
  /** Valores de {{1}}, {{2}}... do corpo do modelo. */
  bodyParameters: string[];
  /** Payload devolvido quando o botão de resposta rápida (o primeiro) é tocado. */
  quickReplyPayload?: string;
}

export interface WhatsAppApi {
  send(to: string, message: WhatsAppOutgoing): Promise<void>;
  sendTemplate(to: string, template: WhatsAppTemplate): Promise<void>;
  /** Marca a mensagem como lida e mostra "digitando..." (some ao responder ou em 25 s). */
  markReadAndTyping(messageId: string): Promise<void>;
  /** Baixa um áudio recebido. Recusa arquivos maiores que `maxBytes` antes de baixar. */
  downloadMedia(mediaId: string, maxBytes: number): Promise<{ data: Buffer; mimeType: string }>;
}

/** Erro da Graph API, com o código da Meta (ex.: 131030 = número fora da lista de teste). */
export class WhatsAppApiError extends Error {
  override readonly name = 'WhatsAppApiError';

  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
  ) {
    super(message);
  }
}

export class MediaTooLargeError extends Error {
  override readonly name = 'MediaTooLargeError';
}

export interface GraphWhatsAppApiOptions {
  accessToken: string;
  phoneNumberId: string;
  /** Ex.: "v25.0". */
  graphVersion: string;
  fetch?: typeof fetch;
}

/** Implementação real, direto na Graph API com o `fetch` do Node. */
export class GraphWhatsAppApi implements WhatsAppApi {
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: GraphWhatsAppApiOptions) {
    this.base = `https://graph.facebook.com/${options.graphVersion}`;
    this.fetch = options.fetch ?? fetch;
  }

  async send(to: string, message: WhatsAppOutgoing): Promise<void> {
    await this.post({ recipient_type: 'individual', to, ...toPayload(message) });
  }

  async sendTemplate(to: string, template: WhatsAppTemplate): Promise<void> {
    const components: unknown[] = [
      {
        type: 'body',
        parameters: template.bodyParameters.map((text) => ({ type: 'text', text })),
      },
    ];
    if (template.quickReplyPayload) {
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: template.quickReplyPayload }],
      });
    }
    await this.post({
      recipient_type: 'individual',
      to,
      type: 'template',
      template: { name: template.name, language: { code: template.language }, components },
    });
  }

  async markReadAndTyping(messageId: string): Promise<void> {
    await this.post({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } });
  }

  async downloadMedia(
    mediaId: string,
    maxBytes: number,
  ): Promise<{ data: Buffer; mimeType: string }> {
    // 1) A URL do arquivo (vale 5 minutos) e o tamanho; 2) o arquivo, também com o token.
    const info = (await this.request(`${this.base}/${encodeURIComponent(mediaId)}`)) as {
      url?: string;
      mime_type?: string;
      file_size?: number;
    };
    if (!info.url) throw new WhatsAppApiError('mídia sem URL', 200, null);
    if ((info.file_size ?? 0) > maxBytes) {
      throw new MediaTooLargeError(`mídia com ${info.file_size} bytes`);
    }
    const response = await this.fetch(info.url, { headers: this.headers() });
    if (!response.ok) {
      throw new WhatsAppApiError(
        `download da mídia: HTTP ${response.status}`,
        response.status,
        null,
      );
    }
    return {
      data: Buffer.from(await response.arrayBuffer()),
      mimeType: info.mime_type ?? 'audio/ogg',
    };
  }

  private async post(body: Record<string, unknown>): Promise<void> {
    await this.request(`${this.base}/${this.options.phoneNumberId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    });
  }

  private async request(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetch(url, {
      ...init,
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (payload as { error?: { message?: string; code?: number } } | null)?.error;
      throw new WhatsAppApiError(
        error?.message ?? `HTTP ${response.status}`,
        response.status,
        error?.code ?? null,
      );
    }
    return payload;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.options.accessToken}` };
  }
}

function toPayload(message: WhatsAppOutgoing): Record<string, unknown> {
  switch (message.kind) {
    case 'text':
      return { type: 'text', text: { body: message.text, preview_url: true } };
    case 'buttons':
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: message.body },
          action: {
            buttons: message.buttons.map((b) => ({ type: 'reply', reply: b })),
          },
        },
      };
    case 'list':
      return {
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: message.body },
          action: { button: message.button, sections: [{ title: 'Opções', rows: message.rows }] },
        },
      };
  }
}
