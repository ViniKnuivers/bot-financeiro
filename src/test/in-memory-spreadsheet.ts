import type { sheets_v4 } from '@googleapis/sheets';
import type {
  RangeValues,
  SheetRequest,
  SheetTab,
  SpreadsheetGateway,
} from '../modules/sheets/spreadsheet-gateway.js';

/**
 * Planilha falsa: guarda abas, gráficos e a última escrita de valores, e permite
 * simular falhas. Imita só o que o bot usa da API do Google.
 */
export class InMemorySpreadsheet implements SpreadsheetGateway {
  readonly spreadsheetId = 'planilha-teste';
  tabs: SheetTab[] = [newTab(0, 'Página1')];
  readonly requests: SheetRequest[] = [];
  written: RangeValues[] = [];
  /** Células escritas como digitadas (fórmulas do Painel), por faixa. */
  formulas = new Map<string, RangeValues['values']>();
  /** Próximas chamadas falham com este erro (ver `googleError`). */
  failWith: Error | null = null;
  private nextId = 100;
  /** Colunas de cada aba: como no Google, aba nova nasce com 26 (A..Z). */
  private readonly columns = new Map<number, number>([[0, 26]]);

  listTabs(): Promise<SheetTab[]> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(structuredClone(this.tabs));
  }

  batchUpdate(requests: SheetRequest[]): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    for (const request of requests) {
      this.requests.push(request);
      const title = request.addSheet?.properties?.title;
      if (title) {
        const sheetId = this.nextId++;
        this.tabs.push(newTab(sheetId, title));
        this.columns.set(sheetId, request.addSheet?.properties?.gridProperties?.columnCount ?? 26);
      }
      const resized = request.updateSheetProperties?.properties;
      const columnCount = resized?.gridProperties?.columnCount;
      if (typeof resized?.sheetId === 'number' && typeof columnCount === 'number') {
        this.columns.set(resized.sheetId, columnCount);
      }
      for (const series of chartSources(request)) {
        const limit = this.columns.get(series.sheetId ?? -1) ?? 26;
        if ((series.endColumnIndex ?? 0) > limit) {
          return Promise.reject(new Error(`gráfico fora da grade: ${JSON.stringify(series)}`));
        }
      }
      const deleted = request.deleteSheet?.sheetId;
      if (typeof deleted === 'number') this.tabs = this.tabs.filter((t) => t.sheetId !== deleted);
      const banded = request.addBanding?.bandedRange?.range?.sheetId;
      if (typeof banded === 'number') this.tab(banded)?.bandedRangeIds.push(this.nextId++);
      const unbanded = request.deleteBanding?.bandedRangeId;
      if (typeof unbanded === 'number') {
        for (const tab of this.tabs) {
          tab.bandedRangeIds = tab.bandedRangeIds.filter((id) => id !== unbanded);
        }
      }
      const ruleTab = request.addConditionalFormatRule?.rule?.ranges?.[0]?.sheetId;
      const rules = typeof ruleTab === 'number' ? this.tab(ruleTab) : undefined;
      if (rules) rules.conditionalFormatCount += 1;
      const removedRule = request.deleteConditionalFormatRule?.sheetId;
      const fewer = typeof removedRule === 'number' ? this.tab(removedRule) : undefined;
      if (fewer) fewer.conditionalFormatCount -= 1;
      const chartTab = request.addChart?.chart?.position?.overlayPosition?.anchorCell?.sheetId;
      if (typeof chartTab === 'number') {
        this.tabs.find((tab) => tab.sheetId === chartTab)?.chartIds.push(this.nextId++);
      }
      const removed = request.deleteEmbeddedObject?.objectId;
      if (typeof removed === 'number') {
        for (const tab of this.tabs) tab.chartIds = tab.chartIds.filter((id) => id !== removed);
      }
    }
    return Promise.resolve();
  }

  writeFormulas(_clearRanges: string[], data: RangeValues[]): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    for (const { range, values } of data) this.formulas.set(range, structuredClone(values));
    return Promise.resolve();
  }

  replaceValues(_clearRanges: string[], data: RangeValues[]): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.written = structuredClone(data);
    this.edited = null;
    return Promise.resolve();
  }

  /**
   * Simula a leitura: células do Painel vêm do que foi escrito como digitado; o resto
   * devolve as linhas de dados da aba Lançamentos (sem o cabeçalho),
   * que os testes podem editar em `transactionRows` antes da próxima sincronização.
   */
  readValues(range: string): Promise<unknown[][]> {
    if (this.failWith) return Promise.reject(this.failWith);
    if (range.startsWith("'Painel'")) {
      return Promise.resolve(structuredClone(this.formulas.get(range) ?? []));
    }
    return Promise.resolve(structuredClone(this.transactionRows));
  }

  /** As linhas de lançamentos como estão "na planilha" (edite para simular o usuário). */
  get transactionRows(): (string | number | null)[][] {
    return (this.edited ??= this.range("'Lançamentos'!A1:K").slice(1));
  }

  set transactionRows(rows: (string | number | null)[][]) {
    this.edited = rows;
  }

  private edited: (string | number | null)[][] | null = null;

  /** Valores escritos numa faixa (ex.: "'Resumo'!A1:B20"). */
  range(range: string): (string | number | null)[][] {
    return this.written.find((r) => r.range === range)?.values ?? [];
  }

  count(kind: keyof SheetRequest): number {
    return this.requests.filter((request) => request[kind] !== undefined).length;
  }

  tab(sheetId: number): SheetTab | undefined {
    return this.tabs.find((tab) => tab.sheetId === sheetId);
  }

  chartCount(): number {
    return this.tabs.reduce((total, tab) => total + tab.chartIds.length, 0);
  }
}

/** Todas as faixas de dados de um addChart (para validar contra o tamanho da aba). */
function chartSources(request: SheetRequest): sheets_v4.Schema$GridRange[] {
  const spec = request.addChart?.chart?.spec;
  if (!spec) return [];
  const data: (sheets_v4.Schema$ChartData | undefined)[] = [
    spec.pieChart?.domain,
    spec.pieChart?.series,
    ...(spec.basicChart?.domains ?? []).map((d) => d.domain),
    ...(spec.basicChart?.series ?? []).map((s) => s.series),
  ];
  return data.flatMap((d) => d?.sourceRange?.sources ?? []);
}

function newTab(sheetId: number, title: string): SheetTab {
  return { sheetId, title, chartIds: [], bandedRangeIds: [], conditionalFormatCount: 0 };
}

/** Erro no formato das bibliotecas do Google (status HTTP ou código de rede). */
export function googleError(props: { status?: number; code?: string | number }): Error {
  return Object.assign(new Error(`erro simulado ${JSON.stringify(props)}`), props);
}
