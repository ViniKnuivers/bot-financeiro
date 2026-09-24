import type { AccountKind, Category, PaymentMethod } from '../../generated/prisma/enums.js';

/** Qual tipo de conta atende cada forma de pagamento. Dinheiro e Outro não usam conta. */
export const ACCOUNT_KIND_BY_METHOD: Partial<Record<PaymentMethod, AccountKind>> = {
  PIX: 'BANK',
  DEBITO: 'BANK',
  CREDITO: 'CREDIT_CARD',
  VR: 'MEAL_VOUCHER',
  VA: 'FOOD_VOUCHER',
};

export function methodsForKind(kind: AccountKind): PaymentMethod[] {
  return (Object.keys(ACCOUNT_KIND_BY_METHOD) as PaymentMethod[]).filter(
    (method) => ACCOUNT_KIND_BY_METHOD[method] === kind,
  );
}

/** Receitas de vale que caem direto no cartão correspondente ("recebi 600 de VA"). */
export const VOUCHER_METHOD_BY_INCOME_CATEGORY: Partial<Record<Category, PaymentMethod>> = {
  VALE_REFEICAO: 'VR',
  VALE_ALIMENTACAO: 'VA',
};

export function isVoucher(kind: AccountKind): boolean {
  return kind === 'MEAL_VOUCHER' || kind === 'FOOD_VOUCHER';
}

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  BANK: 'conta',
  CREDIT_CARD: 'crédito',
  MEAL_VOUCHER: 'VR',
  FOOD_VOUCHER: 'VA',
};

export const ACCOUNT_KIND_ICONS: Record<AccountKind, string> = {
  BANK: '🏦',
  CREDIT_CARD: '💳',
  MEAL_VOUCHER: '🍽️',
  FOOD_VOUCHER: '🛒',
};

/**
 * Nome para exibir: "Itaú (conta)", "Santander (crédito)", "Flash (VA)".
 * Um vale chamado só "VA" aparece como "VA", sem repetir.
 */
export function accountLabel(account: { name: string; kind: AccountKind }): string {
  const kindLabel = ACCOUNT_KIND_LABELS[account.kind];
  return normalizeName(account.name) === normalizeName(kindLabel)
    ? account.name
    : `${account.name} (${kindLabel})`;
}

/** Comparação de nomes sem diferenciar maiúsculas nem acentos: "itau" = "Itaú". */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}
