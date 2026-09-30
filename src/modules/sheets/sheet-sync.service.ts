import type { OutgoingMessage } from '../../channels/message-channel.js';
import type { JobStateRepository } from '../../jobs/job-state.repository.js';
import type { Logger } from '../../lib/logger.js';
import { accountLabel } from '../accounts/account-kinds.js';
import type { AccountService } from '../accounts/account.service.js';
import { addMonths, invoiceTotalsByMonth } from '../accounts/credit-invoice.js';
import { formatMonthLong, formatMonthShort, toSheetSerial } from '../../lib/dates.js';
import type { BudgetService } from '../budgets/budget.service.js';
import { monthOf } from '../reports/monthly-report.js';
import type { ReportService } from '../reports/report.service.js';
import type { TransactionRepository } from '../transactions/transaction.repository.js';
import type { TransactionService } from '../transactions/transaction.service.js';
import type { ActionReply } from '../../channels/message-channel.js';
import { diffSheet } from './sheet-diff.js';
import { SheetImporter, type ImportResult } from './sheet-import.js';
import { fieldsOf, hashFields, readRows } from './sheet-row.js';
import type { SheetSnapshotRepository, TrashRepository } from './sheet-sync.repositories.js';
import {
  buildSheetContent,
  cardsWithInvoices,
  type SheetCard,
  type SheetData,
} from './sheet-content.js';
import {
  dashboardCells,
  dashboardChartRequests,
  dashboardClearRanges,
  PANEL,
  REPORT_PERIOD,
  REPORT_TABLE,
  REPORT_VARIANT,
  reportPrintRange,
} from './sheet-dashboard.js';
import { a1, SUMMARY_MONTHS, type TabKey } from './sheet-layout.js';
import {
  columnWidthRequests,
  createTabsRequests,
  formattingRequests,
  legacyTabRequests,
  missingTabs,
  protectionRequests,
  restyleRequests,
  tabIds,
  validationRequests,
  type TabIds,
} from './sheet-structure.js';
import { THEME_VERSION } from './sheet-theme.js';
import { toSheetsError, type SheetsError, type SpreadsheetGateway } from './spreadsheet-gateway.js';

const STRUCTURE_KEY = 'sheets.structure';
/** Mesmo sem mudanças, reescreve a planilha de tempos em tempos (saldos, "mês atual"). */
const REFRESH_EVERY_MS = 10 * 60 * 1000;
/** Falhas passageiras (rede, Google instável) só viram aviso depois de algumas seguidas. */
const TRANSIENT_FAILURES_BEFORE_ALERT = 3;

export interface SheetSyncDeps {
  gateway: SpreadsheetGateway;
  /** E-mail da conta de serviço, para dizer com quem compartilhar a planilha. */
  serviceAccountEmail: string | null;
  transactions: Pick<
    TransactionRepository,
    'listAll' | 'listForReports' | 'listPurchasesByAccount' | 'update' | 'deleteById' | 'restore'
  >;
  transactionService: Pick<TransactionService, 'register'>;
  snapshots: SheetSnapshotRepository;
  trash: TrashRepository;
  accounts: AccountService;
  reports: ReportService;
  budgets: BudgetService;
  jobState: JobStateRepository;
  notify: (message: OutgoingMessage) => Promise<void>;
  logger: Logger;
  today: () => string;
  timeZone: string;
  /** Previsão do fim do mês, para a faixa do Painel (opcional). */
  forecast?: () => Promise<string>;
  now?: () => Date;
  debounceMs?: number;
  /** Espera para a planilha recalcular antes de exportar o PDF (testes usam 0). */
  recalcDelayMs?: number;
}

/** Um arquivo pronto para mandar no chat. */
export interface GeneratedFile {
  filename: string;
  data: Buffer;
}

export interface SheetSyncStatus {
  lastSyncAt: Date | null;
  lastError: SheetsError | null;
}

/**
 * Espelha o banco do bot na planilha Google (bot → planilha). O banco é a fonte da
 * verdade: a planilha é reescrita a cada sincronização, e uma falha nunca perde dados.
 */
export class SheetSyncService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private formatted = false;
  private ids: TabIds | null = null;
  private lastSyncAt: Date | null = null;
  private lastError: SheetsError | null = null;
  private consecutiveFailures = 0;
  private alerted = false;
  /** Houve mudança no bot desde a última escrita na planilha. */
  private dirty = true;
  private lastPushAt = 0;
  private lastPushMonth = '';
  private readonly importer: SheetImporter;

  constructor(private readonly deps: SheetSyncDeps) {
    this.importer = new SheetImporter({
      transactions: deps.transactions,
      service: deps.transactionService,
      trash: deps.trash,
      jobState: deps.jobState,
    });
  }

  /** Pede uma sincronização daqui a alguns segundos, juntando mudanças seguidas numa só. */
  requestSync(): void {
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, this.deps.debounceMs ?? 3000);
  }

  /**
   * Sincroniza agora: lê a planilha (aplica o que você editou lá) e, se algo mudou,
   * reescreve. `force` reescreve mesmo sem mudanças. Se já houver uma rodando, roda de
   * novo logo depois dela.
   */
  async syncNow(options: { force?: boolean } = {}): Promise<void> {
    if (options.force) this.dirty = true;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
    if (this.again) {
      this.again = false;
      await this.syncNow();
    }
  }

  status(): SheetSyncStatus {
    return { lastSyncAt: this.lastSyncAt, lastError: this.lastError };
  }

  /** Link da planilha, opcionalmente abrindo numa aba. */
  url(tab?: TabKey): string {
    const base = `https://docs.google.com/spreadsheets/d/${this.deps.gateway.spreadsheetId}/edit`;
    const gid = tab && this.ids ? this.ids[tab] : undefined;
    return gid === undefined ? base : `${base}#gid=${gid}`;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Mensagem explicando a falha, pronta para o usuário. */
  failureMessage(error: SheetsError): string {
    switch (error.reason) {
      case 'permission':
        return `⚠️ Não consegui acessar a planilha. Ela precisa estar compartilhada como Editor com ${this.deps.serviceAccountEmail ?? 'o e-mail da conta de serviço (está no arquivo JSON, campo "client_email")'}.`;
      case 'not_found':
        return '⚠️ Não encontrei a planilha. Confira o GOOGLE_SHEETS_ID no .env (pode colar o link inteiro da planilha).';
      case 'quota':
      case 'unavailable':
        return '⚠️ O Google Sheets não está respondendo. Continuo registrando tudo e sincronizo sozinho quando ele voltar.';
      case 'unexpected':
        return '⚠️ A planilha não está sincronizando por um erro inesperado (detalhes no log). Seus lançamentos continuam salvos no bot.';
    }
  }

  /**
   * PDF do Painel + lançamentos de um mês ("YYYY-MM"), pela aba oculta Relatório: sincroniza,
   * escreve o mês (sem mexer no seletor do Painel), espera recalcular e exporta. A aba fica
   * visível só durante a exportação, porque o Google exporta aba oculta em branco.
   */
  async reportPdf(month: string): Promise<GeneratedFile> {
    await this.syncNow({ force: true });
    const { lastError } = this.status();
    if (lastError) throw lastError;
    const ids = this.ids;
    if (!ids) throw new Error('planilha ainda não sincronizada');

    const { gateway } = this.deps;
    await gateway.replaceValues(
      [],
      [
        { range: a1('report', PANEL.selector), values: [[formatMonthShort(month)]] },
        {
          range: a1('data', REPORT_PERIOD),
          values: [[toSheetSerial(`${month}-01`)], [toSheetSerial(`${addMonths(month, 1)}-01`)]],
        },
      ],
    );
    const visibility = (hidden: boolean) => ({
      updateSheetProperties: { properties: { sheetId: ids.report, hidden }, fields: 'hidden' },
    });
    await gateway.batchUpdate([visibility(false)]);
    try {
      await sleep(this.deps.recalcDelayMs ?? 2500);
      const list = await gateway.readValues(
        a1('report', `B${REPORT_TABLE.first}:B${REPORT_TABLE.last}`),
      );
      const data = await gateway.exportPdf(ids.report, reportPrintRange(list.length));
      const [name = '', year = ''] = formatMonthLong(month).split(' de ');
      return { filename: `relatorio-${name}-${year}.pdf`, data };
    } catch (error) {
      throw toSheetsError(error);
    } finally {
      await gateway.batchUpdate([visibility(true)]);
    }
  }

  /** Botões dos avisos da planilha ("Desfazer" de uma exclusão, exclusão em massa). */
  async handleAction(actionId: string): Promise<ActionReply | null> {
    const reply = await this.importer.handleAction(actionId);
    if (reply) this.requestSync();
    return reply;
  }

  private async run(): Promise<void> {
    try {
      const structureChanged = await this.ensureStructure();
      const imported = await this.pull();
      for (const message of imported.messages) await this.deps.notify(message);

      const now = this.deps.now?.() ?? new Date();
      const month = this.deps.today().slice(0, 7);
      const mustPush =
        structureChanged ||
        this.dirty ||
        imported.changed ||
        imported.pendingRows.length > 0 ||
        month !== this.lastPushMonth ||
        now.getTime() - this.lastPushAt > REFRESH_EVERY_MS;
      if (mustPush) {
        this.dirty = false;
        await this.push(imported, now);
        this.lastPushAt = now.getTime();
        this.lastPushMonth = month;
      }

      this.lastSyncAt = now;
      this.lastError = null;
      this.consecutiveFailures = 0;
      if (this.alerted) {
        this.alerted = false;
        await this.deps.notify({ text: '✅ A planilha voltou a sincronizar.' });
      }
    } catch (error) {
      const sheetsError = toSheetsError(error);
      this.lastError = sheetsError;
      this.consecutiveFailures += 1;
      this.deps.logger.error(
        { err: error, reason: sheetsError.reason },
        'planilha: falha ao sincronizar',
      );

      const transient = sheetsError.reason === 'quota' || sheetsError.reason === 'unavailable';
      const shouldAlert = !transient || this.consecutiveFailures >= TRANSIENT_FAILURES_BEFORE_ALERT;
      if (shouldAlert && !this.alerted) {
        this.alerted = true;
        await this.deps
          .notify({ text: this.failureMessage(sheetsError) })
          .catch((notifyError: unknown) => {
            this.deps.logger.error({ err: notifyError }, 'planilha: falha ao avisar no chat');
          });
      }
    }
  }

  /** Lê a aba Lançamentos e aplica no banco o que foi mudado lá desde a última vez. */
  private async pull(): Promise<ImportResult> {
    const [values, transactions, accounts, snapshots] = await Promise.all([
      this.deps.gateway.readValues("'Lançamentos'!A2:K"),
      this.deps.transactions.listAll(),
      this.deps.accounts.listAll(),
      this.deps.snapshots.getAll(),
    ]);
    const changes = diffSheet({ rows: readRows(values), transactions, snapshots, accounts });
    return this.importer.apply(changes);
  }

  /**
   * Reescreve a planilha a partir do banco e guarda como cada linha ficou (a base para
   * detectar a próxima edição sua).
   */
  private async push(imported: ImportResult, now: Date): Promise<void> {
    const data = await this.collect(now);
    const content = buildSheetContent({
      ...data,
      statuses: imported.statuses,
      pendingRows: imported.pendingRows,
    });
    await this.deps.gateway.replaceValues(content.clearRanges, content.data);
    if (this.ids) {
      await this.deps.gateway.batchUpdate(columnWidthRequests(this.ids, content.data));
    }
    await this.deps.snapshots.replaceAll(
      new Map(data.transactions.map((t) => [t.id, hashFields(fieldsOf(t))])),
    );
  }

  /**
   * Cria as abas que faltam (e apaga as de versões antigas) e aplica formatos, listas e
   * proteções. O visual completo, as fórmulas do Painel e os gráficos só são refeitos
   * quando a planilha é nova, quando muda a versão do tema ou quando mudam as contas
   * (um cartão com fatura vira série do gráfico; as contas entram na lista de seleção).
   * Retorna true quando a estrutura mudou.
   */
  private async ensureStructure(): Promise<boolean> {
    const { gateway, jobState, timeZone } = this.deps;
    let tabs = await gateway.listTabs();
    const created = missingTabs(tabs);
    const legacy = legacyTabRequests(tabs);
    if (created.length > 0 || legacy.length > 0) {
      await gateway.batchUpdate([...createTabsRequests(created, timeZone), ...legacy]);
      tabs = await gateway.listTabs();
    }
    const ids = tabIds(tabs);
    this.ids = ids;

    const accounts = await this.deps.accounts.listActive();
    const cardCount = cardsWithInvoices(
      accounts
        .filter((a) => a.kind === 'CREDIT_CARD')
        .map((account) => ({
          account,
          summary: null,
          invoiceTotals: new Map(),
        })),
    ).length;
    const labels = accounts.map((account) => accountLabel(account));
    const signature = JSON.stringify({ theme: THEME_VERSION, cardCount, labels });
    const chartIds = tabs.find((tab) => tab.sheetId === ids.dashboard)?.chartIds ?? [];
    const reportChartIds = tabs.find((tab) => tab.sheetId === ids.report)?.chartIds ?? [];
    const structureChanged = (await jobState.get(STRUCTURE_KEY)) !== signature;
    const rebuild =
      created.length > 0 ||
      chartIds.length === 0 ||
      reportChartIds.length === 0 ||
      structureChanged;

    const requests = [
      ...(this.formatted && !rebuild ? [] : formattingRequests(ids)),
      ...protectionRequests(ids, created),
      ...(rebuild || !this.formatted ? validationRequests(ids, labels) : []),
      ...(rebuild ? restyleRequests(ids, tabs, timeZone) : []),
      ...(rebuild ? dashboardChartRequests(ids, chartIds, cardCount) : []),
      ...(rebuild ? dashboardChartRequests(ids, reportChartIds, cardCount, REPORT_VARIANT) : []),
    ];
    await gateway.batchUpdate(requests);
    if (rebuild) {
      // O mês escolhido no Painel só é escrito se estiver vazio: depois, a escolha é sua.
      const selector = await gateway.readValues(a1('dashboard', PANEL.selector));
      await gateway.writeFormulas(
        [...dashboardClearRanges(), ...dashboardClearRanges(REPORT_VARIANT)],
        [
          ...dashboardCells({
            cardsWithInvoices: cardCount,
            includeSelector: selector.flat().every((cell) => cell === '' || cell == null),
          }),
          ...dashboardCells({
            cardsWithInvoices: cardCount,
            includeSelector: false,
            variant: REPORT_VARIANT,
          }),
        ],
      );
    }
    this.formatted = true;
    if (rebuild) await jobState.set(STRUCTURE_KEY, signature);
    // Estrutura nova (ex.: um cartão a mais) exige reescrever os dados para os gráficos.
    return rebuild;
  }

  /** Junta tudo que as abas mostram, a partir dos mesmos relatórios do /resumo. */
  private async collect(now: Date): Promise<SheetData> {
    const { transactions, accounts, reports, budgets } = this.deps;
    const today = this.deps.today();
    const [months, all, forReports, allAccounts, active, budgetList, balances, investments] =
      await Promise.all([
        reports.series(today.slice(0, 7), SUMMARY_MONTHS),
        transactions.listAll(),
        transactions.listForReports(),
        accounts.listAll(),
        accounts.listActive(),
        budgets.list(),
        reports.balances(),
        reports.investments(),
      ]);

    const cards: SheetCard[] = await Promise.all(
      active
        .filter((account) => account.kind === 'CREDIT_CARD')
        .map(async (account) => {
          const purchases = await transactions.listPurchasesByAccount(account.id);
          return {
            account,
            summary: await accounts.creditSummary(account, today),
            invoiceTotals:
              account.closingDay === null
                ? new Map<string, number>()
                : invoiceTotalsByMonth(purchases, account.closingDay),
          };
        }),
    );

    const firstMonth = months[0]?.month ?? today.slice(0, 7);
    const netInvestedBefore = forReports
      .filter((t) => monthOf(t.occurredAt) < firstMonth)
      .reduce(
        (sum, t) =>
          sum +
          (t.type === 'INVESTMENT' ? t.amountCents : t.type === 'REDEMPTION' ? -t.amountCents : 0),
        0,
      );

    return {
      today,
      updatedAt: formatDateTime(now, this.deps.timeZone),
      forecast: this.deps.forecast ? await this.deps.forecast() : null,
      transactions: all,
      accounts: allAccounts,
      months,
      budgets: budgetList,
      balances,
      cards,
      investments,
      netInvestedBefore,
    };
  }
}

/** "25/09/2026 16:40" no fuso do usuário. */
function formatDateTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(instant)
    .replace(',', '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
