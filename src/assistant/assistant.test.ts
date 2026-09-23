import { describe, expect, it, vi } from 'vitest';
import {
  TransactionParserError,
  type ParseResult,
  type TransactionParser,
} from '../ai/transaction-parser.js';
import { TransactionService } from '../modules/transactions/transaction.service.js';
import { InMemoryTransactionRepository } from '../test/in-memory-transaction-repository.js';
import { Assistant } from './assistant.js';

const RECEIVED_AT = new Date('2026-09-23T15:00:00Z');

const almoco = {
  type: 'EXPENSE',
  amountCents: 3200,
  description: 'Almoço',
  category: 'ALIMENTACAO',
  paymentMethod: 'PIX',
  occurredAt: '2026-09-23',
} as const;

function setup() {
  const parse = vi.fn<TransactionParser['parse']>();
  const repository = new InMemoryTransactionRepository();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const assistant = new Assistant({
    parser: { parse },
    transactions: new TransactionService(repository),
    logger,
  });
  return { assistant, parse, repository, logger };
}

function result(overrides: Partial<ParseResult>): ParseResult {
  return { intent: 'register', transactions: [], transcript: null, reply: 'ok', ...overrides };
}

describe('Assistant', () => {
  describe('mensagem de texto', () => {
    it('salva, responde com o resumo e oferece o botão Desfazer', async () => {
      const { assistant, parse, repository } = setup();
      parse.mockResolvedValue(result({ transactions: [almoco] }));

      const reply = await assistant.handleText({
        text: 'almoço 32 no pix',
        receivedAt: RECEIVED_AT,
      });

      expect(repository.rows).toHaveLength(1);
      expect(repository.rows[0]).toMatchObject({ rawInput: 'almoço 32 no pix', source: 'TEXT' });
      expect(reply.text).toMatch(/R\$\s32,00/);
      expect(reply.text).toContain('Almoço');
      expect(reply.actions).toEqual([
        { label: expect.stringContaining('Desfazer'), id: `undo:${repository.rows[0]?.batchId}` },
      ]);
    });

    it('usa a hora em que a mensagem foi enviada como referência de data', async () => {
      const { assistant, parse } = setup();
      parse.mockResolvedValue(result({ transactions: [almoco] }));

      await assistant.handleText({ text: 'almoço ontem', receivedAt: RECEIVED_AT });

      expect(parse).toHaveBeenCalledWith({ text: 'almoço ontem', now: RECEIVED_AT });
    });

    it.each(['clarify', 'other'] as const)(
      'com intent "%s" não salva nada e repassa a resposta da IA',
      async (intent) => {
        const { assistant, parse, repository } = setup();
        // Mesmo que a IA mande transações junto por engano, nada pode ser salvo.
        parse.mockResolvedValue(result({ intent, transactions: [almoco], reply: 'Quanto foi?' }));

        const reply = await assistant.handleText({ text: 'x', receivedAt: RECEIVED_AT });

        expect(repository.rows).toHaveLength(0);
        expect(reply).toEqual({ text: 'Quanto foi?' });
      },
    );

    it('erro da IA vira mensagem amigável, não salva nada e é registrado no log', async () => {
      const { assistant, parse, repository, logger } = setup();
      parse.mockRejectedValue(new TransactionParserError('rate_limit', 'limite'));

      const reply = await assistant.handleText({ text: 'almoço 32', receivedAt: RECEIVED_AT });

      expect(repository.rows).toHaveLength(0);
      expect(reply.text).toContain('limite de uso');
      expect(reply.text).toContain('Nada foi salvo');
      expect(logger.error).toHaveBeenCalledOnce();
    });
  });

  describe('mensagem de voz', () => {
    it('guarda a transcrição como texto original, com origem AUDIO, e mostra o que ouviu', async () => {
      const { assistant, parse, repository } = setup();
      parse.mockResolvedValue(
        result({ transactions: [almoco], transcript: 'almoço trinta e dois' }),
      );

      const reply = await assistant.handleAudio({
        audio: Buffer.from('ogg'),
        mimeType: 'audio/ogg',
        receivedAt: RECEIVED_AT,
      });

      expect(repository.rows[0]).toMatchObject({
        rawInput: 'almoço trinta e dois',
        source: 'AUDIO',
      });
      expect(reply.text).toContain('🎙️ "almoço trinta e dois"');
    });
  });

  describe('botão Desfazer', () => {
    it('apaga o lote da mensagem', async () => {
      const { assistant, parse, repository } = setup();
      parse.mockResolvedValue(result({ transactions: [almoco, almoco] }));
      const registered = await assistant.handleText({ text: 'x', receivedAt: RECEIVED_AT });

      const reply = await assistant.handleAction(registered.actions?.[0]?.id ?? '');

      expect(repository.rows).toHaveLength(0);
      expect(reply.text).toContain('2 lançamentos apagados');
    });

    it.each(['undo:nao-e-uuid', 'outra-acao', ''])(
      'recusa ação inválida "%s" sem ir ao banco',
      async (actionId) => {
        const { assistant, repository } = setup();
        const deleteBatch = vi.spyOn(repository, 'deleteBatch');

        const reply = await assistant.handleAction(actionId);

        expect(deleteBatch).not.toHaveBeenCalled();
        expect(reply.text).toContain('não é mais válido');
      },
    );
  });
});
