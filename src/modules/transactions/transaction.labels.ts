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
  VALE_REFEICAO: 'Vale-refeição',
  VALE_ALIMENTACAO: 'Vale-alimentação',
  INVESTIMENTO: 'Investimento',
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  PIX: 'Pix',
  CREDITO: 'Crédito',
  DEBITO: 'Débito',
  DINHEIRO: 'Dinheiro',
  VR: 'VR',
  VA: 'VA',
  OUTRO: 'Outro',
};

export const TYPE_LABELS: Record<TransactionType, string> = {
  EXPENSE: 'Despesa',
  INCOME: 'Receita',
  INVESTMENT: 'Aporte',
  REDEMPTION: 'Resgate',
};

export const TYPE_ICONS: Record<TransactionType, string> = {
  EXPENSE: '💸',
  INCOME: '💰',
  INVESTMENT: '📈',
  REDEMPTION: '📤',
};

export const CATEGORY_ICONS: Record<Category, string> = {
  ALIMENTACAO: '🍔',
  MERCADO: '🛒',
  TRANSPORTE: '🚗',
  MORADIA: '🏠',
  CONTAS: '🧾',
  SAUDE: '💊',
  EDUCACAO: '📚',
  LAZER: '🎉',
  ASSINATURAS: '📺',
  COMPRAS: '🛍️',
  OUTROS: '📦',
  SALARIO: '💼',
  ESTAGIO: '🎓',
  FREELA: '💻',
  OUTROS_RECEITA: '💵',
  VALE_REFEICAO: '🍽️',
  VALE_ALIMENTACAO: '🧺',
  INVESTIMENTO: '📈',
};

/** "🍔 Alimentação": como a categoria aparece na planilha. */
export function categoryLabelWithIcon(category: Category): string {
  return `${CATEGORY_ICONS[category]} ${CATEGORY_LABELS[category]}`;
}
