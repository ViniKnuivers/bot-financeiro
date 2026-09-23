import { ApiError, ThinkingLevel, type Models, type Part } from '@google/genai';
import { z } from 'zod';
import { toDateOnlyString } from '../lib/dates.js';
import type { Logger } from '../lib/logger.js';
import { buildTransactionParserPrompt } from '../prompts/transaction-parser.prompt.js';
import { parseResultJsonSchema, validParseResultSchema } from './parse-result.schema.js';
import {
  TransactionParserError,
  type ParseInput,
  type ParseResult,
  type TransactionParser,
  type TransactionParserErrorReason,
} from './transaction-parser.js';

export interface GeminiTransactionParserOptions {
  /** `new GoogleGenAI({ apiKey }).models`. Recebido pronto para poder ser mockado nos testes. */
  models: Pick<Models, 'generateContent'>;
  model: string;
  /** Modelos tentados, em ordem, quando o anterior está indisponível (503 "high demand"). */
  fallbackModels?: string[];
  timeZone: string;
  logger: Logger;
  /** Limite por tentativa (por modelo). Respostas normais levam de 1 a 4 segundos. */
  timeoutMs?: number;
  /** Quantas vezes percorrer a lista de modelos de novo se todos falharem. */
  retriesOnUnavailable?: number;
}

/** Falhas específicas de um modelo, que valem tentar em outro. */
const FALLBACK_REASONS = new Set<TransactionParserErrorReason>(['unavailable', 'timeout']);

export class GeminiTransactionParser implements TransactionParser {
  private readonly models: Pick<Models, 'generateContent'>;
  private readonly modelChain: string[];
  private readonly timeZone: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly retriesOnUnavailable: number;

  constructor(options: GeminiTransactionParserOptions) {
    this.models = options.models;
    this.modelChain = [options.model, ...(options.fallbackModels ?? [])];
    this.timeZone = options.timeZone;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    // A lista de modelos já funciona como nova tentativa; percorrê-la de novo por
    // padrão só aumentaria a espera do usuário.
    this.retriesOnUnavailable = options.retriesOnUnavailable ?? 0;
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    const parts = buildParts(input);
    const systemInstruction = buildTransactionParserPrompt({
      today: toDateOnlyString(input.now, this.timeZone),
      timeZone: this.timeZone,
    });

    const raw = await this.generateWithRetry(parts, systemInstruction);
    return validate(raw);
  }

  /**
   * Na camada gratuita, um modelo específico às vezes fica sobrecarregado (503) ou trava
   * sem responder, enquanto outros funcionam normalmente. Nesses dois casos, passa para o
   * próximo modelo da lista. Qualquer outro erro (chave, limite de uso) para na hora.
   */
  private async generateWithRetry(parts: Part[], systemInstruction: string): Promise<string> {
    let lastError: TransactionParserError | undefined;

    for (let round = 0; round <= this.retriesOnUnavailable; round++) {
      if (round > 0) await sleep(1000 * round);

      for (const model of this.modelChain) {
        try {
          return await this.generate(model, parts, systemInstruction);
        } catch (error) {
          if (!(error instanceof TransactionParserError) || !FALLBACK_REASONS.has(error.reason)) {
            throw error;
          }
          this.logger.warn(
            { model, round, reason: error.reason },
            'ia: modelo não respondeu, tentando o próximo',
          );
          lastError = error;
        }
      }
    }

    throw lastError ?? new TransactionParserError('unavailable', 'nenhum modelo configurado');
  }

  private async generate(model: string, parts: Part[], systemInstruction: string): Promise<string> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseJsonSchema: parseResultJsonSchema,
          // Extração simples não precisa de raciocínio longo: menos latência e menos cota.
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          abortSignal: signal,
        },
      });

      const text = response.text;
      if (!text) {
        throw new TransactionParserError(
          'invalid_response',
          `resposta vazia (finishReason: ${response.candidates?.[0]?.finishReason ?? 'desconhecido'})`,
        );
      }
      return text;
    } catch (error) {
      throw toParserError(error, signal);
    }
  }
}

function buildParts(input: ParseInput): Part[] {
  const parts: Part[] = [];
  if (input.audio) {
    if (!input.mimeType) {
      throw new TransactionParserError('unexpected', 'mimeType é obrigatório para áudio');
    }
    parts.push({ text: 'Mensagem de voz do usuário:' });
    parts.push({ inlineData: { data: input.audio.toString('base64'), mimeType: input.mimeType } });
  }
  if (input.text) {
    parts.push({ text: input.text });
  }
  if (parts.length === 0) {
    throw new TransactionParserError('unexpected', 'entrada sem texto nem áudio');
  }
  return parts;
}

function validate(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new TransactionParserError('invalid_response', 'resposta não é JSON válido', {
      cause,
      rawResponse: raw,
    });
  }

  const result = validParseResultSchema.safeParse(json);
  if (!result.success) {
    throw new TransactionParserError(
      'invalid_response',
      `resposta fora do contrato:\n${z.prettifyError(result.error)}`,
      { rawResponse: raw },
    );
  }
  return result.data;
}

/** Traduz erros do SDK/rede para os motivos do nosso domínio. */
function toParserError(error: unknown, signal: AbortSignal): TransactionParserError {
  if (error instanceof TransactionParserError) return error;

  if (signal.aborted) {
    return new TransactionParserError('timeout', 'Gemini não respondeu a tempo', { cause: error });
  }
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return new TransactionParserError('rate_limit', 'limite de requisições do Gemini', {
        cause: error,
      });
    }
    // Chave inválida vem como 400 (API_KEY_INVALID); sem permissão, 401/403.
    if (
      error.status === 401 ||
      error.status === 403 ||
      (error.status === 400 && error.message.includes('API_KEY_INVALID'))
    ) {
      return new TransactionParserError('invalid_api_key', 'GEMINI_API_KEY recusada', {
        cause: error,
      });
    }
    if (error.status >= 500) {
      return new TransactionParserError('unavailable', `Gemini indisponível (${error.status})`, {
        cause: error,
      });
    }
  }
  // Falha de rede do fetch (DNS, conexão recusada) também é indisponibilidade temporária.
  if (error instanceof TypeError && error.message === 'fetch failed') {
    return new TransactionParserError('unavailable', 'falha de rede ao chamar o Gemini', {
      cause: error,
    });
  }
  return new TransactionParserError('unexpected', 'erro inesperado ao chamar o Gemini', {
    cause: error,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
