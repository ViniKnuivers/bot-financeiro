import { z } from 'zod';
import { Category, PaymentMethod, TransactionType } from '../../generated/prisma/enums.js';

// Os enums vêm do Prisma Client gerado: o schema.prisma é a única fonte da verdade.

export const EXPENSE_CATEGORIES = [
  'ALIMENTACAO',
  'MERCADO',
  'TRANSPORTE',
  'MORADIA',
  'CONTAS',
  'SAUDE',
  'EDUCACAO',
  'LAZER',
  'ASSINATURAS',
  'COMPRAS',
  'OUTROS',
] as const satisfies readonly Category[];

export const INCOME_CATEGORIES = [
  'SALARIO',
  'ESTAGIO',
  'FREELA',
  'OUTROS_RECEITA',
  'VALE_REFEICAO',
  'VALE_ALIMENTACAO',
] as const satisfies readonly Category[];

export const INVESTMENT_CATEGORIES = ['INVESTIMENTO'] as const satisfies readonly Category[];

const CATEGORIES_BY_TYPE: Record<TransactionType, readonly Category[]> = {
  EXPENSE: EXPENSE_CATEGORIES,
  INCOME: INCOME_CATEGORIES,
  INVESTMENT: INVESTMENT_CATEGORIES,
  REDEMPTION: INVESTMENT_CATEGORIES,
};

/** Limite da coluna INTEGER do Postgres. */
export const MAX_AMOUNT_CENTS = 2_147_483_647;

/**
 * Uma transação ainda não salva, no formato que a IA devolve.
 * Sem transforms/refines de propósito: este schema também é convertido no JSON Schema
 * enviado ao Gemini (structured output), e essas coisas não têm representação lá.
 */
export const transactionDraftSchema = z.object({
  type: z.enum(TransactionType),
  amountCents: z
    .int()
    .min(1)
    .max(MAX_AMOUNT_CENTS)
    .describe('Valor em centavos, sempre positivo. Ex.: R$ 18,50 = 1850.'),
  description: z.string().min(1).max(120).describe('Descrição curta, sem valor nem data.'),
  category: z.enum(Category),
  paymentMethod: z.enum(PaymentMethod).nullable(),
  // O JSON Schema enviado à IA troca este campo por um enum com os nomes dos cartões
  // cadastrados (ver parse-result.schema.ts). Aqui aceita qualquer nome: o resolver de
  // pagamento ignora nomes que não existem.
  account: z
    .string()
    .min(1)
    .nullable()
    .describe('Nome exato do cartão/conta mencionado, da lista do usuário; null se não citado.'),
  installments: z
    .int()
    .min(1)
    .max(48)
    .describe('Número de parcelas ("em 3x" = 3). 1 para compra à vista.'),
  occurredAt: z.iso.date().describe('Data da transação no formato YYYY-MM-DD.'),
});

export type TransactionDraft = z.infer<typeof transactionDraftSchema>;

/** Regra de negócio que o JSON Schema não expressa: categoria compatível com o tipo. */
export function isCategoryAllowedForType(category: Category, type: TransactionType): boolean {
  return CATEGORIES_BY_TYPE[type].includes(category);
}
