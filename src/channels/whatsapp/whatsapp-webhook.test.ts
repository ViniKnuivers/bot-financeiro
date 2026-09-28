import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  isValidSignature,
  parseWebhook,
  registerWhatsAppWebhook,
  WEBHOOK_PATH,
  type IncomingWhatsApp,
} from './whatsapp-webhook.js';

const SECRET = 'segredo-do-app';
const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/** Aviso da Meta com uma mensagem (formato real, com campos que o bot não usa). */
function envelope(message: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: '123' },
              contacts: [{ profile: { name: 'Vini' }, wa_id: '5511999998888' }],
              messages: [
                { from: '5511999998888', id: 'wamid.1', timestamp: '1790000000', ...message },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('isValidSignature', () => {
  const body = Buffer.from('{"a":1}');

  it('aceita a assinatura certa e recusa a errada ou ausente', () => {
    expect(isValidSignature(body, sign('{"a":1}'), SECRET)).toBe(true);
    expect(isValidSignature(body, sign('{"a":1}', 'outro'), SECRET)).toBe(false);
    expect(isValidSignature(body, sign('{"a":2}'), SECRET)).toBe(false);
    expect(isValidSignature(body, undefined, SECRET)).toBe(false);
    expect(isValidSignature(body, 'sha256=abc', SECRET)).toBe(false);
  });
});

describe('parseWebhook', () => {
  it('texto', () => {
    expect(parseWebhook(envelope({ type: 'text', text: { body: 'almoço 32' } }))).toEqual([
      {
        id: 'wamid.1',
        from: '5511999998888',
        receivedAt: new Date(1790000000 * 1000),
        kind: 'text',
        text: 'almoço 32',
      },
    ]);
  });

  it('áudio de voz', () => {
    const [message] = parseWebhook(
      envelope({
        type: 'audio',
        audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus', voice: true, sha256: 'x' },
      }),
    );
    expect(message).toMatchObject({
      kind: 'audio',
      mediaId: 'media-1',
      mimeType: 'audio/ogg; codecs=opus',
    });
  });

  it('toque em botão, em lista e no botão do modelo viram ação', () => {
    const ids = [
      {
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'pm:1', title: 'Pix' } },
      },
      {
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'pm:2', title: 'VR' } },
      },
      { type: 'button', button: { payload: 'wa:ver', text: 'Ver' } },
    ].map(
      (m) =>
        (parseWebhook(envelope(m))[0] as Extract<IncomingWhatsApp, { kind: 'action' }>).actionId,
    );

    expect(ids).toEqual(['pm:1', 'pm:2', 'wa:ver']);
  });

  it('foto e figurinha: não suportado; avisos de status e lixo: nada', () => {
    expect(parseWebhook(envelope({ type: 'image', image: { id: 'm' } }))[0]).toMatchObject({
      kind: 'unsupported',
      type: 'image',
    });
    const status = envelope({});
    status.entry[0]!.changes[0]!.value = { statuses: [{ id: 'wamid.x', status: 'read' }] } as never;
    expect(parseWebhook(status)).toEqual([]);
    expect(parseWebhook('lixo')).toEqual([]);
    expect(parseWebhook({ entry: [{ changes: [{ value: { messages: [{ oi: 1 }] } }] }] })).toEqual(
      [],
    );
  });
});

describe('registerWhatsAppWebhook', () => {
  async function server() {
    const app = Fastify();
    const onMessages = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await registerWhatsAppWebhook(app, {
      verifyToken: 'verifica',
      appSecret: SECRET,
      logger,
      onMessages,
    });
    app.get('/health', () => ({ status: 'ok' }));
    return { app, onMessages };
  }

  it('verificação: devolve o desafio só com o verify token certo', async () => {
    const { app } = await server();
    const ok = await app.inject({
      url: `${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=verifica&hub.challenge=1234`,
    });
    const wrong = await app.inject({
      url: `${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=outro&hub.challenge=1234`,
    });

    expect([ok.statusCode, ok.body]).toEqual([200, '1234']);
    expect(wrong.statusCode).toBe(403);
  });

  it('aviso assinado: responde 200 e entrega as mensagens; sem assinatura: 401', async () => {
    const { app, onMessages } = await server();
    const body = JSON.stringify(envelope({ type: 'text', text: { body: 'oi' } }));

    const ok = await app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });
    const forged = await app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });

    expect(ok.statusCode).toBe(200);
    expect(forged.statusCode).toBe(401);
    expect(onMessages).toHaveBeenCalledOnce();
    expect(onMessages.mock.calls[0]?.[0]).toMatchObject([{ kind: 'text', text: 'oi' }]);
  });

  it('o resto do servidor continua recebendo JSON normal', async () => {
    const { app } = await server();
    expect((await app.inject({ url: '/health' })).json()).toEqual({ status: 'ok' });
  });
});
