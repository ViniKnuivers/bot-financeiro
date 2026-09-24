import type { AccountKind, PaymentMethod } from '../../generated/prisma/enums.js';
import {
  ACCOUNT_KIND_BY_METHOD,
  isVoucher,
  methodsForKind,
  normalizeName,
  VOUCHER_METHOD_BY_INCOME_CATEGORY,
} from '../accounts/account-kinds.js';
import type { PendingDraft } from '../pending/pending.repository.js';

/** O mínimo de uma conta de que o resolver precisa (facilita testar sem Prisma). */
export interface AccountRef {
  id: number;
  name: string;
  kind: AccountKind;
}

export type DraftResolution =
  | { status: 'resolved'; paymentMethod: PaymentMethod | null; accountId: number | null }
  | { status: 'needs_method'; methods: PaymentMethod[] }
  | { status: 'needs_account'; paymentMethod: PaymentMethod; accounts: AccountRef[] };

export type Question = Exclude<DraftResolution, { status: 'resolved' }>;

/**
 * Decide se um rascunho já pode ser salvo ou o que falta perguntar.
 * Regra geral: só pergunta o que não dá para deduzir. Com um único cartão compatível,
 * ele é escolhido sozinho (ex.: Pix/Débito → a única conta bancária).
 */
export function resolveDraft(draft: PendingDraft, accounts: AccountRef[]): DraftResolution {
  const named = draft.account
    ? accounts.filter((a) => normalizeName(a.name) === normalizeName(draft.account ?? ''))
    : [];

  // Receitas nunca perguntam nada. Receita de VR/VA cai no cartão do vale, se houver.
  if (draft.type === 'INCOME') {
    // O cartão citado pelo nome vence a categoria: com um VR chamado "Alimentação",
    // "recebi 600 de alimentação" vai para ele, e não para o VA.
    const [namedVoucher, ...others] = named.filter((a) => isVoucher(a.kind));
    if (namedVoucher && others.length === 0) {
      const [voucherMethod = null] = methodsForKind(namedVoucher.kind);
      return { status: 'resolved', paymentMethod: voucherMethod, accountId: namedVoucher.id };
    }
    const method = VOUCHER_METHOD_BY_INCOME_CATEGORY[draft.category] ?? draft.paymentMethod;
    const candidates = method ? compatible(method, accounts, named) : [];
    const only = candidates.length === 1 ? candidates[0] : undefined;
    return { status: 'resolved', paymentMethod: method, accountId: only?.id ?? null };
  }

  // Conta já escolhida nos botões (e ainda válida para a forma escolhida).
  if (draft.accountId !== null && draft.paymentMethod) {
    const chosen = accounts.find((a) => a.id === draft.accountId);
    if (chosen && ACCOUNT_KIND_BY_METHOD[draft.paymentMethod] === chosen.kind) {
      return { status: 'resolved', paymentMethod: draft.paymentMethod, accountId: chosen.id };
    }
  }

  let method = draft.paymentMethod;
  if (method === null) {
    // "no itaú": as formas possíveis são as das contas com esse nome.
    const methods =
      named.length > 0
        ? unique(named.flatMap((a) => methodsForKind(a.kind)))
        : availableMethods(accounts);
    const [only] = methods;
    if (methods.length !== 1 || !only) return { status: 'needs_method', methods };
    method = only;
  }

  if (!ACCOUNT_KIND_BY_METHOD[method]) {
    return { status: 'resolved', paymentMethod: method, accountId: null }; // dinheiro, outro
  }

  const candidates = compatible(method, accounts, named);
  if (candidates.length > 1)
    return { status: 'needs_account', paymentMethod: method, accounts: candidates };
  // Nenhuma conta desse tipo cadastrada: salva sem conta em vez de travar o registro.
  return { status: 'resolved', paymentMethod: method, accountId: candidates[0]?.id ?? null };
}

/** Formas oferecidas quando nada foi dito. VR/VA só aparecem se houver o cartão. */
export function availableMethods(accounts: AccountRef[]): PaymentMethod[] {
  const has = (kind: AccountKind) => accounts.some((a) => a.kind === kind);
  return [
    'PIX',
    'DEBITO',
    'CREDITO',
    ...(has('MEAL_VOUCHER') ? (['VR'] as const) : []),
    ...(has('FOOD_VOUCHER') ? (['VA'] as const) : []),
    'DINHEIRO',
    'OUTRO',
  ];
}

export interface NextQuestion {
  question: Question;
  /** Índices dos rascunhos a que a pergunta se aplica. */
  indices: number[];
}

/**
 * A próxima pergunta a fazer, ou null se tudo estiver resolvido.
 * Itens com a mesma pergunta são agrupados ("Como você pagou esses 2?"), porque numa
 * mesma mensagem quase sempre é a mesma forma de pagamento. Itens com perguntas
 * diferentes são perguntados um de cada vez.
 */
export function nextQuestion(drafts: PendingDraft[], accounts: AccountRef[]): NextQuestion | null {
  const resolutions = drafts.map((draft) => resolveDraft(draft, accounts));
  const first = resolutions.find((r): r is Question => r.status !== 'resolved');
  if (!first) return null;

  const key = questionKey(first);
  const indices = resolutions.flatMap((r, index) =>
    r.status !== 'resolved' && questionKey(r) === key ? [index] : [],
  );
  return { question: first, indices };
}

/** Aplica a forma de pagamento escolhida aos itens da pergunta. */
export function applyMethod(
  drafts: PendingDraft[],
  indices: number[],
  method: PaymentMethod,
): PendingDraft[] {
  return drafts.map((draft, index) =>
    indices.includes(index) ? { ...draft, paymentMethod: method, accountId: null } : draft,
  );
}

/** Aplica o cartão/conta escolhido aos itens da pergunta. */
export function applyAccount(
  drafts: PendingDraft[],
  indices: number[],
  accountId: number,
): PendingDraft[] {
  return drafts.map((draft, index) => (indices.includes(index) ? { ...draft, accountId } : draft));
}

/** "Voltar" na pergunta do cartão: desfaz a forma escolhida para perguntar de novo. */
export function resetMethod(drafts: PendingDraft[], indices: number[]): PendingDraft[] {
  return drafts.map((draft, index) =>
    indices.includes(index)
      ? { ...draft, paymentMethod: null, accountId: null, account: null }
      : draft,
  );
}

function compatible(
  method: PaymentMethod,
  accounts: AccountRef[],
  named: AccountRef[],
): AccountRef[] {
  const kind = ACCOUNT_KIND_BY_METHOD[method];
  const ofKind = accounts.filter((a) => a.kind === kind);
  // Se o usuário citou um nome ("no crédito do itaú"), restringe; se o nome não bate
  // com nenhuma conta desse tipo, ignora o nome em vez de descartar as opções.
  const narrowed = ofKind.filter((a) => named.includes(a));
  return narrowed.length > 0 ? narrowed : ofKind;
}

function questionKey(question: Question): string {
  return question.status === 'needs_method'
    ? `method:${question.methods.join(',')}`
    : `account:${question.paymentMethod}:${question.accounts.map((a) => a.id).join(',')}`;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
