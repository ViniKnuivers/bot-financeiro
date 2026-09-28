import { describe, expect, it } from 'vitest';
import type { ReplyAction } from '../message-channel.js';
import { toWhatsAppMessages } from './whatsapp-format.js';

const actions = (n: number, label = (i: number) => `Opção ${i}`): ReplyAction[] =>
  Array.from({ length: n }, (_, i) => ({ label: label(i + 1), id: `op:${i + 1}` }));

describe('toWhatsAppMessages', () => {
  it('sem botões: texto simples', () => {
    expect(toWhatsAppMessages({ text: 'Oi' })).toEqual([{ kind: 'text', text: 'Oi' }]);
  });

  it('até 3 ações curtas viram botões (as linhas do Telegram são juntadas)', () => {
    const [message] = toWhatsAppMessages({
      text: 'Como você pagou?',
      actions: [actions(2), [{ label: '❌ Cancelar', id: 'x' }]],
    });

    expect(message).toEqual({
      kind: 'buttons',
      body: 'Como você pagou?',
      buttons: [
        { id: 'op:1', title: 'Opção 1' },
        { id: 'op:2', title: 'Opção 2' },
        { id: 'x', title: '❌ Cancelar' },
      ],
    });
  });

  it('4 a 10 ações: uma lista', () => {
    const messages = toWhatsAppMessages({ text: 'Qual cartão?', actions: [actions(4)] });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'list', body: 'Qual cartão?', button: 'Escolher' });
    expect(messages[0]?.kind === 'list' && messages[0].rows).toHaveLength(4);

    const ten = toWhatsAppMessages({ text: 'x', actions: [actions(10)] });
    expect(ten).toHaveLength(1);
  });

  it('mais de 10 ações: listas de tamanho parecido', () => {
    const messages = toWhatsAppMessages({ text: 'Qual categoria?', actions: [actions(12)] });

    expect(messages.map((m) => m.kind === 'list' && [m.body, m.rows.length])).toEqual([
      ['Qual categoria?', 6],
      ['Mais opções (2/2):', 6],
    ]);
  });

  it('botão com nome longo vira lista; o título é cortado e o nome inteiro vai na descrição', () => {
    const label = '↩️ Desfazer: Despesa · Almoço · R$ 32,00';
    const [message] = toWhatsAppMessages({ text: 'Apaguei', actions: [[{ label, id: 'tr:1' }]] });

    expect(message).toEqual({
      kind: 'list',
      body: 'Apaguei',
      button: 'Escolher',
      // "↩️" ocupa 2 caracteres (seta + seletor de emoji): o corte é conservador.
      rows: [{ id: 'tr:1', title: '↩️ Desfazer: Despesa · …', description: label }],
    });
  });

  it('texto maior que o limite dos botões vai antes, e os botões seguem com um corpo curto', () => {
    const text = 'linha\n'.repeat(300); // 1800 caracteres
    const messages = toWhatsAppMessages({ text, actions: [actions(2)] });

    expect(messages.map((m) => m.kind)).toEqual(['text', 'buttons']);
    expect(messages[1]).toMatchObject({ body: 'Escolha uma opção:' });
  });

  it('texto enorme é dividido em fim de linha', () => {
    const text = 'x'.repeat(100).concat('\n').repeat(60); // 6060 caracteres
    const messages = toWhatsAppMessages({ text });

    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m.kind === 'text' && Array.from(m.text).length).toBeLessThanOrEqual(4096);
    }
    // O corte cai no fim de uma linha, sem partir "xxxx" no meio.
    expect(messages[0]?.kind === 'text' && messages[0].text.endsWith('x')).toBe(true);
    expect(messages[1]?.kind === 'text' && messages[1].text.startsWith('x'.repeat(100))).toBe(true);
  });
});
