import { describe, expect, it } from 'vitest';
import type { PendingDraft } from '../pending/pending.repository.js';
import {
  applyAccount,
  applyMethod,
  nextQuestion,
  resetMethod,
  resolveDraft,
  type AccountRef,
} from './payment-resolver.js';

// A configuração real do usuário.
const ITAU_CONTA: AccountRef = { id: 1, name: 'Itaú', kind: 'BANK' };
const ITAU_CREDITO: AccountRef = { id: 2, name: 'Itaú', kind: 'CREDIT_CARD' };
const SANTANDER: AccountRef = { id: 3, name: 'Santander', kind: 'CREDIT_CARD' };
const VR: AccountRef = { id: 4, name: 'VR', kind: 'MEAL_VOUCHER' };
const VA: AccountRef = { id: 5, name: 'VA', kind: 'FOOD_VOUCHER' };
const ACCOUNTS = [ITAU_CONTA, ITAU_CREDITO, SANTANDER, VR, VA];

function draft(overrides: Partial<PendingDraft> = {}): PendingDraft {
  return {
    type: 'EXPENSE',
    amountCents: 50000,
    description: 'Cadeira',
    category: 'COMPRAS',
    paymentMethod: null,
    account: null,
    installments: 1,
    occurredAt: '2026-09-24',
    accountId: null,
    ...overrides,
  };
}

describe('resolveDraft', () => {
  it('sem forma de pagamento: pergunta, oferecendo VR/VA porque existem', () => {
    expect(resolveDraft(draft(), ACCOUNTS)).toEqual({
      status: 'needs_method',
      methods: ['PIX', 'DEBITO', 'CREDITO', 'VR', 'VA', 'DINHEIRO', 'OUTRO'],
    });
  });

  it('sem cartões de vale cadastrados, não oferece VR/VA', () => {
    expect(resolveDraft(draft(), [ITAU_CONTA])).toEqual({
      status: 'needs_method',
      methods: ['PIX', 'DEBITO', 'CREDITO', 'DINHEIRO', 'OUTRO'],
    });
  });

  it.each([
    ['PIX', ITAU_CONTA.id],
    ['DEBITO', ITAU_CONTA.id],
    ['VR', VR.id],
    ['VA', VA.id],
  ] as const)('%s com uma única conta compatível: escolhe sozinho', (method, accountId) => {
    expect(resolveDraft(draft({ paymentMethod: method }), ACCOUNTS)).toEqual({
      status: 'resolved',
      paymentMethod: method,
      accountId,
    });
  });

  it('crédito com dois cartões: pergunta qual', () => {
    expect(resolveDraft(draft({ paymentMethod: 'CREDITO' }), ACCOUNTS)).toEqual({
      status: 'needs_account',
      paymentMethod: 'CREDITO',
      accounts: [ITAU_CREDITO, SANTANDER],
    });
  });

  it('crédito com o cartão citado ("no santander"): não pergunta', () => {
    expect(
      resolveDraft(draft({ paymentMethod: 'CREDITO', account: 'Santander' }), ACCOUNTS),
    ).toEqual({ status: 'resolved', paymentMethod: 'CREDITO', accountId: SANTANDER.id });
  });

  it('nome citado sem acento e em minúsculas também vale ("itau")', () => {
    expect(resolveDraft(draft({ paymentMethod: 'CREDITO', account: 'itau' }), ACCOUNTS)).toEqual({
      status: 'resolved',
      paymentMethod: 'CREDITO',
      accountId: ITAU_CREDITO.id,
    });
  });

  it('"no itaú" sem forma: pergunta só as formas que o Itaú aceita', () => {
    expect(resolveDraft(draft({ account: 'Itaú' }), ACCOUNTS)).toEqual({
      status: 'needs_method',
      methods: ['PIX', 'DEBITO', 'CREDITO'],
    });
  });

  it('"no santander" sem forma: só tem crédito, então resolve sozinho', () => {
    expect(resolveDraft(draft({ account: 'Santander' }), ACCOUNTS)).toEqual({
      status: 'resolved',
      paymentMethod: 'CREDITO',
      accountId: SANTANDER.id,
    });
  });

  it.each(['DINHEIRO', 'OUTRO'] as const)('%s não usa conta', (method) => {
    expect(resolveDraft(draft({ paymentMethod: method }), ACCOUNTS)).toEqual({
      status: 'resolved',
      paymentMethod: method,
      accountId: null,
    });
  });

  it('forma sem nenhuma conta do tipo cadastrada: salva sem conta em vez de travar', () => {
    expect(resolveDraft(draft({ paymentMethod: 'CREDITO' }), [ITAU_CONTA])).toEqual({
      status: 'resolved',
      paymentMethod: 'CREDITO',
      accountId: null,
    });
  });

  it('cartão já escolhido nos botões: resolvido', () => {
    expect(
      resolveDraft(draft({ paymentMethod: 'CREDITO', accountId: SANTANDER.id }), ACCOUNTS),
    ).toEqual({ status: 'resolved', paymentMethod: 'CREDITO', accountId: SANTANDER.id });
  });

  it('cartão escolhido e removido antes de salvar: refaz a escolha com os que sobraram', () => {
    const semSantander = ACCOUNTS.filter((a) => a !== SANTANDER);
    const withRemovedCard = draft({ paymentMethod: 'CREDITO', accountId: SANTANDER.id });

    // Sobrou só o Itaú crédito, então ele é escolhido sozinho (com dois, perguntaria).
    expect(resolveDraft(withRemovedCard, semSantander)).toEqual({
      status: 'resolved',
      paymentMethod: 'CREDITO',
      accountId: ITAU_CREDITO.id,
    });
  });

  describe('receitas', () => {
    it('recarga de VA cai no cartão VA, sem perguntar', () => {
      const recarga = draft({ type: 'INCOME', category: 'VALE_ALIMENTACAO', description: 'VA' });

      expect(resolveDraft(recarga, ACCOUNTS)).toEqual({
        status: 'resolved',
        paymentMethod: 'VA',
        accountId: VA.id,
      });
    });

    it('o cartão citado pelo nome vence a categoria (VR chamado "Alimentação")', () => {
      const alimentacao: AccountRef = { id: 10, name: 'Alimentação', kind: 'MEAL_VOUCHER' };
      const mercado: AccountRef = { id: 11, name: 'Mercado', kind: 'FOOD_VOUCHER' };
      const recarga = draft({
        type: 'INCOME',
        category: 'VALE_ALIMENTACAO',
        account: 'alimentacao',
      });

      expect(resolveDraft(recarga, [alimentacao, mercado])).toEqual({
        status: 'resolved',
        paymentMethod: 'VR',
        accountId: alimentacao.id,
      });
    });

    it('salário não pergunta forma de pagamento', () => {
      const salario = draft({ type: 'INCOME', category: 'SALARIO' });

      expect(resolveDraft(salario, ACCOUNTS)).toEqual({
        status: 'resolved',
        paymentMethod: null,
        accountId: null,
      });
    });
  });
});

describe('nextQuestion', () => {
  it('agrupa itens com a mesma pergunta ("Como você pagou estes 2?")', () => {
    const drafts = [draft({ description: 'Almoço' }), draft({ description: 'Uber' })];

    expect(nextQuestion(drafts, ACCOUNTS)?.indices).toEqual([0, 1]);
  });

  it('pergunta um de cada vez quando as perguntas são diferentes', () => {
    const drafts = [draft({ account: 'Itaú' }), draft()];

    expect(nextQuestion(drafts, ACCOUNTS)?.indices).toEqual([0]);
  });

  it('ignora itens já resolvidos e retorna null quando não falta nada', () => {
    const drafts = [draft({ paymentMethod: 'PIX' }), draft()];
    expect(nextQuestion(drafts, ACCOUNTS)?.indices).toEqual([1]);

    expect(nextQuestion([draft({ paymentMethod: 'PIX' })], ACCOUNTS)).toBeNull();
  });

  it('fluxo completo: forma → cartão → voltar → forma', () => {
    let drafts = [draft()];

    drafts = applyMethod(drafts, [0], 'CREDITO');
    const card = nextQuestion(drafts, ACCOUNTS);
    expect(card?.question.status).toBe('needs_account');

    const voltou = resetMethod(drafts, [0]);
    expect(nextQuestion(voltou, ACCOUNTS)?.question.status).toBe('needs_method');

    drafts = applyAccount(drafts, [0], SANTANDER.id);
    expect(nextQuestion(drafts, ACCOUNTS)).toBeNull();
  });
});
