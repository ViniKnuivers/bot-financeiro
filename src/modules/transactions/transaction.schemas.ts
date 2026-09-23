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
] as const satisfies readonly Category[];

/** Limite da coluna INTEGER do Postgres. */
const MAX_AMOUNT_CENTS = 2_147_483_647;

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
  occurredAt: z.iso.date().describe('Data da transação no formato YYYY-MM-DD.'),
});

export type TransactionDraft = z.infer<typeof transactionDraftSchema>;

/** Regra de negócio que o JSON Schema não expressa: categoria compatível com o tipo. */
export function isCategoryAllowedForType(category: Category, type: TransactionType): boolean {
  const allowed: readonly Category[] = type === 'INCOME' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  return allowed.includes(category);
}
