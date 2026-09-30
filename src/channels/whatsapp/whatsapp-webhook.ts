import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Logger } from '../../lib/logger.js';

export const WEBHOOK_PATH = '/webhooks/whatsapp';

/** Uma mensagem recebida, já traduzida do formato da Meta. */
export type IncomingWhatsApp = {
  /** Id da mensagem ("wamid..."), usado para ignorar reenvios e marcar como lida. */
  id: string;
  /** Número de quem mandou (só dígitos). */
  from: string;
  receivedAt: Date;
} & (
  | { kind: 'text'; text: string }
  | { kind: 'audio'; mediaId: string; mimeType: string }
  | { kind: 'image'; mediaId: string; mimeType: string; caption?: string }
  /** Toque num botão, numa lista ou no botão de resposta rápida de um modelo. */
  | { kind: 'action'; actionId: string }
  | { kind: 'unsupported'; type: string }
);

/**
 * Confere o cabeçalho `X-Hub-Signature-256`: HMAC-SHA256 do corpo exato recebido, com a
 * chave secreta do app. Sem isso, qualquer um que descobrisse a URL poderia se passar
 * pela Meta e registrar lançamentos.
 */
export function isValidSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// O formato da Meta tem muitos campos; só validamos os que usamos, e o resto passa.
const messageSchema = z.looseObject({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional(),
  audio: z.looseObject({ id: z.string(), mime_type: z.string().optional() }).optional(),
  image: z
    .looseObject({
      id: z.string(),
      mime_type: z.string().optional(),
      caption: z.string().optional(),
    })
    .optional(),
  interactive: z
    .looseObject({
      type: z.string(),
      button_reply: z.looseObject({ id: z.string() }).optional(),
      list_reply: z.looseObject({ id: z.string() }).optional(),
    })
    .optional(),
  button: z.looseObject({ payload: z.string() }).optional(),
});

const webhookSchema = z.looseObject({
  entry: z
    .array(
      z.looseObject({
        changes: z
          .array(
            z.looseObject({
              value: z.looseObject({
                messages: z.array(z.unknown()).optional(),
                statuses: z.array(z.unknown()).optional(),
              }),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

/**
 * Extrai as mensagens de um aviso da Meta. Avisos de status (enviada, entregue, lida) não
 * trazem `messages` e viram lista vazia; mensagens em formato inesperado são puladas.
 */
export function parseWebhook(body: unknown): IncomingWhatsApp[] {
  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success) return [];
  const raw = parsed.data.entry.flatMap((entry) =>
    entry.changes.flatMap((change) => change.value.messages ?? []),
  );
  return raw.flatMap((item): IncomingWhatsApp[] => {
    const message = messageSchema.safeParse(item);
    if (!message.success) return [];
    const m = message.data;
    const base = { id: m.id, from: m.from, receivedAt: new Date(Number(m.timestamp) * 1000) };
    if (m.type === 'text' && m.text) return [{ ...base, kind: 'text', text: m.text.body }];
    if (m.type === 'audio' && m.audio) {
      return [
        { ...base, kind: 'audio', mediaId: m.audio.id, mimeType: m.audio.mime_type ?? 'audio/ogg' },
      ];
    }
    if (m.type === 'image' && m.image) {
      const { id, mime_type: mimeType = 'image/jpeg', caption } = m.image;
      return [{ ...base, kind: 'image', mediaId: id, mimeType, ...(caption ? { caption } : {}) }];
    }
    const actionId =
      m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? m.button?.payload;
    if (actionId) return [{ ...base, kind: 'action', actionId }];
    return [{ ...base, kind: 'unsupported', type: m.type }];
  });
}

const statusSchema = z.looseObject({
  status: z.string(),
  recipient_id: z.string().optional(),
  errors: z
    .array(
      z.looseObject({
        code: z.number().optional(),
        title: z.string().optional(),
        error_data: z.looseObject({ details: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});

/** Uma mensagem do bot que a Meta aceitou mas não conseguiu entregar. */
export interface FailedDelivery {
  recipient: string | null;
  code: number | null;
  reason: string;
}

/**
 * A Meta aceita o envio na hora e só depois avisa, num aviso de status, se não conseguiu
 * entregar (ex.: número fora da lista de teste, janela de 24h fechada). Sem ler isso, a
 * mensagem some sem nenhum erro.
 */
export function parseFailedDeliveries(body: unknown): FailedDelivery[] {
  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success) return [];
  return parsed.data.entry
    .flatMap((entry) => entry.changes.flatMap((change) => change.value.statuses ?? []))
    .flatMap((item): FailedDelivery[] => {
      const status = statusSchema.safeParse(item);
      if (!status.success || status.data.status !== 'failed') return [];
      const error = status.data.errors?.[0];
      return [
        {
          recipient: status.data.recipient_id ?? null,
          code: error?.code ?? null,
          reason: error?.error_data?.details ?? error?.title ?? 'motivo não informado',
        },
      ];
    });
}

export interface WhatsAppWebhookOptions {
  verifyToken: string;
  appSecret: string;
  logger: Logger;
  /** Chamado depois de responder 200 à Meta (processar pode levar vários segundos). */
  onMessages: (messages: IncomingWhatsApp[]) => void;
}

/**
 * Rotas do webhook, num plugin isolado: o corpo chega cru (Buffer) só aqui, porque a
 * assinatura é calculada sobre os bytes exatos; o resto do servidor não muda.
 */
export function registerWhatsAppWebhook(app: FastifyInstance, options: WhatsAppWebhookOptions) {
  return app.register((instance, _opts, done) => {
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );

    // A Meta chama isto uma vez, ao cadastrar a URL, para confirmar que ela é sua.
    instance.get(WEBHOOK_PATH, async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === options.verifyToken) {
        return reply.type('text/plain').send(query['hub.challenge'] ?? '');
      }
      options.logger.warn('whatsapp: verificação do webhook recusada (verify token diferente)');
      return reply.code(403).send();
    });

    instance.post(WEBHOOK_PATH, async (request, reply) => {
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const signature = request.headers['x-hub-signature-256'];
      if (
        !isValidSignature(
          raw,
          typeof signature === 'string' ? signature : undefined,
          options.appSecret,
        )
      ) {
        options.logger.warn('whatsapp: aviso com assinatura inválida ignorado');
        return reply.code(401).send();
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.code(400).send();
      }
      // Responde já: se demorar, a Meta reenvia o mesmo aviso.
      await reply.code(200).send();
      for (const failure of parseFailedDeliveries(body)) {
        options.logger.error(failure, 'whatsapp: a Meta não entregou uma mensagem do bot');
      }
      const messages = parseWebhook(body);
      if (messages.length > 0) options.onMessages(messages);
    });

    done();
  });
}
