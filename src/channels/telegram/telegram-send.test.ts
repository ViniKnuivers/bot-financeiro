import type { Api } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { send } from './telegram-channel.js';

function fakeApi() {
  const sendMessage = vi.fn(() => Promise.resolve({}));
  const sendDocument = vi.fn(() => Promise.resolve({}));
  return { api: { sendMessage, sendDocument } as unknown as Api, sendMessage, sendDocument };
}

const document = { filename: 'relatorio-setembro-2026.pdf', data: Buffer.from('%PDF-1.7') };

describe('send (Telegram)', () => {
  it('texto com botões: uma mensagem com teclado inline', async () => {
    const { api, sendMessage, sendDocument } = fakeApi();

    await send(api, 42, { text: 'Oi', actions: [[{ label: 'Ok', id: 'ok' }]] });

    expect(sendDocument).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(42, 'Oi', {
      reply_markup: expect.objectContaining({
        inline_keyboard: [[{ text: 'Ok', callback_data: 'ok' }]],
      }),
    });
  });

  it('com arquivo: o documento vai com o texto de legenda e os botões', async () => {
    const { api, sendMessage, sendDocument } = fakeApi();

    await send(api, 42, { text: 'Relatório', document, actions: [[{ label: '◀', id: 'rp:x' }]] });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendDocument).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ filename: 'relatorio-setembro-2026.pdf' }),
      expect.objectContaining({ caption: 'Relatório' }),
    );
  });

  it('texto maior que a legenda: vai antes, e o documento sai sem legenda', async () => {
    const { api, sendMessage, sendDocument } = fakeApi();

    await send(api, 42, { text: 'x'.repeat(1500), document });

    expect(sendMessage).toHaveBeenCalledWith(42, 'x'.repeat(1500));
    expect(sendDocument).toHaveBeenCalledWith(42, expect.anything(), {});
  });
});
