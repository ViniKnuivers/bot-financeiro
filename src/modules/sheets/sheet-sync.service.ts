import type { OutgoingMessage } from '../../channels/message-channel.js';
import type { JobStateRepository } from '../../jobs/job-state.repository.js';
import type { Logger } from '../../lib/logger.js';
import { accountLabel } from '../accounts/account-kinds.js';
import type { AccountService } from '../accounts/account.service.js';
import { invoiceTotalsByMonth } from '../accounts/credit-invoice.js';
import type { BudgetService } from '../budgets/budget.service.js';
import { monthOf } from '../reports/monthly-report.js';
import type { ReportService } from '../reports/report.service.js';
import type { TransactionRepository } from '../transactions/transaction.repository.js';
import {
  buildSheetContent,
  cardsWithInvoices,
  type SheetCard,
  type SheetData,
} from './sheet-content.js';
import { SUMMARY_MONTHS, TABS, type TabKey } from './sheet-layout.js';
import {
  autoResizeRequests,
  chartRequests,
  createTabsRequests,
  formattingRequests,
  missingTabs,
  protectionRequests,
  tabIds,
  validationRequests,
  type TabIds,
} from './sheet-structure.js';
import { toSheetsError, type SheetsError, type SpreadsheetGateway } from './spreadsheet-gateway.js';

const STRUCTURE_KEY = 'sheets.structure';
/** Falhas passageiras (rede, Google instável) só viram aviso depois de algumas seguidas. */
const TRANSIENT_FAILURES_BEFORE_ALERT = 3;

export interface SheetSyncDeps {
  gateway: SpreadsheetGateway;
  /** E-mail da conta de serviço, para dizer com quem compartilhar a planilha. */
  serviceAccountEmail: string | null;
  transactions: Pick<
    TransactionRepository,
    'listAll' | 'listForReports' | 'listPurchasesByAccount'
  >;
  accounts: AccountService;
  reports: ReportService;
  budgets: BudgetService;
  jobState: JobStateRepository;
  notify: (message: OutgoingMessage) => Promise<void>;
  logger: Logger;
  today: () => string;
  timeZone: string;
  now?: () => Date;
  debounceMs?: number;
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

  constructor(private readonly deps: SheetSyncDeps) {}

  /** Pede uma sincronização daqui a alguns segundos, juntando mudanças seguidas numa só. */
  requestSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, this.deps.debounceMs ?? 3000);
  }

  /** Sincroniza agora. Se já houver uma rodando, roda de novo logo depois dela. */
  async syncNow(): Promise<void> {
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

  private async run(): Promise<void> {
    try {
      await this.ensureStructure();
      const content = buildSheetContent(await this.collect());
      await this.deps.gateway.replaceValues(content.clearRanges, content.data);
      if (this.ids) await this.deps.gateway.batchUpdate(autoResizeRequests(this.ids));

      this.lastSyncAt = this.deps.now?.() ?? new Date();
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

  /**
   * Cria as abas que faltam e aplica formatos, listas e proteções. Os gráficos só são
   * recriados quando a planilha é nova ou muda o número de cartões com fatura.
   */
  private async ensureStructure(): Promise<void> {
    const { gateway, jobState } = this.deps;
    let tabs = await gateway.listTabs();
    const created = missingTabs(tabs);
    if (created.length > 0) {
      await gateway.batchUpdate(createTabsRequests(created, this.deps.timeZone));
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
    const signature = JSON.stringify({ cardCount, labels });
    const chartIds = tabs.find((tab) => tab.title === TABS.charts)?.chartIds ?? [];
    const structureChanged = (await jobState.get(STRUCTURE_KEY)) !== signature;
    const rebuildCharts = created.length > 0 || chartIds.length === 0 || structureChanged;

    const requests = [
      ...(this.formatted && created.length === 0 ? [] : formattingRequests(ids)),
      ...protectionRequests(ids, created),
      ...(rebuildCharts || !this.formatted ? validationRequests(ids, labels) : []),
      ...(rebuildCharts ? chartRequests(ids, chartIds, cardCount) : []),
    ];
    await gateway.batchUpdate(requests);
    this.formatted = true;
    if (rebuildCharts) await jobState.set(STRUCTURE_KEY, signature);
  }

  /** Junta tudo que as abas mostram, a partir dos mesmos relatórios do /resumo. */
  private async collect(): Promise<SheetData> {
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
