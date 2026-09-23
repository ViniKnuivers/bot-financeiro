import type { Category, PaymentMethod, TransactionType } from '../../generated/prisma/enums.js';

// `Record<Enum, string>` obriga a ter um rótulo para cada valor: se uma categoria
// nova for criada no schema.prisma, o TypeScript acusa aqui até ela ganhar nome.

export const CATEGORY_LABELS: Record<Category, string> = {
  ALIMENTACAO: 'Alimentação',
  MERCADO: 'Mercado',
  TRANSPORTE: 'Transporte',
  MORADIA: 'Moradia',
  CONTAS: 'Contas',
  SAUDE: 'Saúde',
  EDUCACAO: 'Educação',
  LAZER: 'Lazer',
  ASSINATURAS: 'Assinaturas',
  COMPRAS: 'Compras',
  OUTROS: 'Outros',
  SALARIO: 'Salário',
  ESTAGIO: 'Estágio',
  FREELA: 'Freela',
  OUTROS_RECEITA: 'Outras receitas',
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  PIX: 'Pix',
  CREDITO: 'Crédito',
  DEBITO: 'Débito',
  DINHEIRO: 'Dinheiro',
  OUTRO: 'Outro',
};

export const TYPE_LABELS: Record<TransactionType, string> = {
  EXPENSE: 'Despesa',
  INCOME: 'Receita',
};
