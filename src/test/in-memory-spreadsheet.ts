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
  tabs: SheetTab[] = [{ sheetId: 0, title: 'Página1', chartIds: [] }];
  readonly requests: SheetRequest[] = [];
  written: RangeValues[] = [];
  /** Próximas chamadas falham com este erro (ver `googleError`). */
  failWith: Error | null = null;
  private nextId = 100;

  listTabs(): Promise<SheetTab[]> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(structuredClone(this.tabs));
  }

  batchUpdate(requests: SheetRequest[]): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    for (const request of requests) {
      this.requests.push(request);
      const title = request.addSheet?.properties?.title;
      if (title) this.tabs.push({ sheetId: this.nextId++, title, chartIds: [] });
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

  replaceValues(_clearRanges: string[], data: RangeValues[]): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.written = structuredClone(data);
    return Promise.resolve();
  }

  /** Valores escritos numa faixa (ex.: "'Resumo'!A1:B20"). */
  range(range: string): (string | number | null)[][] {
    return this.written.find((r) => r.range === range)?.values ?? [];
  }

  count(kind: keyof SheetRequest): number {
    return this.requests.filter((request) => request[kind] !== undefined).length;
  }

  chartCount(): number {
    return this.tabs.reduce((total, tab) => total + tab.chartIds.length, 0);
  }
}

/** Erro no formato das bibliotecas do Google (status HTTP ou código de rede). */
export function googleError(props: { status?: number; code?: string | number }): Error {
  return Object.assign(new Error(`erro simulado ${JSON.stringify(props)}`), props);
}
