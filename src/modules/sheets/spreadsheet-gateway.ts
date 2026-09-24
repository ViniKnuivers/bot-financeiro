import { auth, sheets, type sheets_v4 } from '@googleapis/sheets';

export type SheetRequest = sheets_v4.Schema$Request;

export interface SheetTab {
  sheetId: number;
  title: string;
  chartIds: number[];
}

export interface RangeValues {
  /** Notação A1, ex.: "Lançamentos!A2:K". */
  range: string;
  values: (string | number | null)[][];
}

/**
 * O que o bot precisa do Google Sheets. Fica atrás desta interface para os testes
 * usarem uma versão em memória, sem internet nem conta Google.
 */
export interface SpreadsheetGateway {
  readonly spreadsheetId: string;
  listTabs(): Promise<SheetTab[]>;
  /** Estrutura: abas, formatos, validações, proteções e gráficos. */
  batchUpdate(requests: SheetRequest[]): Promise<void>;
  /** Limpa as faixas e escreve os valores novos (números e datas crus, sem interpretar). */
  replaceValues(clearRanges: string[], data: RangeValues[]): Promise<void>;
}

export type SheetsErrorReason = 'permission' | 'not_found' | 'quota' | 'unavailable' | 'unexpected';

/** Erro do Google com um motivo que dá para explicar ao usuário. */
export class SheetsError extends Error {
  override readonly name = 'SheetsError';

  constructor(
    readonly reason: SheetsErrorReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function toSheetsError(error: unknown): SheetsError {
  if (error instanceof SheetsError) return error;
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403)
    return new SheetsError('permission', message, { cause: error });
  if (status === 404) return new SheetsError('not_found', message, { cause: error });
  if (status === 429) return new SheetsError('quota', message, { cause: error });
  if ((status !== undefined && status >= 500) || isNetworkError(error)) {
    return new SheetsError('unavailable', message, { cause: error });
  }
  return new SheetsError('unexpected', message, { cause: error });
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const value of [candidate.status, candidate.response?.status, candidate.code]) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  }
  return undefined;
}

function isNetworkError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' &&
    ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(code)
  );
}

/** Implementação real, autenticada com a conta de serviço (arquivo JSON do Google Cloud). */
export class GoogleSheetsGateway implements SpreadsheetGateway {
  private readonly api: sheets_v4.Sheets;

  constructor(
    readonly spreadsheetId: string,
    keyFile: string,
  ) {
    const credentials = new auth.GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.api = sheets({ version: 'v4', auth: credentials });
  }

  async listTabs(): Promise<SheetTab[]> {
    try {
      const { data } = await this.api.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: 'sheets(properties(sheetId,title),charts(chartId))',
      });
      return (data.sheets ?? []).map((sheet) => ({
        sheetId: sheet.properties?.sheetId ?? 0,
        title: sheet.properties?.title ?? '',
        chartIds: (sheet.charts ?? []).flatMap((chart) =>
          typeof chart.chartId === 'number' ? [chart.chartId] : [],
        ),
      }));
    } catch (error) {
      throw toSheetsError(error);
    }
  }

  async batchUpdate(requests: SheetRequest[]): Promise<void> {
    if (requests.length === 0) return;
    try {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests },
      });
    } catch (error) {
      throw toSheetsError(error);
    }
  }

  async replaceValues(clearRanges: string[], data: RangeValues[]): Promise<void> {
    try {
      if (clearRanges.length > 0) {
        await this.api.spreadsheets.values.batchClear({
          spreadsheetId: this.spreadsheetId,
          requestBody: { ranges: clearRanges },
        });
      }
      await this.api.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data },
      });
    } catch (error) {
      throw toSheetsError(error);
    }
  }
}

/** Aceita o ID puro ou o link inteiro da planilha (mais fácil para quem configura). */
export function parseSpreadsheetId(input: string): string {
  const fromUrl = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(input);
  return fromUrl?.[1] ?? input.trim();
}
