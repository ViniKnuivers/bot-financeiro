import { describe, expect, it, vi } from 'vitest';
import type { Query } from '../ai/parse-result.schema.js';
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
  InMemoryBudgetRepository,
  InMemoryChatStateRepository,
  InMemoryInvoicePaymentRepository,
  InMemoryPendingRepository,
  InMemoryRecurringRepository,
  InMemoryReminderRepository,
  inMemoryJobState,
} from '../test/in-memory-repositories.js';
import { InMemoryTransactionRepository } from '../test/in-memory-transaction-repository.js';
import { BudgetService } from '../modules/budgets/budget.service.js';
import { InsightsService } from '../modules/insights/insights.service.js';
import { localHour, toDateOnlyString } from '../lib/dates.js';
import { ReminderService } from '../modules/reminders/reminder.service.js';
import { RecurringService } from '../modules/recurring/recurring.service.js';
import { ReportService } from '../modules/reports/report.service.js';
import { CHAT_STATE_TTL_MS } from './conversation-state.js';
import { SheetsError } from '../modules/sheets/spreadsheet-gateway.js';
import type { BackupResult, BackupStatus } from '../modules/backup/backup.service.js';
import { Assistant, type AssistantDeps, type SpreadsheetLink } from './assistant.js';

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
  return {
    intent: 'register',
    transactions: [],
    query: null,
    reminder: null,
    transcript: null,
    reply: 'ok',
    ...overrides,
  };
}

function setup(options: { sheets?: SpreadsheetLink; backup?: AssistantDeps['backup'] } = {}) {
  let now = RECEIVED_AT;
  const clock = () => now;
  const parse = vi.fn<TransactionParser['parse']>();
  const transactions = new InMemoryTransactionRepository();
  const accountRepository = new InMemoryAccountRepository();
  const pending = new InMemoryPendingRepository();
  const chatState = new InMemoryChatStateRepository(clock);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const accounts = new AccountService(
    accountRepository,
    transactions,
    new InMemoryInvoicePaymentRepository(),
  );
  const transactionService = new TransactionService(transactions);
  const budgets = new InMemoryBudgetRepository();
  const recurringRepository = new InMemoryRecurringRepository();
  const recurring = new RecurringService(recurringRepository, transactionService);
  const budgetService = new BudgetService(budgets);
  const reminderRepository = new InMemoryReminderRepository();
  const jobState = inMemoryJobState();
  const assistant = new Assistant({
    parser: { parse },
    transactions: transactionService,
    accounts,
    pending,
    chatState,
    recurring,
    reports: new ReportService(transactions, accounts),
    budgets: budgetService,
    insights: new InsightsService({
      transactions,
      accounts,
      recurring,
      budgets: budgetService,
      today: () => toDateOnlyString(clock(), 'America/Sao_Paulo'),
    }),
    reminders: new ReminderService(reminderRepository, {
      today: () => toDateOnlyString(clock(), 'America/Sao_Paulo'),
      hour: () => localHour(clock(), 'America/Sao_Paulo'),
      now: clock,
    }),
    jobState,
    logger,
    now: clock,
    ...(options.sheets ? { sheets: options.sheets } : {}),
    ...(options.backup ? { backup: options.backup } : {}),
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

  return {
    assistant,
    reminderRepository,
    jobState,
    parse,
    transactions,
    accounts,
    pending,
    budgets,
    recurringRepository,
    logger,
    button,
    say,
    advanceClock,
  };
}

/** A configuração real do usuário: Itaú (conta + crédito), Santander, VR e VA. */
async function withUserAccounts(accounts: AccountService) {
  await accounts.create('BANK_AND_CREDIT', 'Itaú');
  await accounts.create('CREDIT_CARD', 'Santander');
  await accounts.create('MEAL_VOUCHER', 'VR', { initialBalanceCents: 30000 });
  await accounts.create('FOOD_VOUCHER', 'VA');
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
        investmentDestinations: [],
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

      const askBalance = await say('Itaú');
      expect(askBalance.text).toContain('saldo atual da conta');
      const askLimit = await say('2.340,50');
      expect(askLimit.text).toContain('limite');
      const askClosing = await say('3.000');
      expect(askClosing.text).toContain('fecha');
      const askDue = await say('5');
      expect(askDue.text).toContain('vence');
      const done = await say('12');

      expect(parse).not.toHaveBeenCalled();
      expect(done.text).toContain('Cadastrado: Itaú (conta) e Itaú (crédito)');
      const [conta, credito] = await accounts.listActive();
      expect(conta).toMatchObject({
        kind: 'BANK',
        initialBalanceCents: 234050,
        creditLimitCents: null,
        closingDay: null,
      });
      expect(credito).toMatchObject({
        kind: 'CREDIT_CARD',
        creditLimitCents: 300000,
        closingDay: 5,
        dueDay: 12,
      });
    });

    it('limite e fechamento podem ser pulados no cadastro', async () => {
      const { assistant, accounts, button, say } = setup();
      const types = await assistant.handleAction('ac:add');
      await assistant.handleAction(button(types, '💳 Crédito'));
      const askLimit = await say('Santander');

      const askClosing = await assistant.handleAction(button(askLimit, 'Pular'));
      const done = await assistant.handleAction(button(askClosing, 'Pular'));

      expect(done.text).toContain('configure o fechamento');
      expect((await accounts.listActive())[0]).toMatchObject({
        creditLimitCents: null,
        closingDay: null,
      });
    });

    it('dia de fechamento inválido pede de novo', async () => {
      const { assistant, accounts, button, say } = setup();
      const types = await assistant.handleAction('ac:add');
      await assistant.handleAction(button(types, '💳 Crédito'));
      await say('Santander');
      await say('3000');

      expect((await say('32')).text).toContain('Não entendi o dia');
      await say('dia 10');
      // Pular o vencimento também salva (sem lembrete da fatura).
      await assistant.handleAction('ac:skip');
      expect((await accounts.listActive())[0]).toMatchObject({ closingDay: 10, dueDay: null });
    });

    it('renomear um cartão', async () => {
      const { assistant, accounts, button, say } = setup();
      await withUserAccounts(accounts);
      const santander = (await accounts.listActive()).find((a) => a.name === 'Santander');

      const details = await assistant.handleAction(`ac:open:${santander?.id}`);
      await assistant.handleAction(button(details, 'Renomear'));
      const done = await say('Santander Free');

      expect(done.text).toContain('Renomeado para Santander Free');
      expect((await accounts.listActive()).some((a) => a.name === 'Santander Free')).toBe(true);
    });

    it('renomear para um nome que já existe no mesmo tipo é recusado', async () => {
      const { assistant, accounts, button, say } = setup();
      await withUserAccounts(accounts);
      const santander = (await accounts.listActive()).find((a) => a.name === 'Santander');

      const details = await assistant.handleAction(`ac:open:${santander?.id}`);
      await assistant.handleAction(button(details, 'Renomear'));
      const done = await say('itau');

      expect(done.text).toContain('Você já tem "Itaú (crédito)"');
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

  describe('foto de comprovante', () => {
    it('registra com origem PHOTO, mostra o que leu e guarda a legenda', async () => {
      const { assistant, parse, transactions } = setup();
      parse.mockResolvedValue(
        result({
          transactions: [draft({ description: 'Padaria Pão Quente', amountCents: 2350 })],
          transcript: 'Padaria Pão Quente · R$ 23,50 · 24/09 · Pix',
        }),
      );

      const reply = await assistant.handleImage({
        image: Buffer.from('jpg'),
        mimeType: 'image/jpeg',
        caption: 'café da manhã',
        receivedAt: RECEIVED_AT,
      });

      expect(parse).toHaveBeenCalledWith(
        expect.objectContaining({ image: Buffer.from('jpg'), text: 'café da manhã' }),
      );
      expect(transactions.rows[0]).toMatchObject({
        source: 'PHOTO',
        rawInput: 'Padaria Pão Quente · R$ 23,50 · 24/09 · Pix (legenda: café da manhã)',
      });
      expect(reply.text).toMatch(/^📸 Padaria Pão Quente · R\$ 23,50 · 24\/09 · Pix\n\n/);
      expect(reply.actions?.flat().some((a) => a.label.includes('Desfazer'))).toBe(true);
    });

    it('foto que não é comprovante: só repassa a resposta, sem registrar', async () => {
      const { assistant, parse, transactions } = setup();
      parse.mockResolvedValue(
        result({
          intent: 'other',
          transactions: [],
          reply: 'Não consegui ler um comprovante nessa foto.',
        }),
      );

      const reply = await assistant.handleImage({
        image: Buffer.from('jpg'),
        mimeType: 'image/jpeg',
        receivedAt: RECEIVED_AT,
      });

      expect(transactions.rows).toHaveLength(0);
      expect(reply.text).toContain('Não consegui ler um comprovante');
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

  describe('crédito: fatura e limite', () => {
    // RECEIVED_AT é 24/09/2026; com fechamento dia 5, a fatura aberta fecha em 05/10.
    async function santanderConfigurado(accounts: AccountService) {
      const [santander] = await accounts.create('CREDIT_CARD', 'Santander', {
        creditLimitCents: 300000,
        closingDay: 5,
      });
      if (!santander) throw new Error('Santander não criado');
      return santander;
    }

    it('depois da compra mostra a fatura aberta e o disponível', async () => {
      const { parse, accounts, say } = setup();
      await santanderConfigurado(accounts);
      parse.mockResolvedValue(
        result({
          transactions: [
            draft({
              amountCents: 30000,
              paymentMethod: 'CREDITO',
              account: 'Santander',
              installments: 3,
            }),
          ],
        }),
      );

      const reply = await say('tênis 300 em 3x no santander');

      // Fatura mostra a parcela (100); o disponível reserva o total (300).
      expect(reply.text).toMatch(
        /Santander: fatura R\$\s100,00 \(fecha 05\/10\) · disponível R\$\s2\.700,00/,
      );
    });

    it('cartão sem fechamento configurado sugere configurar', async () => {
      const { parse, accounts, say } = setup();
      await accounts.create('CREDIT_CARD', 'Santander');
      parse.mockResolvedValue(result({ transactions: [draft({ paymentMethod: 'CREDITO' })] }));

      const reply = await say('almoço 32 no crédito');

      expect(reply.text).toContain('Configure o fechamento do Santander');
    });

    it('configurar limite e fechamento de um cartão já cadastrado', async () => {
      const { assistant, accounts, button, say } = setup();
      const [santander] = await accounts.create('CREDIT_CARD', 'Santander');

      const details = await assistant.handleAction(`ac:open:${santander?.id}`);
      await assistant.handleAction(button(details, 'Limite, fechamento e vencimento'));
      await say('2500');
      await say('12');
      const done = await say('20');

      expect(done.text).toContain('Configuração salva');
      expect(done.text).toContain('limite R$');
      expect(done.text).toContain('vence dia 20');
      expect((await accounts.listActive())[0]).toMatchObject({
        creditLimitCents: 250000,
        closingDay: 12,
        dueDay: 20,
      });
    });

    it('"Paguei a fatura" libera o limite da fatura fechada', async () => {
      const { assistant, accounts, transactions, button } = setup();
      const santander = await santanderConfigurado(accounts);
      // Compra de agosto: caiu na fatura que fechou em 05/09, ainda não paga.
      await transactions.createBatch('b', [
        {
          type: 'EXPENSE',
          amountCents: 12000,
          description: 'Livro',
          category: 'EDUCACAO',
          paymentMethod: 'CREDITO',
          occurredAt: new Date('2026-08-20T00:00:00.000Z'),
          rawInput: 'livro 120',
          source: 'TEXT',
          accountId: santander.id,
          installments: 1,
        },
      ]);

      const details = await assistant.handleAction(`ac:open:${santander.id}`);
      expect(details.text).toContain('Fatura de set/2026 fechada');
      expect(details.text).toMatch(/disponível R\$\s2\.880,00/);

      const confirm = await assistant.handleAction(button(details, 'Paguei a fatura de set/2026'));
      const paid = await assistant.handleAction(button(confirm, 'Sim, paguei'));

      expect(paid.text).toContain('Fatura de set/2026 marcada como paga');
      expect(paid.text).toMatch(/disponível R\$\s3\.000,00/);
      expect(paid.actions?.flat().some((a) => a.label.includes('Paguei'))).toBe(false);
    });

    it('"Ajustar disponível" faz o valor bater com o do banco', async () => {
      const { assistant, accounts, button, say } = setup();
      const santander = await santanderConfigurado(accounts);

      const details = await assistant.handleAction(`ac:open:${santander.id}`);
      await assistant.handleAction(button(details, 'Ajustar disponível'));
      const done = await say('2.180,00');

      expect(done.text).toMatch(
        /Santander \(crédito\): fatura R\$\s0,00 \(fecha 05\/10\) · disponível R\$\s2\.180,00/,
      );
    });
  });

  describe('investimentos e saldo da conta', () => {
    it('aporte cai na conta, mostra o total no destino e o saldo da conta', async () => {
      const { parse, accounts, transactions, say } = setup();
      await accounts.create('BANK', 'Itaú', { initialBalanceCents: 200000 });
      parse.mockResolvedValue(
        result({
          transactions: [
            draft({
              type: 'INVESTMENT',
              category: 'INVESTIMENTO',
              description: 'Tesouro Selic',
              amountCents: 50000,
              paymentMethod: null,
            }),
          ],
        }),
      );

      const reply = await say('investi 500 no tesouro');

      expect(transactions.rows[0]).toMatchObject({ type: 'INVESTMENT', accountId: 1 });
      expect(reply.text).toContain('Aporte');
      expect(reply.text).toMatch(/Tesouro Selic: R\$\s500,00 investidos no total/);
      expect(reply.text).toMatch(/Saldo Itaú \(conta\): R\$\s1\.500,00/);
    });

    it('salário cai na conta sem perguntar e aumenta o saldo', async () => {
      const { parse, accounts, say } = setup();
      await accounts.create('BANK', 'Itaú', { initialBalanceCents: 10000 });
      parse.mockResolvedValue(
        result({
          transactions: [
            draft({
              type: 'INCOME',
              category: 'SALARIO',
              amountCents: 375000,
              paymentMethod: null,
            }),
          ],
        }),
      );

      const reply = await say('caiu o salário 3750');

      expect(reply.text).toMatch(/Saldo Itaú \(conta\): R\$\s3\.850,00/);
    });

    it('fatura paga pela conta desconta do saldo dela', async () => {
      const { assistant, accounts, transactions, button } = setup();
      await accounts.create('BANK', 'Itaú', { initialBalanceCents: 100000 });
      const [card] = await accounts.create('CREDIT_CARD', 'Santander', {
        creditLimitCents: 300000,
        closingDay: 5,
      });
      await transactions.createBatch('b', [
        {
          type: 'EXPENSE',
          amountCents: 12000,
          description: 'Livro',
          category: 'EDUCACAO',
          paymentMethod: 'CREDITO',
          occurredAt: new Date('2026-08-20T00:00:00.000Z'),
          rawInput: 'x',
          source: 'TEXT',
          accountId: card?.id ?? 0,
          installments: 1,
        },
      ]);

      const details = await assistant.handleAction(`ac:open:${card?.id}`);
      const confirm = await assistant.handleAction(button(details, 'Paguei a fatura'));
      const paid = await assistant.handleAction(button(confirm, 'Sim, paguei'));

      expect(paid.text).toContain('saiu da conta Itaú');
      const menu = await assistant.handleAccounts();
      expect(menu.text).toMatch(/Itaú \(conta\): saldo R\$\s880,00/);
    });
  });

  describe('/resumo', () => {
    it('mostra sobra sem VR/VA, investido e livre', async () => {
      const { assistant, parse, accounts, say } = setup();
      await withUserAccounts(accounts);
      parse
        .mockResolvedValueOnce(
          result({
            transactions: [
              draft({
                type: 'INCOME',
                category: 'SALARIO',
                amountCents: 375000,
                paymentMethod: null,
              }),
            ],
          }),
        )
        .mockResolvedValueOnce(
          result({
            transactions: [
              draft({ amountCents: 120000, category: 'MORADIA', paymentMethod: 'PIX' }),
            ],
          }),
        )
        .mockResolvedValueOnce(
          result({ transactions: [draft({ amountCents: 5000, paymentMethod: 'VR' })] }),
        )
        .mockResolvedValueOnce(
          result({
            transactions: [
              draft({
                type: 'INVESTMENT',
                category: 'INVESTIMENTO',
                description: 'Caixinha',
                amountCents: 100000,
                paymentMethod: null,
              }),
            ],
          }),
        );
      for (const text of ['salário', 'aluguel', 'almoço no vr', 'caixinha']) await say(text);

      const summary = await assistant.handleSummary();

      expect(summary.text).toContain('Setembro de 2026');
      expect(summary.text).toMatch(/Receitas: R\$\s3\.750,00/);
      expect(summary.text).toMatch(/Despesas: R\$\s1\.200,00/);
      expect(summary.text).toMatch(/Sobra: R\$\s2\.550,00/);
      expect(summary.text).toMatch(/Investido: R\$\s1\.000,00/);
      expect(summary.text).toMatch(/Livre depois de investir: R\$\s1\.550,00/);
      expect(summary.text).toMatch(/VR\/VA \(fora da sobra\): entrou R\$\s0,00, saiu R\$\s50,00/);
      expect(summary.actions?.flat().map((a) => a.id)).toEqual(['rs:2026-08']);
      // Sem histórico: ritmo do mês (R$ 1.200 em 24 dias = R$ 50/dia × 6 dias que faltam).
      expect(summary.text).toMatch(/Previsão para 30\/09: sobra de R\$\s2\.250,00/);
      expect(summary.text).toMatch(/R\$\s1\.200,00 já foram \+ R\$\s300,00 do dia a dia/);
    });
  });

  describe('lembretes', () => {
    const HOUR = 60 * 60 * 1000;
    const ipva = {
      description: 'Pagar IPVA',
      amountCents: 80000,
      dueDate: '2026-10-10',
      category: 'TRANSPORTE' as const,
    };

    it('"me lembra de…" cria o lembrete para a véspera, com botão de cancelar', async () => {
      const { assistant, parse, say, button } = setup();
      parse.mockResolvedValueOnce(result({ intent: 'reminder', reminder: ipva }));

      const reply = await say('me lembra de pagar o ipva dia 10, 800 reais');

      expect(reply.text).toMatch(
        /Dia 09\/10 às 9h te lembro: Pagar IPVA · R\$\s800,00 \(vence 10\/10\)/,
      );
      const canceled = await assistant.handleAction(button(reply, 'Cancelar lembrete'));
      expect(canceled.text).toContain('Lembrete cancelado: Pagar IPVA');
      expect((await assistant.handleReminders()).text).toContain('Nenhum lembrete');
    });

    it('às 9h da véspera avisa uma vez; [Paguei] segue para a forma de pagamento', async () => {
      const { assistant, parse, say, button, advanceClock } = setup();
      parse.mockResolvedValueOnce(
        result({ intent: 'reminder', reminder: { ...ipva, dueDate: '2026-09-26' } }),
      );
      await say('me lembra do ipva sábado');

      expect(await assistant.dueReminders()).toEqual([]); // hoje (24) ainda não é a véspera
      advanceClock(18 * HOUR + 10 * 60 * 1000); // 25/09, 09:10 em São Paulo
      const [notice, ...others] = await assistant.dueReminders();

      expect(others).toEqual([]);
      expect(notice?.text).toMatch(/⏰ Lembrete: Pagar IPVA · R\$\s800,00\. Vence amanhã\./);
      expect(await assistant.dueReminders()).toEqual([]);
      if (!notice) throw new Error('sem aviso');
      const paying = await assistant.handleAction(button(notice, 'Paguei e registrar'));
      expect(paying.text).toContain('Como você pagou?');
    });

    it('fatura que vence amanhã: avisa com [Paguei]; paga ou zerada, não avisa', async () => {
      const { assistant, accounts, parse, say, button } = setup();
      const [santander] = await accounts.create('CREDIT_CARD', 'Santander', {
        creditLimitCents: 300000,
        closingDay: 5,
        dueDay: 25,
      });
      if (!santander) throw new Error('cartão não criado');
      parse.mockResolvedValueOnce(
        result({
          transactions: [
            draft({
              amountCents: 10000,
              paymentMethod: 'CREDITO',
              account: 'Santander',
              occurredAt: '2026-09-01',
            }),
          ],
        }),
      );
      await say('mercado 100 no santander dia 1');

      const [notice] = await assistant.dueReminders();

      expect(notice?.text).toMatch(
        /💳 A fatura de set\/2026 do Santander vence amanhã: R\$\s100,00\./,
      );
      if (!notice) throw new Error('sem aviso');
      const paid = await assistant.handleAction(button(notice, 'Paguei'));
      expect(paid.text).toContain('marcada como paga');
      expect(await assistant.dueReminders()).toEqual([]);
    });

    it('conta fixa em modo lembrete: não lança sozinha; [Paguei] lança e [Pular] pula', async () => {
      const { assistant, recurringRepository, transactions, button } = setup();
      const aluguel = await recurringRepository.create({
        type: 'EXPENSE',
        amountCents: 120000,
        description: 'Aluguel',
        category: 'MORADIA',
        paymentMethod: 'PIX',
        accountId: null,
        dayOfMonth: 25,
        lastRunMonth: null,
      });
      await recurringRepository.update(aluguel.id, { mode: 'REMIND' });
      const standalone = new RecurringService(
        recurringRepository,
        new TransactionService(transactions),
      );
      expect(await standalone.runDue('2026-09-25')).toEqual([]);

      const [notice] = await assistant.dueReminders();
      expect(notice?.text).toMatch(/🧾 Amanhã vence: Aluguel · R\$\s1\.200,00/);
      if (!notice) throw new Error('sem aviso');

      const paid = await assistant.handleAction(button(notice, 'Paguei'));
      expect(paid.text).toContain('Registrado');
      expect(transactions.rows).toMatchObject([{ description: 'Aluguel', source: 'RECURRING' }]);
      expect((await assistant.handleAction(button(notice, 'Paguei'))).text).toContain(
        'já está lançado',
      );
    });

    it('[Pular este mês] marca o mês sem lançar; /lembretes lista tudo', async () => {
      const { assistant, recurringRepository, transactions, accounts, button } = setup();
      await accounts.create('CREDIT_CARD', 'Santander', { closingDay: 5, dueDay: 12 });
      const conta = await recurringRepository.create({
        type: 'EXPENSE',
        amountCents: 9000,
        description: 'Internet',
        category: 'CONTAS',
        paymentMethod: 'PIX',
        accountId: null,
        dayOfMonth: 25,
        lastRunMonth: null,
      });
      await recurringRepository.update(conta.id, { mode: 'REMIND' });

      const menu = await assistant.handleReminders();
      expect(menu.text).toContain('Faturas:');
      expect(menu.text).toContain('💳 Santander: vence 12/10');
      expect(menu.text).toContain('🧾 Internet: vence 25/09');

      const [notice] = await assistant.dueReminders();
      if (!notice) throw new Error('sem aviso');
      const skipped = await assistant.handleAction(button(notice, 'Pular este mês'));
      expect(skipped.text).toContain('Pulei Internet em set/2026');
      expect(transactions.rows).toHaveLength(0);
    });
  });

  describe('/relatorio e PDF do dia 1', () => {
    function fakeSheets(overrides: Partial<SpreadsheetLink> = {}): SpreadsheetLink {
      return {
        url: (tab?: string) => `https://planilha${tab ? `#${tab}` : ''}`,
        status: () => ({ lastSyncAt: new Date(), lastError: null }),
        syncNow: vi.fn(() => Promise.resolve()),
        requestSync: vi.fn(),
        failureMessage: () => '⚠️ Planilha não compartilhada.',
        handleAction: vi.fn(() => Promise.resolve(null)),
        reportPdf: vi.fn((month: string) =>
          Promise.resolve({ filename: `relatorio-${month}.pdf`, data: Buffer.from('%PDF-1.7') }),
        ),
        ...overrides,
      };
    }

    it('/relatorio manda o PDF do mês atual, com botões dos 2 meses anteriores', async () => {
      const sheets = fakeSheets();
      const { assistant } = setup({ sheets });

      const reply = await assistant.handleReport();

      expect(sheets.reportPdf).toHaveBeenCalledWith('2026-09');
      expect(reply.document?.filename).toBe('relatorio-2026-09.pdf');
      expect(reply.text).toContain('Relatório de Setembro de 2026');
      expect(reply.actions?.flat().map((a) => a.id)).toEqual(['rp:2026-08', 'rp:2026-07']);

      const august = await assistant.handleAction('rp:2026-08');
      expect(august.document?.filename).toBe('relatorio-2026-08.pdf');
    });

    it('sem planilha, ou se o Google falhar: explica, sem arquivo', async () => {
      const { assistant } = setup();
      expect((await assistant.handleReport()).text).toContain('ainda não está configurada');

      const failing = fakeSheets({
        reportPdf: () => Promise.reject(new SheetsError('permission', 'sem acesso')),
      });
      const reply = await setup({ sheets: failing }).assistant.handleReport();
      expect(reply.document).toBeUndefined();
      expect(reply.text).toContain(
        'Não consegui gerar o PDF de Setembro de 2026. Planilha não compartilhada.',
      );
    });

    it('aviso do dia 1 leva o PDF do mês fechado; se o PDF falhar, o aviso sai mesmo assim', async () => {
      const { assistant } = setup({ sheets: fakeSheets() });
      const closed = await assistant.monthClosedMessage('2026-08');
      expect(closed.document?.filename).toBe('relatorio-2026-08.pdf');
      expect(closed.text).toContain('Agosto de 2026 fechado');

      const failing = fakeSheets({ reportPdf: () => Promise.reject(new Error('instável')) });
      const without = await setup({ sheets: failing }).assistant.monthClosedMessage('2026-08');
      expect(without.document).toBeUndefined();
      expect(without.text).toContain('peça de novo com /relatorio');
    });
  });

  describe('perguntas', () => {
    function query(overrides: Partial<Query>): ParseResult {
      return result({
        intent: 'query',
        reply: 'Deixa eu ver!',
        query: {
          kind: 'total',
          type: null,
          categories: [],
          text: null,
          account: null,
          paymentMethod: null,
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          compareStart: null,
          compareEnd: null,
          rankBy: null,
          sort: null,
          limit: null,
          amountCents: null,
          ...overrides,
        },
      });
    }

    it('a IA só entende a pergunta; o total vem do banco e nada é salvo', async () => {
      const { parse, transactions, say } = setup();
      parse
        .mockResolvedValueOnce(
          result({
            transactions: [
              draft({ description: 'Uber', amountCents: 1850, category: 'TRANSPORTE' }),
            ],
          }),
        )
        .mockResolvedValueOnce(
          result({
            transactions: [
              draft({ description: 'Uber', amountCents: 2200, category: 'TRANSPORTE' }),
            ],
          }),
        )
        .mockResolvedValueOnce(query({ text: 'uber' }));
      await say('uber 18,50');
      await say('uber 22');

      const reply = await say('quanto gastei com uber em setembro?');

      expect(reply.text).toMatch(/Uber em setembro de 2026: R\$\s40,50 \(2 lançamentos\)/);
      expect(transactions.rows).toHaveLength(2);
    });

    it('maior gasto do mês', async () => {
      const { parse, say } = setup();
      parse
        .mockResolvedValueOnce(
          result({
            transactions: [
              draft({ description: 'Mercado', amountCents: 45000, category: 'MERCADO' }),
            ],
          }),
        )
        .mockResolvedValueOnce(
          result({ transactions: [draft({ description: 'Café', amountCents: 700 })] }),
        )
        .mockResolvedValueOnce(query({ kind: 'list', sort: 'largest', limit: 1 }));
      await say('mercado 450');
      await say('café 7');

      const reply = await say('qual meu maior gasto de setembro?');

      expect(reply.text).toMatch(
        /Maior gasto em setembro de 2026:\n24\/09 · Mercado · R\$\s450,00/,
      );
    });

    it('posso gastar: junta previsão, orçamento e limite do cartão', async () => {
      const { parse, accounts, budgets, say } = setup();
      await withUserAccounts(accounts);
      const [itauCredit] = (await accounts.listActive()).filter(
        (a) => a.name === 'Itaú' && a.kind === 'CREDIT_CARD',
      );
      if (!itauCredit) throw new Error('cartão não criado');
      await accounts.configureCredit(itauCredit, {
        creditLimitCents: 100000,
        closingDay: 5,
        dueDay: null,
      });
      await budgets.upsert('COMPRAS', 40000);
      parse
        .mockResolvedValueOnce(
          result({
            transactions: [
              draft({
                type: 'INCOME',
                category: 'SALARIO',
                amountCents: 300000,
                paymentMethod: null,
              }),
            ],
          }),
        )
        .mockResolvedValueOnce(
          query({
            kind: 'can_afford',
            amountCents: 30000,
            categories: ['COMPRAS'],
            account: 'Itaú',
            paymentMethod: 'CREDITO',
          }),
        );
      await say('salário 3000');

      const reply = await say('posso gastar 300 num tênis no itaú?');

      // 75% do orçamento, limite sobra, sobra prevista positiva: cabe.
      expect(reply.text).toContain('✅ Cabe!');
      expect(reply.text).toMatch(/Previsão de sobra em setembro: R\$\s3\.000,00 → R\$\s2\.700,00/);
      expect(reply.text).toContain('🛍️ Compras: 75% do orçamento depois dessa compra');
      expect(reply.text).toMatch(/Itaú: sobram R\$\s700,00 de limite/);
    });

    it('cartão que não existe: explica em vez de dizer "nenhum"', async () => {
      const { parse, say } = setup();
      parse.mockResolvedValueOnce(query({ account: 'Nubank' }));

      const reply = await say('quanto gastei no nubank?');

      expect(reply.text).toContain('Não encontrei o cartão ou conta "Nubank"');
    });
  });

  describe('/orcamento', () => {
    it('define um limite e avisa ao passar de 80% e de 100%', async () => {
      const { assistant, parse, button, say } = setup();

      const menu = await assistant.handleBudgets();
      const categories = await assistant.handleAction(button(menu, 'Definir limite'));
      await assistant.handleAction(button(categories, 'Alimentação'));
      const saved = await say('100');
      expect(saved.text).toContain('Limite de Alimentação definido');

      parse.mockResolvedValueOnce(result({ transactions: [draft({ amountCents: 7000 })] }));
      expect((await say('almoço 70')).text).not.toContain('orçamento');

      parse.mockResolvedValueOnce(result({ transactions: [draft({ amountCents: 1500 })] }));
      expect((await say('lanche 15')).text).toMatch(/Alimentação: 85% do orçamento do mês/);

      parse.mockResolvedValueOnce(result({ transactions: [draft({ amountCents: 2000 })] }));
      expect((await say('jantar 20')).text).toContain('passou do orçamento do mês');
    });
  });

  describe('/fixos', () => {
    it('cadastra pelo texto + dia e lança sozinho no dia, uma vez por mês', async () => {
      const { assistant, parse, accounts, transactions, recurringRepository, button, say } =
        setup();
      await accounts.create('BANK', 'Itaú');
      parse.mockResolvedValue(
        result({
          transactions: [
            draft({
              description: 'Aluguel',
              category: 'MORADIA',
              amountCents: 120000,
              paymentMethod: 'PIX',
            }),
          ],
        }),
      );

      const menu = await assistant.handleRecurring();
      await assistant.handleAction(button(menu, 'Adicionar'));
      const askDay = await say('aluguel 1200 no pix');
      expect(askDay.text).toContain('Em que dia do mês');
      const created = await say('28');

      expect(created.text).toContain('Gasto fixo cadastrado');
      expect(created.text).toContain('28/09/2026');
      expect(transactions.rows).toHaveLength(0);

      // Chegou o dia: a tarefa automática lança e avisa com Desfazer.
      const recurring = new RecurringService(
        recurringRepository,
        new TransactionService(transactions),
      );
      const runs = await recurring.runDue('2026-09-28');
      const [notice] = await assistant.announceRecurring(runs);
      expect(notice?.text).toContain('Lancei um gasto fixo');
      expect(notice?.actions?.flat()[0]?.id).toMatch(/^undo:/);
      expect(transactions.rows[0]).toMatchObject({ source: 'RECURRING', accountId: 1 });

      // Nunca duas vezes no mesmo mês.
      expect(await recurring.runDue('2026-09-30')).toHaveLength(0);
    });

    it('se o dia deste mês já passou, começa no mês que vem', async () => {
      const { assistant, parse, button, say } = setup();
      parse.mockResolvedValue(
        result({ transactions: [draft({ description: 'Netflix', amountCents: 5500 })] }),
      );

      await assistant.handleAction(button(await assistant.handleRecurring(), 'Adicionar'));
      await say('netflix 55 em dinheiro');
      const created = await say('5');

      expect(created.text).toContain('05/10/2026');
    });
  });

  describe('/planilha e /grafico', () => {
    it('sem planilha configurada, explica onde configurar', async () => {
      const { assistant } = setup();

      expect((await assistant.handleSpreadsheet()).text).toContain('ainda não está configurada');
      expect((await assistant.handleCharts()).text).toContain('ainda não está configurada');
    });
  });

  describe('/backup', () => {
    function fakeBackup(status: Partial<BackupStatus> = {}) {
      const state: BackupStatus = {
        connected: true,
        lastSuccess: null,
        lastFailure: null,
        keep: 30,
        hour: 3,
        ...status,
      };
      return {
        state,
        status: vi.fn(() => Promise.resolve({ ...state })),
        authorizationUrl: vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?state=abc'),
        run: vi.fn<() => Promise<BackupResult>>(() => {
          const record = {
            at: '2026-09-24T15:00:00.000Z',
            name: 'financeiro-2026-09-24-1200.sql.gz',
            bytes: 26_000,
          };
          state.lastSuccess = record;
          return Promise.resolve({ ok: true, record, pruned: 1 });
        }),
      };
    }

    it('sem configurar, explica onde fica o passo a passo', async () => {
      const { assistant } = setup();

      expect((await assistant.handleBackup()).text).toContain('seção "Backup automático');
    });

    it('sem conexão, manda o link de autorização (sem botão de backup)', async () => {
      const backup = fakeBackup({ connected: false });
      const { assistant } = setup({ backup });

      const reply = await assistant.handleBackup();

      expect(reply.text).toContain('ainda não conectado');
      expect(reply.text).toContain('https://accounts.google.com/o/oauth2/v2/auth?state=abc');
      expect(reply.actions).toBeUndefined();
    });

    it('conectado: mostra o último backup; o botão faz um agora', async () => {
      const backup = fakeBackup({
        lastSuccess: { at: '2026-09-24T06:00:00.000Z', name: 'x.sql.gz', bytes: 2048 },
      });
      const { assistant, button } = setup({ backup });

      const menu = await assistant.handleBackup();
      expect(menu.text).toContain('Último: 24/09/2026 03:00 · 2 KB');
      expect(menu.text).toContain('guardando as 30 cópias');

      const done = await assistant.handleAction(button(menu, 'Fazer backup agora'));

      expect(backup.run).toHaveBeenCalledOnce();
      expect(done.mode).toBe('replace');
      expect(done.text).toMatch(/^✅ Backup feito: financeiro-2026-09-24-1200\.sql\.gz \(25 KB\)/);
      expect(done.text).toContain('A cópia mais antiga foi para a lixeira');
      expect(done.text).toContain('Último: 24/09/2026 12:00');
    });

    it('se o backup falha, mostra o motivo na própria situação', async () => {
      const backup = fakeBackup();
      backup.run.mockImplementation(() => {
        const failure = {
          at: '2026-09-24T15:00:00.000Z',
          reason: 'failed' as const,
          message: 'Drive: HTTP 503',
        };
        backup.state.lastFailure = failure;
        return Promise.resolve({ ok: false, failure });
      });
      const { assistant } = setup({ backup });

      const reply = await assistant.handleAction('bk:now');

      expect(reply.text).toContain(
        '⚠️ A última tentativa falhou (24/09/2026 12:00): Drive: HTTP 503',
      );
      expect(reply.actions?.flat()[0]?.id).toBe('bk:now');
    });
  });
});
