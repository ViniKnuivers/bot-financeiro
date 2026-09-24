import { describe, expect, it, vi } from 'vitest';
import {
  TransactionParserError,
  type ParseResult,
  type TransactionParser,
} from '../ai/transaction-parser.js';
import type { OutgoingMessage } from '../channels/message-channel.js';
import { AccountService } from '../modules/accounts/account.service.js';
import type { TransactionDraft } from '../modules/transactions/transaction.schemas.js';
import { TransactionService } from '../modules/transactions/transaction.service.js';
import {
  InMemoryAccountRepository,
  InMemoryChatStateRepository,
  InMemoryPendingRepository,
} from '../test/in-memory-repositories.js';
import { InMemoryTransactionRepository } from '../test/in-memory-transaction-repository.js';
import { CHAT_STATE_TTL_MS } from './accounts-flow.js';
import { Assistant } from './assistant.js';

const RECEIVED_AT = new Date('2026-09-24T15:00:00Z');

function draft(overrides: Partial<TransactionDraft> = {}): TransactionDraft {
  return {
    type: 'EXPENSE',
    amountCents: 3200,
    description: 'Almoço',
    category: 'ALIMENTACAO',
    paymentMethod: 'DINHEIRO',
    account: null,
    installments: 1,
    occurredAt: '2026-09-24',
    ...overrides,
  };
}

function result(overrides: Partial<ParseResult>): ParseResult {
  return { intent: 'register', transactions: [], transcript: null, reply: 'ok', ...overrides };
}

function setup() {
  let now = RECEIVED_AT;
  const clock = () => now;
  const parse = vi.fn<TransactionParser['parse']>();
  const transactions = new InMemoryTransactionRepository();
  const accountRepository = new InMemoryAccountRepository();
  const pending = new InMemoryPendingRepository();
  const chatState = new InMemoryChatStateRepository(clock);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const accounts = new AccountService(accountRepository, transactions);
  const assistant = new Assistant({
    parser: { parse },
    transactions: new TransactionService(transactions),
    accounts,
    pending,
    chatState,
    logger,
    now: clock,
  });

  /** Id do botão com esse texto (falha o teste se ele não existir). */
  const button = (message: OutgoingMessage, label: string): string => {
    const action = message.actions?.flat().find((a) => a.label.includes(label));
    if (!action) throw new Error(`botão "${label}" não encontrado em: ${message.text}`);
    return action.id;
  };
  const say = (text: string) => assistant.handleText({ text, receivedAt: RECEIVED_AT });
  const advanceClock = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };

  return { assistant, parse, transactions, accounts, pending, logger, button, say, advanceClock };
}

/** A configuração real do usuário: Itaú (conta + crédito), Santander, VR e VA. */
async function withUserAccounts(accounts: AccountService) {
  await accounts.create('BANK_AND_CREDIT', 'Itaú');
  await accounts.create('CREDIT_CARD', 'Santander');
  await accounts.create('MEAL_VOUCHER', 'VR', 30000);
  await accounts.create('FOOD_VOUCHER', 'VA', 0);
}

describe('Assistant', () => {
  describe('mensagem de texto', () => {
    it('com a forma de pagamento dita: salva, resume e oferece Desfazer', async () => {
      const { parse, transactions, say } = setup();
      parse.mockResolvedValue(result({ transactions: [draft()] }));

      const reply = await say('almoço 32 em dinheiro');

      expect(transactions.rows).toHaveLength(1);
      expect(transactions.rows[0]).toMatchObject({
        rawInput: 'almoço 32 em dinheiro',
        source: 'TEXT',
      });
      expect(reply.text).toMatch(/R\$\s32,00/);
      expect(reply.actions).toEqual([
        [
          {
            label: expect.stringContaining('Desfazer'),
            id: `undo:${transactions.rows[0]?.batchId}`,
          },
        ],
      ]);
    });

    it('passa os cartões cadastrados e a hora da mensagem para a IA', async () => {
      const { parse, accounts, say } = setup();
      await accounts.create('CREDIT_CARD', 'Santander');
      parse.mockResolvedValue(result({ transactions: [draft()] }));

      await say('almoço ontem');

      expect(parse).toHaveBeenCalledWith({
        text: 'almoço ontem',
        now: RECEIVED_AT,
        accounts: [{ name: 'Santander', kind: 'CREDIT_CARD' }],
      });
    });

    it.each(['clarify', 'other'] as const)(
      'com intent "%s" não salva nada e repassa a resposta da IA',
      async (intent) => {
        const { parse, transactions, pending, say } = setup();
        // Mesmo que a IA mande transações junto por engano, nada pode ser salvo.
        parse.mockResolvedValue(result({ intent, transactions: [draft()], reply: 'Quanto foi?' }));

        const reply = await say('x');

        expect(transactions.rows).toHaveLength(0);
        expect(pending.rows).toHaveLength(0);
        expect(reply).toEqual({ text: 'Quanto foi?' });
      },
    );

    it('erro da IA vira mensagem amigável, não salva nada e é registrado no log', async () => {
      const { parse, transactions, logger, say } = setup();
      parse.mockRejectedValue(new TransactionParserError('rate_limit', 'limite'));

      const reply = await say('almoço 32');

      expect(transactions.rows).toHaveLength(0);
      expect(reply.text).toContain('limite de uso');
      expect(reply.text).toContain('Nada foi salvo');
      expect(logger.error).toHaveBeenCalledOnce();
    });
  });

  describe('pergunta de pagamento', () => {
    const cadeira = () =>
      draft({
        description: 'Cadeira',
        category: 'COMPRAS',
        amountCents: 50000,
        paymentMethod: null,
      });

    it('sem forma de pagamento: não salva e pergunta com botões', async () => {
      const { parse, accounts, transactions, pending, say } = setup();
      await withUserAccounts(accounts);
      parse.mockResolvedValue(result({ transactions: [cadeira()] }));

      const reply = await say('comprei cadeira 500');

      expect(transactions.rows).toHaveLength(0);
      expect(pending.rows).toHaveLength(1);
      expect(reply.text).toContain('Como você pagou?');
      expect(reply.text).toMatch(/Cadeira: R\$\s500,00/);
      const labels = reply.actions
        ?.flat()
        .map((a) => a.label)
        .join(' ');
      for (const option of ['Pix', 'Débito', 'Crédito', 'VR', 'VA', 'Dinheiro', 'Cancelar']) {
        expect(labels).toContain(option);
      }
    });

    it('Crédito → qual cartão → Santander: salva no cartão escolhido', async () => {
      const { assistant, parse, accounts, transactions, pending, button, say } = setup();
      await withUserAccounts(accounts);
      parse.mockResolvedValue(result({ transactions: [cadeira()] }));

      const question = await say('comprei cadeira 500');
      const cardQuestion = await assistant.handleAction(button(question, 'Crédito'));

      expect(cardQuestion.mode).toBe('replace');
      expect(cardQuestion.text).toContain('Em qual cartão de crédito?');
      expect(transactions.rows).toHaveLength(0);

      const saved = await assistant.handleAction(button(cardQuestion, 'Santander'));

      const santander = (await accounts.listActive()).find((a) => a.name === 'Santander');
      expect(transactions.rows).toHaveLength(1);
      expect(transactions.rows[0]).toMatchObject({
        paymentMethod: 'CREDITO',
        accountId: santander?.id,
      });
      expect(pending.rows).toHaveLength(0);
      expect(saved.text).toContain('Crédito Santander');
      expect(saved.actions?.flat()[0]?.id).toMatch(/^undo:/);
    });

    it('Pix: a única conta bancária é escolhida sozinha', async () => {
      const { assistant, parse, accounts, transactions, button, say } = setup();
      await withUserAccounts(accounts);
      parse.mockResolvedValue(result({ transactions: [draft({ paymentMethod: null })] }));

      const question = await say('almoço 32');
      await assistant.handleAction(button(question, 'Pix'));

      const itauConta = (await accounts.listActive()).find((a) => a.kind === 'BANK');
      expect(transactions.rows[0]).toMatchObject({
        paymentMethod: 'PIX',
        accountId: itauConta?.id,
      });
    });

    it('Voltar na pergunta do cartão volta para a forma de pagamento', async () => {
      const { assistant, parse, accounts, button, say } = setup();
      await withUserAccounts(accounts);
      parse.mockResolvedValue(result({ transactions: [draft({ paymentMethod: 'CREDITO' })] }));

      const cardQuestion = await say('almoço 32 no crédito');
      const back = await assistant.handleAction(button(cardQuestion, 'Voltar'));

      expect(back.text).toContain('Como você pagou?');
    });

    it('Cancelar descarta a pendência sem salvar', async () => {
      const { assistant, parse, accounts, transactions, pending, button, say } = setup();
      await withUserAccounts(accounts);
      parse.mockResolvedValue(result({ transactions: [draft({ paymentMethod: null })] }));

      const question = await say('almoço 32');
      const reply = await assistant.handleAction(button(question, 'Cancelar'));

      expect(reply.text).toContain('Nada foi salvo');
      expect(transactions.rows).toHaveLength(0);
      expect(pending.rows).toHaveLength(0);
    });

    it('tocar duas vezes no mesmo botão não salva em dobro', async () => {
      const { assistant, parse, accounts, transactions, button, say } = setup();
      await withUserAccounts(accounts);
      parse.mockResolvedValue(result({ transactions: [draft({ paymentMethod: null })] }));

      const question = await say('almoço 32');
      const pixButton = button(question, 'Pix');
      await assistant.handleAction(pixButton);
      const second = await assistant.handleAction(pixButton);

      expect(transactions.rows).toHaveLength(1);
      expect(second.text).toContain('já foi registrado ou cancelado');
    });

    it('vários itens sem forma: uma pergunta só para todos', async () => {
      const { assistant, parse, accounts, transactions, button, say } = setup();
      await withUserAccounts(accounts);
      parse.mockResolvedValue(
        result({
          transactions: [
            draft({ paymentMethod: null }),
            draft({ paymentMethod: null, description: 'Uber', amountCents: 1850 }),
          ],
        }),
      );

      const question = await say('almoço 32 e uber 18,50');
      expect(question.text).toContain('Como você pagou estes 2?');
      await assistant.handleAction(button(question, 'Débito'));

      expect(transactions.rows.map((t) => t.paymentMethod)).toEqual(['DEBITO', 'DEBITO']);
    });

    it('lembra das outras pendências nas respostas e lista em /pendentes', async () => {
      const { assistant, parse, accounts, say } = setup();
      await withUserAccounts(accounts);
      parse.mockResolvedValue(result({ transactions: [draft({ paymentMethod: null })] }));

      await say('almoço 32');
      const second = await say('almoço 40');

      expect(second.text).toContain('1 lançamento esperando resposta');
      const listed = await assistant.handlePending();
      expect(listed).toHaveLength(2);
      expect(listed.every((m) => m.text.includes('Como você pagou?'))).toBe(true);
    });
  });

  describe('VR e VA', () => {
    it('recarga de VA e compra no VA mostram o saldo', async () => {
      const { parse, accounts, say } = setup();
      await withUserAccounts(accounts);

      parse.mockResolvedValueOnce(
        result({
          transactions: [
            draft({
              type: 'INCOME',
              category: 'VALE_ALIMENTACAO',
              description: 'VA',
              amountCents: 60000,
              paymentMethod: 'VA',
            }),
          ],
        }),
      );
      const recarga = await say('recebi 600 de VA');
      expect(recarga.text).toMatch(/Saldo VA: R\$\s600,00/);

      parse.mockResolvedValueOnce(
        result({
          transactions: [
            draft({
              category: 'MERCADO',
              description: 'Mercado',
              amountCents: 8000,
              paymentMethod: 'VA',
            }),
          ],
        }),
      );
      const compra = await say('mercado 80 no VA');
      expect(compra.text).toMatch(/Saldo VA: R\$\s520,00/);
    });

    it('Desfazer devolve o saldo', async () => {
      const { assistant, parse, accounts, say } = setup();
      await withUserAccounts(accounts);
      parse.mockResolvedValue(
        result({ transactions: [draft({ amountCents: 5000, paymentMethod: 'VR' })] }),
      );

      const compra = await say('almoço 50 no VR');
      expect(compra.text).toMatch(/Saldo VR: R\$\s250,00/);

      await assistant.handleAction(compra.actions?.flat()[0]?.id ?? '');
      const menu = await assistant.handleAccounts();
      expect(menu.text).toMatch(/VR: saldo R\$\s300,00/);
    });
  });

  describe('menu /cartoes', () => {
    it('cadastra "Conta + crédito" com o nome digitado, sem chamar a IA', async () => {
      const { assistant, parse, accounts, button, say } = setup();

      const menu = await assistant.handleAccounts();
      const types = await assistant.handleAction(button(menu, 'Adicionar'));
      const askName = await assistant.handleAction(button(types, 'Conta + crédito'));
      expect(askName.text).toContain('Qual o nome?');

      const done = await say('Itaú');

      expect(parse).not.toHaveBeenCalled();
      expect(done.text).toContain('Cadastrado: Itaú (conta) e Itaú (crédito)');
      expect((await accounts.listActive()).map((a) => a.kind)).toEqual(['BANK', 'CREDIT_CARD']);
    });

    it('cadastra o VA com o nome sugerido e o saldo atual', async () => {
      const { assistant, accounts, button, say } = setup();

      const types = await assistant.handleAction('ac:add');
      const askName = await assistant.handleAction(button(types, 'VA'));
      const askBalance = await assistant.handleAction(button(askName, 'Usar "VA"'));
      expect(askBalance.text).toContain('saldo atual');

      const done = await say('230,50');

      expect(done.text).toMatch(/VA: saldo R\$\s230,50/);
      const [va] = await accounts.listActive();
      expect(va).toMatchObject({ name: 'VA', kind: 'FOOD_VOUCHER', initialBalanceCents: 23050 });
    });

    it('valor inválido pede de novo, sem sair do cadastro', async () => {
      const { assistant, accounts, button, say } = setup();
      const types = await assistant.handleAction('ac:add');
      const askName = await assistant.handleAction(button(types, 'VR'));
      await assistant.handleAction(button(askName, 'Usar "VR"'));

      const retry = await say('uns duzentos');
      expect(retry.text).toContain('Não entendi o valor');

      await say('200');
      expect(await accounts.listActive()).toHaveLength(1);
    });

    it('um passo esquecido expira: o texto volta a ser um lançamento', async () => {
      const { assistant, parse, button, say, advanceClock } = setup();
      parse.mockResolvedValue(result({ transactions: [draft()] }));
      const types = await assistant.handleAction('ac:add');
      await assistant.handleAction(button(types, 'Crédito'));

      advanceClock(CHAT_STATE_TTL_MS + 1);
      await say('almoço 32 em dinheiro');

      expect(parse).toHaveBeenCalledOnce();
    });

    it('ajustar saldo e remover um cartão', async () => {
      const { assistant, accounts, button, say } = setup();
      await withUserAccounts(accounts);
      const vr = (await accounts.listActive()).find((a) => a.kind === 'MEAL_VOUCHER');
      const santander = (await accounts.listActive()).find((a) => a.name === 'Santander');

      const details = await assistant.handleAction(`ac:open:${vr?.id}`);
      await assistant.handleAction(button(details, 'Ajustar saldo'));
      const adjusted = await say('123,45');
      expect(adjusted.text).toMatch(/VR: saldo R\$\s123,45/);

      const confirm = await assistant.handleAction(`ac:rm:${santander?.id}`);
      const removed = await assistant.handleAction(button(confirm, 'Sim, remover'));
      expect(removed.text).toContain('Santander (crédito) removido');
      expect((await accounts.listActive()).some((a) => a.name === 'Santander')).toBe(false);
    });
  });

  describe('mensagem de voz', () => {
    it('guarda a transcrição como texto original, com origem AUDIO, e mostra o que ouviu', async () => {
      const { assistant, parse, transactions } = setup();
      parse.mockResolvedValue(
        result({ transactions: [draft()], transcript: 'almoço trinta e dois' }),
      );

      const reply = await assistant.handleAudio({
        audio: Buffer.from('ogg'),
        mimeType: 'audio/ogg',
        receivedAt: RECEIVED_AT,
      });

      expect(transactions.rows[0]).toMatchObject({
        rawInput: 'almoço trinta e dois',
        source: 'AUDIO',
      });
      expect(reply.text).toContain('🎙️ "almoço trinta e dois"');
    });
  });

  describe('botão Desfazer', () => {
    it('apaga o lote da mensagem', async () => {
      const { assistant, parse, transactions, say } = setup();
      parse.mockResolvedValue(result({ transactions: [draft(), draft()] }));
      const registered = await say('x');

      const reply = await assistant.handleAction(registered.actions?.flat()[0]?.id ?? '');

      expect(reply.mode).toBe('append');
      expect(transactions.rows).toHaveLength(0);
      expect(reply.text).toContain('2 lançamentos apagados');
    });

    it.each(['undo:nao-e-uuid', 'outra-acao', ''])(
      'recusa ação inválida "%s" sem ir ao banco',
      async (actionId) => {
        const { assistant, transactions } = setup();
        const deleteBatch = vi.spyOn(transactions, 'deleteBatch');

        const reply = await assistant.handleAction(actionId);

        expect(deleteBatch).not.toHaveBeenCalled();
        expect(reply.text).toContain('não é mais válido');
      },
    );
  });
});
