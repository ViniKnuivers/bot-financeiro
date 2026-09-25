import { describe, expect, it, vi } from 'vitest';
import type { OutgoingMessage } from '../../channels/message-channel.js';
import { AccountService } from '../accounts/account.service.js';
import { BudgetService } from '../budgets/budget.service.js';
import { ReportService } from '../reports/report.service.js';
import { TransactionService } from '../transactions/transaction.service.js';
import {
  InMemoryAccountRepository,
  InMemoryBudgetRepository,
  InMemoryInvoicePaymentRepository,
  InMemorySheetSnapshotRepository,
  InMemoryTrashRepository,
} from '../../test/in-memory-repositories.js';
import { googleError, InMemorySpreadsheet } from '../../test/in-memory-spreadsheet.js';
import { InMemoryTransactionRepository } from '../../test/in-memory-transaction-repository.js';
import { SheetSyncService } from './sheet-sync.service.js';
import { parseSpreadsheetId, toSheetsError } from './spreadsheet-gateway.js';

const TODAY = '2026-09-24';

function setup() {
  const transactions = new InMemoryTransactionRepository();
  const accounts = new AccountService(
    new InMemoryAccountRepository(),
    transactions,
    new InMemoryInvoicePaymentRepository(),
  );
  const budgets = new InMemoryBudgetRepository();
  const gateway = new InMemorySpreadsheet();
  const snapshots = new InMemorySheetSnapshotRepository();
  const trash = new InMemoryTrashRepository();
  const notify = vi.fn<(message: OutgoingMessage) => Promise<void>>(() => Promise.resolve());
  const jobs = new Map<string, string>();
  const sync = new SheetSyncService({
    gateway,
    serviceAccountEmail: 'bot@projeto.iam.gserviceaccount.com',
    transactions,
    accounts,
    reports: new ReportService(transactions, accounts),
    budgets: new BudgetService(budgets),
    transactionService: new TransactionService(transactions),
    snapshots,
    trash,
    jobState: {
      get: (key) => Promise.resolve(jobs.get(key) ?? null),
      set: (key, value) => {
        jobs.set(key, value);
        return Promise.resolve();
      },
    },
    notify,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    today: () => TODAY,
    timeZone: 'America/Sao_Paulo',
    debounceMs: 10,
  });
  const register = (overrides: Record<string, unknown> = {}) =>
    new TransactionService(transactions).register({
      drafts: [
        {
          type: 'EXPENSE',
          amountCents: 3200,
          description: 'Almoço',
          category: 'ALIMENTACAO',
          paymentMethod: 'PIX',
          accountId: null,
          installments: 1,
          occurredAt: TODAY,
          ...overrides,
        },
      ],
      rawInput: 'almoço 32',
      source: 'TEXT',
    });
  return { sync, gateway, notify, accounts, budgets, register, transactions, trash };
}

describe('SheetSyncService', () => {
  it('na primeira vez cria as 7 abas, o Painel com gráficos e escreve os dados', async () => {
    const { sync, gateway, register } = setup();
    await register();
    await register({
      type: 'INCOME',
      category: 'SALARIO',
      description: 'Salário',
      amountCents: 375000,
      paymentMethod: null,
    });

    await sync.syncNow();

    expect(gateway.tabs.map((t) => t.title)).toEqual(
      expect.arrayContaining([
        'Lançamentos',
        'Resumo',
        'Categorias',
        'Cartões e vales',
        'Investimentos',
        'Painel',
        'Dados',
      ]),
    );
    expect(gateway.tabs.map((t) => t.title)).not.toContain('Gráficos');
    expect(gateway.chartCount()).toBe(3); // sem cartão com fatura: sem gráfico de faturas
    const rows = gateway.range("'Lançamentos'!A1:K");
    expect(rows[0]?.[0]).toBe('ID');
    expect(rows).toHaveLength(3);
    expect(gateway.range("'Resumo'!A1:B20").slice(1, 4)).toEqual([
      ['Receitas', 3750],
      ['Despesas', 32],
      ['Sobra', 3718],
    ]);
    expect(sync.status().lastSyncAt).not.toBeNull();
  });

  it('nas próximas vezes não recria gráficos nem abas', async () => {
    const { sync, gateway } = setup();
    await sync.syncNow();
    const charts = gateway.count('addChart');

    await sync.syncNow();

    expect(gateway.count('addChart')).toBe(charts);
    expect(gateway.count('addSheet')).toBe(7);
    expect(gateway.count('addBanding')).toBe(1);
  });

  it('recria os gráficos quando entra um cartão com fatura (nova série)', async () => {
    const { sync, gateway, accounts } = setup();
    await sync.syncNow();
    await accounts.create('CREDIT_CARD', 'Santander', { creditLimitCents: 300000, closingDay: 5 });

    await sync.syncNow();

    expect(gateway.chartCount()).toBe(4);
    expect(gateway.range("'Cartões e vales'!A2:B12")[0]).toEqual(['Mês', 'Santander']);
  });

  it('pedidos seguidos viram uma sincronização só', async () => {
    const { sync, gateway } = setup();
    const spy = vi.spyOn(gateway, 'replaceValues');

    sync.requestSync();
    sync.requestSync();
    sync.requestSync();
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it('sem permissão: avisa uma vez com o e-mail a compartilhar, e avisa quando volta', async () => {
    const { sync, gateway, notify } = setup();
    gateway.failWith = googleError({ status: 403 });

    await sync.syncNow();
    await sync.syncNow();

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith({
      text: expect.stringContaining('bot@projeto.iam.gserviceaccount.com'),
    });
    expect(sync.status().lastError?.reason).toBe('permission');

    gateway.failWith = null;
    await sync.syncNow();
    expect(notify).toHaveBeenLastCalledWith({ text: '✅ A planilha voltou a sincronizar.' });
  });

  it('falhas passageiras só avisam depois de 3 seguidas', async () => {
    const { sync, gateway, notify } = setup();
    gateway.failWith = googleError({ code: 'ENOTFOUND' });

    await sync.syncNow();
    await sync.syncNow();
    expect(notify).not.toHaveBeenCalled();
    await sync.syncNow();
    expect(notify).toHaveBeenCalledOnce();
  });

  it('link direto para o Painel', async () => {
    const { sync, gateway } = setup();
    await sync.syncNow();
    const dashboard = gateway.tabs.find((t) => t.title === 'Painel');

    expect(sync.url('dashboard')).toBe(
      `https://docs.google.com/spreadsheets/d/planilha-teste/edit#gid=${dashboard?.sheetId}`,
    );
  });

  it('planilha de versão antiga: apaga a aba Gráficos e monta o Painel', async () => {
    const { sync, gateway } = setup();
    gateway.tabs.push({
      sheetId: 7,
      title: 'Gráficos',
      chartIds: [70, 71],
      bandedRangeIds: [],
      conditionalFormatCount: 0,
    });

    await sync.syncNow();
    await sync.syncNow();

    expect(gateway.tabs.map((t) => t.title)).not.toContain('Gráficos');
    expect(gateway.count('deleteSheet')).toBe(1);
    expect(gateway.chartCount()).toBe(3);
  });

  it('reaplicar o visual não acumula faixas listradas nem regras de cor', async () => {
    const { sync, gateway, accounts } = setup();
    await sync.syncNow();
    const rules = gateway.tabs.map((t) => t.conditionalFormatCount);

    // Conta nova muda a lista de seleção: o visual inteiro é refeito.
    await accounts.create('BANK', 'Nubank');
    await sync.syncNow();

    expect(gateway.tabs.map((t) => t.conditionalFormatCount)).toEqual(rules);
    expect(gateway.tabs.flatMap((t) => t.bandedRangeIds)).toHaveLength(1);
  });

  it('o mês escolhido no Painel não é sobrescrito (só preenchido se estiver vazio)', async () => {
    const { sync, gateway, accounts } = setup();
    await sync.syncNow();
    expect(gateway.formulas.get("'Painel'!H2")).toEqual([['Mês atual']]);

    gateway.formulas.set("'Painel'!H2", [['ago/2026']]); // você escolheu agosto
    await accounts.create('BANK', 'Nubank');
    await sync.syncNow();
    expect(gateway.formulas.get("'Painel'!H2")).toEqual([['ago/2026']]);

    gateway.formulas.set("'Painel'!H2", [['']]); // apagou a célula
    await accounts.create('BANK', 'Inter');
    await sync.syncNow();
    expect(gateway.formulas.get("'Painel'!H2")).toEqual([['Mês atual']]);
    // Fórmulas vão na sintaxe da planilha pt_BR (";" entre argumentos).
    expect(gateway.formulas.get("'Painel'!B5")?.[0]?.[0]).toBe(
      '=INDEX(Dados!$B$2:$B$25;Dados!$BC$2)',
    );
  });
});

describe('edição pela planilha', () => {
  /** Sincroniza, "edita" a planilha e sincroniza de novo (como o bot faz a cada minuto). */
  async function editAndSync(
    ctx: ReturnType<typeof setup>,
    edit: (rows: (string | number | null)[][]) => void,
  ) {
    await ctx.sync.syncNow();
    const rows = ctx.gateway.transactionRows;
    edit(rows);
    ctx.gateway.transactionRows = rows;
    await ctx.sync.syncNow();
  }

  it('valor corrigido na planilha é aplicado no bot e avisado', async () => {
    const ctx = setup();
    await ctx.register();

    await editAndSync(ctx, (rows) => {
      rows[0]![5] = 35;
    });

    expect(ctx.transactions.rows[0]?.amountCents).toBe(3500);
    expect(ctx.notify).toHaveBeenCalledWith({
      text: expect.stringMatching(/Atualizei pela planilha:\nAlmoço: R\$\s32,00 → R\$\s35,00/),
    });
    // Na rodada seguinte, sem novas edições, nada é reaplicado nem avisado de novo.
    ctx.notify.mockClear();
    await ctx.sync.syncNow();
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it('linha nova digitada vira lançamento (origem Planilha) e ganha ID', async () => {
    const ctx = setup();

    await editAndSync(ctx, (rows) => {
      rows.push([
        '',
        '20/09/2026',
        'Aporte',
        'Tesouro Selic',
        'Investimento',
        500,
        '',
        '',
        '',
        '',
        '',
      ]);
    });

    expect(ctx.transactions.rows[0]).toMatchObject({
      type: 'INVESTMENT',
      amountCents: 50000,
      source: 'SHEET',
    });
    expect(ctx.gateway.transactionRows[0]?.[0]).toBe(ctx.transactions.rows[0]?.id);
    expect(ctx.gateway.transactionRows[0]?.[9]).toBe('Planilha');
  });

  it('linha nova com erro fica na planilha com o motivo, e o aviso sai uma vez só', async () => {
    const ctx = setup();

    await editAndSync(ctx, (rows) => {
      rows.push(['', '20/09/2026', 'Despesa', 'Presente', 'Comida', 80, '', '', '', '', '']);
    });
    await ctx.sync.syncNow({ force: true });

    expect(ctx.transactions.rows).toHaveLength(0);
    expect(ctx.gateway.transactionRows.at(-1)?.[10]).toBe('⚠️ Categoria "Comida" não existe.');
    const warnings = ctx.notify.mock.calls.filter(([m]) => m.text.includes('Comida'));
    expect(warnings).toHaveLength(1);
  });

  it('linha apagada apaga no bot, com Desfazer que restaura', async () => {
    const ctx = setup();
    await ctx.register();

    await editAndSync(ctx, (rows) => {
      rows.splice(0, 1);
    });
    expect(ctx.transactions.rows).toHaveLength(0);

    const deletion = ctx.notify.mock.calls.find(([m]) => m.text.includes('Apaguei'))?.[0];
    const undo = deletion?.actions?.[0]?.[0]?.id ?? '';
    await ctx.sync.handleAction(undo);

    expect(ctx.transactions.rows).toHaveLength(1);
    expect(ctx.transactions.rows[0]?.description).toBe('Almoço');
  });

  it('aba esvaziada por engano: não apaga nada e pergunta', async () => {
    const ctx = setup();
    for (let i = 0; i < 6; i++) await ctx.register();

    await editAndSync(ctx, (rows) => {
      rows.length = 0;
    });

    expect(ctx.transactions.rows).toHaveLength(6);
    expect(ctx.gateway.transactionRows).toHaveLength(6); // devolvidas à planilha
    expect(ctx.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('6 linhas sumiram') }),
    );

    await ctx.sync.handleAction('sd:yes');
    expect(ctx.transactions.rows).toHaveLength(0);
    expect(ctx.trash.items.size).toBe(6);
  });

  it('sem mudanças em nenhum lado, a leitura periódica não reescreve a planilha', async () => {
    const ctx = setup();
    await ctx.sync.syncNow();
    const writes = vi.spyOn(ctx.gateway, 'replaceValues');

    await ctx.sync.syncNow();

    expect(writes).not.toHaveBeenCalled();
  });
});

describe('spreadsheet-gateway', () => {
  it('aceita o link inteiro da planilha ou só o ID', () => {
    expect(parseSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC-_x9/edit#gid=0')).toBe(
      '1AbC-_x9',
    );
    expect(parseSpreadsheetId(' 1AbC-_x9 ')).toBe('1AbC-_x9');
  });

  it.each([
    [{ status: 403 }, 'permission'],
    [{ response: { status: 404 } }, 'not_found'],
    [{ code: 429 }, 'quota'],
    [{ status: 503 }, 'unavailable'],
    [{ code: 'ECONNREFUSED' }, 'unavailable'],
    [new Error('???'), 'unexpected'],
  ])('%o → %s', (error, reason) => {
    expect(toSheetsError(error).reason).toBe(reason);
  });
});
