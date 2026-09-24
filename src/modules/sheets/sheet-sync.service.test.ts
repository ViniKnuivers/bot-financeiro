import { describe, expect, it, vi } from 'vitest';
import { AccountService } from '../accounts/account.service.js';
import { BudgetService } from '../budgets/budget.service.js';
import { ReportService } from '../reports/report.service.js';
import { TransactionService } from '../transactions/transaction.service.js';
import {
  InMemoryAccountRepository,
  InMemoryBudgetRepository,
  InMemoryInvoicePaymentRepository,
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
  const notify = vi.fn(() => Promise.resolve());
  const jobs = new Map<string, string>();
  const sync = new SheetSyncService({
    gateway,
    serviceAccountEmail: 'bot@projeto.iam.gserviceaccount.com',
    transactions,
    accounts,
    reports: new ReportService(transactions, accounts),
    budgets: new BudgetService(budgets),
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
  return { sync, gateway, notify, accounts, budgets, register };
}

describe('SheetSyncService', () => {
  it('na primeira vez cria as 6 abas, os gráficos e escreve os dados', async () => {
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
        'Gráficos',
      ]),
    );
    expect(gateway.chartCount()).toBe(4); // sem cartão com fatura: sem gráfico de faturas
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
    expect(gateway.count('addSheet')).toBe(6);
  });

  it('recria os gráficos quando entra um cartão com fatura (nova série)', async () => {
    const { sync, gateway, accounts } = setup();
    await sync.syncNow();
    await accounts.create('CREDIT_CARD', 'Santander', { creditLimitCents: 300000, closingDay: 5 });

    await sync.syncNow();

    expect(gateway.chartCount()).toBe(5);
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

  it('link direto para a aba de gráficos', async () => {
    const { sync, gateway } = setup();
    await sync.syncNow();
    const chartsTab = gateway.tabs.find((t) => t.title === 'Gráficos');

    expect(sync.url('charts')).toBe(
      `https://docs.google.com/spreadsheets/d/planilha-teste/edit#gid=${chartsTab?.sheetId}`,
    );
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
