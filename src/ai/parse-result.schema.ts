import { z } from 'zod';
import {
  isCategoryAllowedForType,
  transactionDraftSchema,
} from '../modules/transactions/transaction.schemas.js';

/** Formato que a IA deve devolver. */
export const parseResultSchema = z.object({
  intent: z
    .enum(['register', 'clarify', 'other'])
    .describe('register: salvar; clarify: falta informação; other: não é um lançamento.'),
  transactions: z.array(transactionDraftSchema),
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
const { $schema, ...jsonSchema } = z.toJSONSchema(parseResultSchema, {
  target: 'draft-2020-12',
  override: (ctx) => {
    delete ctx.jsonSchema.pattern;
  },
});
export const parseResultJsonSchema = jsonSchema;

/**
 * Validação completa, com as regras que não cabem no JSON Schema.
 * O structured output reduz, mas não elimina, respostas fora do contrato:
 * nada é salvo sem passar por aqui.
 */
export const validParseResultSchema = parseResultSchema.superRefine((result, ctx) => {
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
