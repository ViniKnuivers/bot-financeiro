import { ApiError, GenerateContentResponse, type Models } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { GeminiTransactionParser } from './gemini-transaction-parser.js';
import { TransactionParserError } from './transaction-parser.js';

type GenerateContent = Models['generateContent'];
type GenerateParams = Parameters<GenerateContent>[0];

// 23/09/2026 às 22:30 em São Paulo, que já é dia 24 em UTC.
const NOW = new Date('2026-09-24T01:30:00Z');

const almoco = {
  type: 'EXPENSE',
  amountCents: 3200,
  description: 'Almoço',
  category: 'ALIMENTACAO',
  paymentMethod: 'PIX',
  account: null,
  installments: 1,
  occurredAt: '2026-09-23',
};

function response(body: unknown): GenerateContentResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return Object.assign(new GenerateContentResponse(), {
    candidates: [{ content: { role: 'model', parts: [{ text }] } }],
  });
}

function registerResponse(transactions: unknown[] = [almoco]) {
  return response({ intent: 'register', transactions, transcript: null, reply: 'Anotado!' });
}

function setup(options: { fallbackModels?: string[]; timeoutMs?: number } = {}) {
  const generateContent = vi.fn<GenerateContent>();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const parser = new GeminiTransactionParser({
    models: { generateContent },
    model: 'modelo-principal',
    timeZone: 'America/Sao_Paulo',
    logger,
    ...options,
  });
  /** Parâmetros da n-ésima chamada ao Gemini. */
  const call = (index = 0): GenerateParams => {
    const params = generateContent.mock.calls[index]?.[0];
    if (!params) throw new Error(`generateContent não foi chamado ${index + 1} vez(es)`);
    return params;
  };
  return { parser, generateContent, logger, call };
}

/** Executa e devolve o erro lançado, para poder inspecionar os campos dele. */
async function parseError(promise: Promise<unknown>): Promise<TransactionParserError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TransactionParserError);
  return error as TransactionParserError;
}

describe('GeminiTransactionParser', () => {
  describe('requisição', () => {
    it('usa a data de hoje no fuso do usuário, não em UTC', async () => {
      const { parser, generateContent, call } = setup();
      generateContent.mockResolvedValue(registerResponse());

      await parser.parse({ text: 'almoço 32', now: NOW });

      const prompt = call().config?.systemInstruction;
      if (typeof prompt !== 'string') throw new Error('systemInstruction deveria ser string');
      expect(prompt).toContain('2026-09-23 (hoje)');
      expect(prompt).toContain('2026-09-22 (ontem)');
      expect(prompt).not.toContain('2026-09-24');
    });

    it('pede JSON no schema estruturado', async () => {
      const { parser, generateContent, call } = setup();
      generateContent.mockResolvedValue(registerResponse());

      await parser.parse({ text: 'almoço 32', now: NOW });

      expect(call().model).toBe('modelo-principal');
      expect(call().config?.responseMimeType).toBe('application/json');
      expect(call().config?.responseJsonSchema).toMatchObject({
        type: 'object',
        required: expect.arrayContaining(['intent', 'transactions', 'transcript', 'reply']),
      });
    });

    it('envia o áudio como inlineData em base64', async () => {
      const { parser, generateContent, call } = setup();
      generateContent.mockResolvedValue(registerResponse());
      const audio = Buffer.from('fake-ogg');

      await parser.parse({ audio, mimeType: 'audio/ogg', now: NOW });

      expect(call().contents).toEqual([
        {
          role: 'user',
          parts: [
            { text: expect.any(String) },
            { inlineData: { data: audio.toString('base64'), mimeType: 'audio/ogg' } },
          ],
        },
      ]);
    });

    it('recusa entrada sem texto e sem áudio, sem chamar a IA', async () => {
      const { parser, generateContent } = setup();

      const error = await parseError(parser.parse({ now: NOW }));

      expect(error.reason).toBe('unexpected');
      expect(generateContent).not.toHaveBeenCalled();
    });
  });

  describe('resposta válida', () => {
    it('devolve as transações', async () => {
      const { parser, generateContent } = setup();
      generateContent.mockResolvedValue(
        registerResponse([almoco, { ...almoco, amountCents: 1850, description: 'Uber' }]),
      );

      const result = await parser.parse({ text: 'almoço 32 e uber 18,50', now: NOW });

      expect(result.intent).toBe('register');
      expect(result.transactions.map((t) => t.amountCents)).toEqual([3200, 1850]);
    });

    it('aceita "clarify" sem transações', async () => {
      const { parser, generateContent } = setup();
      generateContent.mockResolvedValue(
        response({
          intent: 'clarify',
          transactions: [],
          transcript: null,
          reply: 'Quanto foi?',
        }),
      );

      const result = await parser.parse({ text: 'gastei no mercado', now: NOW });

      expect(result).toMatchObject({ intent: 'clarify', transactions: [], reply: 'Quanto foi?' });
    });
  });

  describe('resposta inválida (nada deve ser aceito)', () => {
    it.each([
      ['texto que não é JSON', 'Claro! Aqui está: {"intent":'],
      ['valor com centavos quebrados', { ...almoco, amountCents: 32.5 }],
      ['valor negativo', { ...almoco, amountCents: -3200 }],
      ['categoria inexistente', { ...almoco, category: 'COMIDA' }],
      ['data fora do formato', { ...almoco, occurredAt: '23/09/2026' }],
      ['categoria de receita em despesa', { ...almoco, category: 'SALARIO' }],
      ['categoria de despesa em receita', { ...almoco, type: 'INCOME' }],
    ])('%s', async (_case, transactionOrRaw) => {
      const { parser, generateContent } = setup();
      generateContent.mockResolvedValue(
        typeof transactionOrRaw === 'string'
          ? response(transactionOrRaw)
          : registerResponse([transactionOrRaw]),
      );

      const error = await parseError(parser.parse({ text: 'x', now: NOW }));

      expect(error.reason).toBe('invalid_response');
      expect(error.rawResponse).toBeDefined();
    });

    it('"register" sem nenhuma transação', async () => {
      const { parser, generateContent } = setup();
      generateContent.mockResolvedValue(registerResponse([]));

      const error = await parseError(parser.parse({ text: 'x', now: NOW }));

      expect(error.reason).toBe('invalid_response');
    });

    it('resposta vazia (ex.: bloqueada por segurança)', async () => {
      const { parser, generateContent } = setup();
      generateContent.mockResolvedValue(new GenerateContentResponse());

      const error = await parseError(parser.parse({ text: 'x', now: NOW }));

      expect(error.reason).toBe('invalid_response');
    });
  });

  describe('erros da API', () => {
    it.each([
      [400, 'API key not valid. API_KEY_INVALID', 'invalid_api_key'],
      [403, 'Permission denied', 'invalid_api_key'],
      [400, 'Invalid JSON schema', 'unexpected'],
    ])('HTTP %i (%s) vira "%s", sem tentar outro modelo', async (status, message, reason) => {
      const { parser, generateContent } = setup({ fallbackModels: ['reserva'] });
      generateContent.mockRejectedValue(new ApiError({ status, message }));

      const error = await parseError(parser.parse({ text: 'x', now: NOW }));

      expect(error.reason).toBe(reason);
      expect(generateContent).toHaveBeenCalledOnce();
    });

    it('falha de rede vira "unavailable"', async () => {
      const { parser, generateContent } = setup();
      generateContent.mockRejectedValue(new TypeError('fetch failed'));

      const error = await parseError(parser.parse({ text: 'x', now: NOW }));

      expect(error.reason).toBe('unavailable');
    });
  });

  describe('modelos reserva', () => {
    it('passa para o próximo modelo quando o principal está sobrecarregado (503)', async () => {
      const { parser, generateContent, logger, call } = setup({ fallbackModels: ['reserva'] });
      generateContent
        .mockRejectedValueOnce(new ApiError({ status: 503, message: 'high demand' }))
        .mockResolvedValueOnce(registerResponse());

      const result = await parser.parse({ text: 'almoço 32', now: NOW });

      expect(result.intent).toBe('register');
      expect(call(0).model).toBe('modelo-principal');
      expect(call(1).model).toBe('reserva');
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    it('passa para o próximo modelo quando o principal não responde a tempo', async () => {
      const { parser, generateContent, call } = setup({
        fallbackModels: ['reserva'],
        timeoutMs: 20,
      });
      // Simula um modelo travado: só termina quando o AbortSignal do timeout dispara.
      generateContent
        .mockImplementationOnce(
          (params) =>
            new Promise((_resolve, reject) => {
              params.config?.abortSignal?.addEventListener('abort', () => {
                reject(new Error('aborted'));
              });
            }),
        )
        .mockResolvedValueOnce(registerResponse());

      const result = await parser.parse({ text: 'almoço 32', now: NOW });

      expect(result.intent).toBe('register');
      expect(call(1).model).toBe('reserva');
    });

    it.each([
      ['por minuto', 'Resource exhausted. Quota ...PerMinutePerProjectPerModel...', 'rate_limit'],
      [
        'diária',
        'Quota exceeded. quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier',
        'daily_quota',
      ],
    ])('cota %s esgotada (429) passa para o próximo modelo', async (_kind, message, reason) => {
      const { parser, generateContent, call } = setup({ fallbackModels: ['reserva'] });
      generateContent
        .mockRejectedValueOnce(new ApiError({ status: 429, message }))
        .mockResolvedValueOnce(registerResponse());

      await parser.parse({ text: 'almoço 32', now: NOW });
      expect(call(1).model).toBe('reserva');

      // Todos sem cota: o motivo informado é o da cota.
      generateContent.mockRejectedValue(new ApiError({ status: 429, message }));
      const error = await parseError(parser.parse({ text: 'x', now: NOW }));
      expect(error.reason).toBe(reason);
    });

    it('desiste com "unavailable" se todos os modelos falharem', async () => {
      const { parser, generateContent } = setup({ fallbackModels: ['reserva-1', 'reserva-2'] });
      generateContent.mockRejectedValue(new ApiError({ status: 503, message: 'high demand' }));

      const error = await parseError(parser.parse({ text: 'x', now: NOW }));

      expect(error.reason).toBe('unavailable');
      expect(generateContent).toHaveBeenCalledTimes(3);
    });
  });

  describe('cartões do usuário', () => {
    const accounts = [
      { name: 'Itaú', kind: 'BANK' as const },
      { name: 'Itaú', kind: 'CREDIT_CARD' as const },
      { name: 'VA', kind: 'FOOD_VOUCHER' as const },
    ];

    it('limita "account" aos nomes cadastrados, sem repetir', async () => {
      const { parser, generateContent, call } = setup();
      generateContent.mockResolvedValue(registerResponse());

      await parser.parse({ text: 'almoço 32', now: NOW, accounts });

      expect(call().config?.responseJsonSchema).toMatchObject({
        properties: {
          transactions: {
            items: {
              properties: {
                account: { anyOf: [{ type: 'string', enum: ['Itaú', 'VA'] }, { type: 'null' }] },
              },
            },
          },
        },
      });
    });

    it('sem cartões, "account" só pode ser null', async () => {
      const { parser, generateContent, call } = setup();
      generateContent.mockResolvedValue(registerResponse());

      await parser.parse({ text: 'almoço 32', now: NOW });

      expect(call().config?.responseJsonSchema).toMatchObject({
        properties: { transactions: { items: { properties: { account: { type: 'null' } } } } },
      });
    });

    it('lista os cartões no prompt, agrupando os tipos pelo nome', async () => {
      const { parser, generateContent, call } = setup();
      generateContent.mockResolvedValue(registerResponse());

      await parser.parse({ text: 'almoço 32', now: NOW, accounts });

      const prompt = call().config?.systemInstruction;
      expect(prompt).toContain('"Itaú": conta bancária (débito e pix), cartão de crédito');
      expect(prompt).toContain('"VA": vale-alimentação (VA)');
    });

    it('aceita a recarga de VA como receita', async () => {
      const { parser, generateContent } = setup();
      generateContent.mockResolvedValue(
        registerResponse([
          {
            ...almoco,
            type: 'INCOME',
            amountCents: 60000,
            description: 'VA',
            category: 'VALE_ALIMENTACAO',
            paymentMethod: 'VA',
            account: 'VA',
          },
        ]),
      );

      const result = await parser.parse({ text: 'recebi 600 de VA', now: NOW, accounts });

      expect(result.transactions[0]).toMatchObject({
        type: 'INCOME',
        category: 'VALE_ALIMENTACAO',
      });
    });
  });
});
