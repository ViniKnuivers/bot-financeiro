import type { AccountKind } from '../generated/prisma/enums.js';
import type { ParseResult } from './parse-result.schema.js';

export type { ParseResult } from './parse-result.schema.js';

export interface ParseInput {
  text?: string;
  audio?: Buffer;
  mimeType?: string;
  /** Momento de referência para resolver datas relativas ("ontem", "sexta"). */
  now: Date;
  /** Cartões e contas do usuário, para a IA reconhecer "no itaú", "no VA". */
  accounts?: readonly AccountHint[];
  /** Destinos de investimento já usados, para a IA repetir o mesmo nome. */
  investmentDestinations?: readonly string[];
}

export interface AccountHint {
  name: string;
  kind: AccountKind;
}

/** Transforma linguagem natural em transações estruturadas. Trocável (Gemini, outro LLM, mock). */
export interface TransactionParser {
  parse(input: ParseInput): Promise<ParseResult>;
}

export type TransactionParserErrorReason =
  'timeout' | 'rate_limit' | 'invalid_api_key' | 'unavailable' | 'invalid_response' | 'unexpected';

/**
 * Erro com motivo tipado: quem chama decide a mensagem para o usuário
 * sem precisar conhecer os erros específicos de cada SDK.
 */
export class TransactionParserError extends Error {
  override readonly name = 'TransactionParserError';
  /** Resposta crua do modelo, quando existir, para depuração nos logs. */
  readonly rawResponse: string | undefined;

  constructor(
    readonly reason: TransactionParserErrorReason,
    message: string,
    options?: { cause?: unknown; rawResponse?: string },
  ) {
    super(message, { cause: options?.cause });
    this.rawResponse = options?.rawResponse;
  }
}
