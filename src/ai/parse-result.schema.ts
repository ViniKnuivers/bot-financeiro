import { z } from 'zod';
import { Category, PaymentMethod, TransactionType } from '../generated/prisma/enums.js';
import {
  isCategoryAllowedForType,
  MAX_AMOUNT_CENTS,
  transactionDraftSchema,
} from '../modules/transactions/transaction.schemas.js';

export const QUERY_KINDS = ['total', 'compare', 'ranking', 'list', 'can_afford'] as const;

/**
 * Uma pergunta sobre os lançamentos, já traduzida em filtros. A IA só entende a pergunta:
 * a conta é feita pelo bot (src/modules/insights/query.ts), então os números nunca vêm
 * da IA. Sem transforms/refines aqui, pelo mesmo motivo do transactionDraftSchema.
 */
export const querySchema = z.object({
  kind: z
    .enum(QUERY_KINDS)
    .describe(
      'total: soma; compare: dois períodos; ranking: qual mês/categoria mais; list: lançamentos (ou o maior); can_afford: "posso gastar X?".',
    ),
  type: z.enum(TransactionType).nullable().describe('Tipo dos lançamentos; null = despesas.'),
  categories: z.array(z.enum(Category)).describe('Categorias citadas; [] = todas.'),
  text: z
    .string()
    .min(1)
    .max(60)
    .nullable()
    .describe('Nome/trecho da descrição citado (ex.: "uber", "ifood"); null se não houver.'),
  account: z
    .string()
    .min(1)
    .nullable()
    .describe('Nome exato do cartão/conta citado, da lista do usuário; null se não citado.'),
  paymentMethod: z.enum(PaymentMethod).nullable(),
  periodStart: z.iso.date().describe('Início do período perguntado (YYYY-MM-DD).'),
  periodEnd: z.iso.date().describe('Fim do período perguntado (YYYY-MM-DD).'),
  compareStart: z.iso.date().nullable().describe('Só em compare: início do outro período.'),
  compareEnd: z.iso.date().nullable().describe('Só em compare: fim do outro período.'),
  rankBy: z.enum(['month', 'category']).nullable().describe('Só em ranking.'),
  sort: z.enum(['recent', 'largest']).nullable().describe('Só em list.'),
  limit: z.int().min(1).max(10).nullable().describe('Só em list: quantos mostrar.'),
  amountCents: z
    .int()
    .min(1)
    .max(MAX_AMOUNT_CENTS)
    .nullable()
    .describe('Só em can_afford: valor que o usuário quer gastar, em centavos.'),
});

export type Query = z.infer<typeof querySchema>;

/** Formato que a IA deve devolver. */
export const parseResultSchema = z.object({
  intent: z
    .enum(['register', 'clarify', 'query', 'other'])
    .describe(
      'register: salvar; clarify: falta informação; query: pergunta sobre os gastos; other: nenhum dos outros.',
    ),
  transactions: z.array(transactionDraftSchema),
  // default(null): respostas antigas (e testes) sem o campo continuam válidas.
  query: querySchema.nullable().default(null),
  transcript: z.string().nullable().describe('Transcrição literal do áudio; null para texto.'),
  reply: z.string().min(1).describe('Mensagem curta para o usuário, em português.'),
});

export type ParseResult = z.infer<typeof parseResultSchema>;

/**
 * JSON Schema gerado a partir do Zod e enviado como `responseJsonSchema`: uma única
 * definição serve para instruir o modelo e para validar a resposta.
 * O Gemini não suporta `pattern` (que o Zod gera para datas ISO); o `format: "date"`
 * que fica no lugar já orienta o modelo, e a validação real é feita pelo Zod depois.
 */
const { $schema, ...baseJsonSchema } = z.toJSONSchema(parseResultSchema, {
  target: 'draft-2020-12',
  override: (ctx) => {
    delete ctx.jsonSchema.pattern;
  },
});

/**
 * JSON Schema de uma chamada: os campos `account` (do lançamento e da pergunta) viram um
 * enum com os nomes dos cartões cadastrados, para a IA só poder devolver um nome que
 * existe (ou null).
 */
export function buildParseResultJsonSchema(
  accountNames: readonly string[],
): Record<string, unknown> {
  // O Zod tipa o JSON Schema de forma genérica; aqui sabemos o formato exato do nosso.
  const schema = structuredClone(baseJsonSchema) as unknown as {
    properties: {
      transactions: { items: { properties: Record<string, unknown> } };
      query: { anyOf: { properties?: Record<string, unknown> }[] };
    };
  };
  const names = [...new Set(accountNames)];
  const account =
    names.length > 0
      ? { anyOf: [{ type: 'string', enum: names }, { type: 'null' }] }
      : { type: 'null' };
  schema.properties.transactions.items.properties.account = account;
  const queryObject = schema.properties.query.anyOf.find((option) => option.properties);
  if (queryObject?.properties) queryObject.properties.account = account;
  return schema;
}

/**
 * Validação completa, com as regras que não cabem no JSON Schema.
 * O structured output reduz, mas não elimina, respostas fora do contrato:
 * nada é salvo sem passar por aqui.
 */
export const validParseResultSchema = parseResultSchema.superRefine((result, ctx) => {
  if (result.intent === 'query') validateQuery(result.query, ctx);

  if (result.intent === 'register' && result.transactions.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['transactions'],
      message: 'intent "register" sem transações',
    });
  }

  result.transactions.forEach((transaction, index) => {
    if (!isCategoryAllowedForType(transaction.category, transaction.type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['transactions', index, 'category'],
        message: `categoria ${transaction.category} não combina com ${transaction.type}`,
      });
    }
  });
});

/** Regras da pergunta que o JSON Schema não expressa. */
function validateQuery(query: Query | null, ctx: z.RefinementCtx): void {
  if (!query) {
    ctx.addIssue({ code: 'custom', path: ['query'], message: 'intent "query" sem a pergunta' });
    return;
  }
  const issue = (path: string, message: string) => {
    ctx.addIssue({ code: 'custom', path: ['query', path], message });
  };
  if (query.periodStart > query.periodEnd) issue('periodEnd', 'período invertido');
  if (query.kind === 'compare' && (!query.compareStart || !query.compareEnd)) {
    issue('compareStart', 'compare sem o segundo período');
  }
  if (query.kind === 'can_afford' && query.amountCents === null) {
    issue('amountCents', 'can_afford sem o valor');
  }
}
