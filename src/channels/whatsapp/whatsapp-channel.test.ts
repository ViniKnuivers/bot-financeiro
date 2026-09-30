import { describe, expect, it, vi } from 'vitest';
import { inMemoryJobState, InMemoryWhatsApp } from '../../test/in-memory-whatsapp.js';
import { BroadcastNotifier } from '../broadcast-notifier.js';
import type { MessageHandler } from '../message-channel.js';
import { WhatsAppApiError } from './whatsapp-api.js';
import { sameWhatsAppNumber, SHOW_NOTICES_ACTION, WhatsAppChannel } from './whatsapp-channel.js';
import { WhatsAppUsage } from './whatsapp-usage.js';
import type { IncomingWhatsApp } from './whatsapp-webhook.js';
import { WhatsAppWindow } from './whatsapp-window.js';

const ME = '5511999998888';
const HOUR = 60 * 60 * 1000;

function handler() {
  const reply = (text: string) => vi.fn(() => Promise.resolve({ text }));
  return {
    handleStart: vi.fn(() => ({ text: 'Bem-vindo' })),
    handleText: vi.fn(({ text }: { text: string }) =>
      Promise.resolve({
        text: `Como você pagou "${text}"?`,
        actions: [
          [
            { label: 'Pix', id: 'pm:pix' },
            { label: 'Crédito', id: 'pm:cred' },
          ],
        ],
      }),
    ),
    handleAudio: vi.fn(() => Promise.resolve({ text: '✅ Registrado do áudio' })),
    handleAction: vi.fn((id: string) =>
      Promise.resolve({ mode: 'replace' as const, text: `ação ${id}` }),
    ),
    handleLatest: reply('últimos'),
    handleUndoLast: reply('desfeito'),
    handleAccounts: reply('cartões'),
    handlePending: vi.fn(() => Promise.resolve([{ text: 'p1' }, { text: 'p2' }])),
    handleSummary: reply('resumo'),
    handleBudgets: reply('orçamento'),
    handleRecurring: reply('fixos'),
    handleReminders: reply('lembretes'),
    handleReport: vi.fn(() =>
      Promise.resolve({
        text: '📄 Relatório de Setembro de 2026',
        document: { filename: 'relatorio-setembro-2026.pdf', data: Buffer.from('%PDF-1.7') },
      }),
    ),
    handleSpreadsheet: reply('planilha'),
    handleCharts: reply('painel'),
    handleBackup: reply('backup'),
    handleGoals: reply('metas'),
    handleWeek: reply('semana'),
    handleRetrospective: reply('retrospectiva'),
  } satisfies MessageHandler;
}

function setup(options: { warnAt?: number } = {}) {
  let now = new Date('2026-10-05T12:00:00Z');
  const clock = {
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
  const api = new InMemoryWhatsApp();
  const jobState = inMemoryJobState();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const nearLimit = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  // Como no main.ts: o aviso de limite é ligado depois (ao notificador de todos os canais).
  const hooks = { onNearLimit: nearLimit as (text: string) => Promise<void> };
  const usage = new WhatsAppUsage({
    jobState,
    freeMonthlyMessages: 10,
    warnAt: options.warnAt ?? 9,
    month: () => now.toISOString().slice(0, 7),
    onNearLimit: (text) => hooks.onNearLimit(text),
    hasTelegram: true,
    logger,
  });
  const h = handler();
  const channel = new WhatsAppChannel({
    api,
    handler: h,
    allowedNumber: ME,
    window: new WhatsAppWindow(jobState, () => now),
    usage,
    noticeTemplate: { name: 'avisos_pendentes', language: 'pt_BR' },
    logger,
  });
  let seq = 0;
  const incoming = (
    message: Partial<IncomingWhatsApp> & Pick<IncomingWhatsApp, 'kind'>,
  ): IncomingWhatsApp =>
    ({
      id: `wamid.${++seq}`,
      from: ME,
      receivedAt: now,
      ...message,
    }) as IncomingWhatsApp;
  const receive = async (...messages: IncomingWhatsApp[]) => {
    channel.receive(messages);
    await channel.idle();
  };
  return {
    api,
    channel,
    handler: h,
    jobState,
    logger,
    nearLimit,
    hooks,
    usage,
    clock,
    incoming,
    receive,
  };
}

describe('WhatsAppChannel: conversa', () => {
  it('texto vai para o assistente e a resposta com 2 opções vira botões', async () => {
    const { api, receive, incoming, handler: h } = setup();

    await receive(incoming({ kind: 'text', text: 'almoço 32' }));

    expect(h.handleText).toHaveBeenCalledWith(expect.objectContaining({ text: 'almoço 32' }));
    expect(api.sent).toEqual([
      {
        to: ME,
        message: {
          kind: 'buttons',
          body: 'Como você pagou "almoço 32"?',
          buttons: [
            { id: 'pm:pix', title: 'Pix' },
            { id: 'pm:cred', title: 'Crédito' },
          ],
        },
      },
    ]);
    expect(api.typing).toEqual(['wamid.1']);
  });

  it('comandos com barra, com ou sem acento; desconhecido explica', async () => {
    const { api, receive, incoming } = setup();

    await receive(
      incoming({ kind: 'text', text: '/resumo' }),
      incoming({ kind: 'text', text: '/Cartões' }),
      incoming({ kind: 'text', text: '/pendentes' }),
      incoming({ kind: 'text', text: '/xyz' }),
    );

    expect(api.texts()).toEqual([
      'resumo',
      'cartões',
      'p1',
      'p2',
      'Comando desconhecido. Mande /start para ver o que eu sei fazer.',
    ]);
  });

  it('/relatorio manda o PDF como documento, com o texto de legenda', async () => {
    const { api, receive, incoming } = setup();

    await receive(incoming({ kind: 'text', text: '/relatorio' }));

    expect(api.sent).toEqual([
      {
        to: ME,
        message: {
          kind: 'document',
          filename: 'relatorio-setembro-2026.pdf',
          data: Buffer.from('%PDF-1.7'),
          caption: '📄 Relatório de Setembro de 2026',
        },
      },
    ]);
  });

  it('toque em botão vai para handleAction e a resposta chega como mensagem nova', async () => {
    const { api, receive, incoming, handler: h } = setup();

    await receive(incoming({ kind: 'action', actionId: 'pm:pix' }));

    expect(h.handleAction).toHaveBeenCalledWith('pm:pix');
    expect(api.texts()).toEqual(['ação pm:pix']);
  });

  it('áudio: baixa, limpa o tipo e manda para a IA; áudio grande é recusado antes', async () => {
    const { api, receive, incoming, handler: h } = setup();
    api.media.set('curto', { data: Buffer.alloc(1000), mimeType: 'audio/ogg; codecs=opus' });
    api.media.set('longo', { data: Buffer.alloc(500_000), mimeType: 'audio/ogg' });

    await receive(
      incoming({ kind: 'audio', mediaId: 'curto', mimeType: 'audio/ogg; codecs=opus' }),
      incoming({ kind: 'audio', mediaId: 'longo', mimeType: 'audio/ogg' }),
    );

    expect(h.handleAudio).toHaveBeenCalledOnce();
    expect(h.handleAudio).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'audio/ogg' }));
    expect(api.texts()[1]).toMatch(/longo demais/);
  });

  it('outro número é ignorado; o mesmo número sem o 9º dígito é aceito', async () => {
    const { api, receive, incoming, handler: h } = setup();

    await receive(
      incoming({ kind: 'text', text: 'oi', from: '5521988887777' }),
      incoming({ kind: 'text', text: 'oi', from: '551199998888' }),
    );

    expect(h.handleText).toHaveBeenCalledOnce();
    expect(api.sent).toHaveLength(1);
    // A resposta vai para o id com que o WhatsApp entregou (sem o 9), não para o .env.
    expect(api.sent[0]?.to).toBe('551199998888');
  });

  it('avisos também vão para o último id visto, mesmo depois de reiniciar o bot', async () => {
    const first = setup();
    await first.receive(first.incoming({ kind: 'text', text: 'oi', from: '551199998888' }));
    await first.channel.notify({ text: 'aviso' });

    expect(first.api.sent.at(-1)?.to).toBe('551199998888');
    expect(first.jobState.values.get('whatsapp.recipient')).toBe('551199998888');
  });

  it('a mesma mensagem reenviada pela Meta é processada uma vez só', async () => {
    const { receive, incoming, handler: h } = setup();
    const message = incoming({ kind: 'text', text: 'oi' });

    await receive(message, message);

    expect(h.handleText).toHaveBeenCalledOnce();
  });

  it('erro ao responder: avisa com "Ops" sem derrubar o canal', async () => {
    const { api, receive, incoming, handler: h } = setup();
    vi.mocked(h.handleText).mockRejectedValueOnce(new Error('IA fora'));

    await receive(incoming({ kind: 'text', text: 'a' }), incoming({ kind: 'text', text: 'b' }));

    expect(api.texts()[0]).toMatch(/Ops/);
    expect(api.texts()[1]).toMatch(/"b"/);
  });

  it('número fora da lista de teste: loga a dica de onde cadastrar', async () => {
    const { api, receive, incoming, logger } = setup();
    api.failWith = new WhatsAppApiError('Recipient not in allowed list', 400, 131030);

    await receive(incoming({ kind: 'text', text: 'oi' }));

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('lista de destinatários'));
  });
});

describe('WhatsAppChannel: avisos e a janela de 24h', () => {
  it('janela aberta: o aviso vai direto', async () => {
    const { api, channel, receive, incoming } = setup();
    await receive(incoming({ kind: 'text', text: 'oi' }));

    await channel.notify({ text: '📊 Setembro fechado!' });

    expect(api.texts().at(-1)).toBe('📊 Setembro fechado!');
    expect(api.templates).toHaveLength(0);
  });

  it('janela fechada: guarda os avisos, manda um modelo só, e [Ver] entrega tudo', async () => {
    const { api, channel, receive, incoming, clock } = setup();
    await receive(incoming({ kind: 'text', text: 'oi' }));
    clock.advance(25 * HOUR);
    api.sent.length = 0;

    await channel.notify({ text: 'aviso 1' });
    await channel.notify({ text: 'aviso 2' });

    expect(api.sent).toHaveLength(0);
    expect(api.templates).toEqual([
      {
        to: ME,
        template: {
          name: 'avisos_pendentes',
          language: 'pt_BR',
          bodyParameters: ['1'],
          quickReplyPayload: SHOW_NOTICES_ACTION,
        },
      },
    ]);

    await receive(incoming({ kind: 'action', actionId: SHOW_NOTICES_ACTION }));
    expect(api.texts()).toEqual(['aviso 1', 'aviso 2']);

    // Depois de entregar, um novo aviso fora da janela gera outro modelo.
    clock.advance(25 * HOUR);
    await channel.notify({ text: 'aviso 3' });
    expect(api.templates).toHaveLength(2);
  });

  it('qualquer mensagem sua também entrega os avisos guardados, antes da resposta', async () => {
    const { api, channel, receive, incoming } = setup();
    await channel.notify({ text: 'aviso guardado' }); // nunca conversou: janela fechada

    await receive(incoming({ kind: 'text', text: 'almoço 32' }));

    expect(api.texts()).toEqual(['aviso guardado', 'Como você pagou "almoço 32"?']);
  });

  it('[Ver] sem nada guardado responde que não há avisos', async () => {
    const { api, receive, incoming } = setup();

    await receive(incoming({ kind: 'action', actionId: SHOW_NOTICES_ACTION }));

    expect(api.texts()).toEqual(['Nenhum aviso pendente. 👍']);
  });
});

describe('WhatsAppUsage: limite grátis do mês', () => {
  it('conta cada mensagem enviada e avisa uma vez ao chegar no ponto de aviso', async () => {
    const { receive, incoming, nearLimit, usage } = setup({ warnAt: 3 });

    for (const text of ['a', 'b', 'c', 'd']) await receive(incoming({ kind: 'text', text }));
    await vi.waitFor(() => {
      expect(nearLimit).toHaveBeenCalledOnce();
    });

    expect(await usage.sentThisMonth()).toBe(4);
    expect(nearLimit.mock.calls[0]?.[0]).toBe(
      '⚠️ O limite grátis do WhatsApp deste mês está próximo: já foram 3 de 10 mensagens.\n\nPara evitar gastos, use o Telegram até o fim do mês. No dia 1 o limite zera.',
    );
  });

  it('a contagem zera no mês seguinte e o aviso pode sair de novo', async () => {
    const { receive, incoming, nearLimit, usage, clock } = setup({ warnAt: 1 });
    await receive(incoming({ kind: 'text', text: 'a' }));
    clock.advance(31 * 24 * HOUR);

    expect(await usage.sentThisMonth()).toBe(0);
    await receive(incoming({ kind: 'text', text: 'b' }));
    await vi.waitFor(() => {
      expect(nearLimit).toHaveBeenCalledTimes(2);
    });
  });

  it('o aviso de limite pode ser mandado pelo próprio WhatsApp sem travar a contagem', async () => {
    const { channel, receive, incoming, hooks, api } = setup({ warnAt: 1 });
    // No bot de verdade, o aviso vai para todos os canais (inclusive este).
    const broadcast = new BroadcastNotifier([channel], {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    hooks.onNearLimit = (text) => broadcast.notify({ text });

    await receive(incoming({ kind: 'text', text: 'a' }));
    await vi.waitFor(() => {
      expect(api.texts().some((t) => t.startsWith('⚠️ O limite grátis'))).toBe(true);
    });
  });
});

describe('BroadcastNotifier', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  it('um canal falhando não impede o outro; só dá erro se todos falharem', async () => {
    const ok = { name: 'telegram', notify: vi.fn(() => Promise.resolve()) };
    const broken = { name: 'whatsapp', notify: vi.fn(() => Promise.reject(new Error('fora'))) };

    await new BroadcastNotifier([ok, broken], logger).notify({ text: 'x' });
    expect(ok.notify).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();

    await expect(new BroadcastNotifier([broken], logger).notify({ text: 'x' })).rejects.toThrow(
      'fora',
    );
  });
});

describe('sameWhatsAppNumber', () => {
  it('aceita o celular brasileiro com e sem o 9º dígito, e só ele', () => {
    expect(sameWhatsAppNumber('5511999998888', '551199998888')).toBe(true);
    expect(sameWhatsAppNumber('+55 (11) 99999-8888', '5511999998888')).toBe(true);
    expect(sameWhatsAppNumber('5511999998888', '5511999998889')).toBe(false);
    expect(sameWhatsAppNumber('14155550000', '4155550000')).toBe(false);
  });
});
