import type { sheets_v4 } from '@googleapis/sheets';
import {
  CATEGORY_LABELS,
  PAYMENT_METHOD_LABELS,
  TYPE_LABELS,
} from '../transactions/transaction.labels.js';
import {
  INVOICE_ROWS,
  MAX_CARD_ROWS,
  MAX_INVESTMENT_ROWS,
  READ_ONLY_TABS,
  TAB_ORDER,
  TABS,
  type TabKey,
} from './sheet-layout.js';
import type { SheetRequest, SheetTab } from './spreadsheet-gateway.js';

export type TabIds = Record<TabKey, number>;

/** Abas do bot que ainda não existem na planilha. */
export function missingTabs(existing: readonly SheetTab[]): TabKey[] {
  const titles = new Set(existing.map((tab) => tab.title));
  return TAB_ORDER.filter((key) => !titles.has(TABS[key]));
}

export function createTabsRequests(keys: readonly TabKey[], timeZone: string): SheetRequest[] {
  return [
    // Formatos brasileiros (R$ 1.234,56 e dd/mm/aaaa) e o fuso do usuário.
    {
      updateSpreadsheetProperties: {
        properties: { locale: 'pt_BR', timeZone },
        fields: 'locale,timeZone',
      },
    },
    ...keys.map((key): SheetRequest => ({
      addSheet: {
        properties: {
          title: TABS[key],
          index: TAB_ORDER.indexOf(key),
          gridProperties: { frozenRowCount: key === 'charts' ? 0 : 1 },
        },
      },
    })),
  ];
}

export function tabIds(tabs: readonly SheetTab[]): TabIds {
  const byTitle = new Map(tabs.map((tab) => [tab.title, tab.sheetId]));
  const ids = {} as TabIds;
  for (const key of TAB_ORDER) {
    const id = byTitle.get(TABS[key]);
    if (id === undefined) throw new Error(`aba "${TABS[key]}" não encontrada`);
    ids[key] = id;
  }
  return ids;
}

/** Faixa em índices zero-based (fim exclusivo), como a API espera. */
function grid(
  sheetId: number,
  rows: [number, number] | null,
  columns: [number, number],
): sheets_v4.Schema$GridRange {
  return {
    sheetId,
    ...(rows ? { startRowIndex: rows[0], endRowIndex: rows[1] } : {}),
    startColumnIndex: columns[0],
    endColumnIndex: columns[1],
  };
}

const CURRENCY: sheets_v4.Schema$NumberFormat = { type: 'CURRENCY', pattern: '"R$" #,##0.00' };
const DATE: sheets_v4.Schema$NumberFormat = { type: 'DATE', pattern: 'dd/mm/yyyy' };
const PERCENT: sheets_v4.Schema$NumberFormat = { type: 'PERCENT', pattern: '0%' };

function numberFormat(
  range: sheets_v4.Schema$GridRange,
  format: sheets_v4.Schema$NumberFormat,
): SheetRequest {
  return {
    repeatCell: {
      range,
      cell: { userEnteredFormat: { numberFormat: format } },
      fields: 'userEnteredFormat.numberFormat',
    },
  };
}

function header(range: sheets_v4.Schema$GridRange): SheetRequest {
  return {
    repeatCell: {
      range,
      cell: {
        userEnteredFormat: {
          textFormat: { bold: true },
          backgroundColor: { red: 0.9, green: 0.93, blue: 0.98 },
        },
      },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  };
}

/** Cabeçalhos em negrito e formatos de moeda, data e porcentagem. Seguro reaplicar. */
export function formattingRequests(ids: TabIds): SheetRequest[] {
  const { transactions, summary, categories, cards, investments } = ids;
  return [
    header(grid(transactions, [0, 1], [0, 11])),
    numberFormat(grid(transactions, [1, 100_000], [1, 2]), DATE),
    numberFormat(grid(transactions, [1, 100_000], [5, 6]), CURRENCY),

    header(grid(summary, [0, 1], [0, 2])),
    header(grid(summary, [9, 10], [0, 2])),
    header(grid(summary, [0, 1], [3, 12])),
    header(grid(summary, [0, 1], [13, 19])),
    numberFormat(grid(summary, [1, 8], [1, 2]), CURRENCY),
    numberFormat(grid(summary, [10, 20], [1, 2]), CURRENCY),
    numberFormat(grid(summary, [1, 25], [4, 12]), CURRENCY),
    numberFormat(grid(summary, [1, 13], [14, 19]), CURRENCY),

    header(grid(categories, [0, 1], [0, 6])),
    numberFormat(grid(categories, [1, 12], [1, 5]), CURRENCY),
    numberFormat(grid(categories, [1, 12], [5, 6]), PERCENT),

    header(grid(cards, [0, 2], [0, 1 + MAX_CARD_ROWS])),
    header(grid(cards, [13, 15], [0, 6])),
    numberFormat(grid(cards, [2, 2 + INVOICE_ROWS], [1, 1 + MAX_CARD_ROWS]), CURRENCY),
    numberFormat(grid(cards, [15, 15 + MAX_CARD_ROWS], [1, 3]), CURRENCY),
    numberFormat(grid(cards, [15, 15 + MAX_CARD_ROWS], [3, 4]), DATE),
    numberFormat(grid(cards, [15, 15 + MAX_CARD_ROWS], [4, 6]), CURRENCY),

    header(grid(investments, [0, 1], [0, 4])),
    header(grid(investments, [0, 1], [5, 6])),
    numberFormat(grid(investments, [1, 1 + MAX_INVESTMENT_ROWS], [1, 4]), CURRENCY),
    numberFormat(grid(investments, [0, 1], [6, 7]), CURRENCY),
  ];
}

/**
 * Abas calculadas pelo bot e as colunas ID/Origem/Status dos lançamentos: editar mostra
 * um aviso ("Tem certeza?"). Só na criação, para não duplicar proteções.
 */
export function protectionRequests(ids: TabIds, created: readonly TabKey[]): SheetRequest[] {
  const requests: SheetRequest[] = READ_ONLY_TABS.filter((key) => created.includes(key)).map(
    (key) => ({
      addProtectedRange: {
        protectedRange: {
          range: { sheetId: ids[key] },
          description: 'Calculada pelo bot: alterações aqui são sobrescritas.',
          warningOnly: true,
        },
      },
    }),
  );
  if (created.includes('transactions')) {
    for (const columns of [
      [0, 1],
      [9, 11],
    ] as const) {
      requests.push({
        addProtectedRange: {
          protectedRange: {
            range: grid(ids.transactions, null, [columns[0], columns[1]]),
            description: 'Preenchida pelo bot.',
            warningOnly: true,
          },
        },
      });
    }
  }
  return requests;
}

function listValidation(
  range: sheets_v4.Schema$GridRange,
  values: readonly string[],
): SheetRequest {
  return {
    setDataValidation: {
      range,
      rule: {
        condition: {
          type: 'ONE_OF_LIST',
          values: values.map((userEnteredValue) => ({ userEnteredValue })),
        },
        showCustomUi: true,
        // Não estrito: lançamentos antigos podem citar uma conta já removida.
        strict: false,
      },
    },
  };
}

/** Listas de seleção nas colunas Tipo, Categoria, Forma e Cartão/Conta. */
export function validationRequests(ids: TabIds, accountLabels: readonly string[]): SheetRequest[] {
  const rows: [number, number] = [1, 100_000];
  return [
    listValidation(grid(ids.transactions, rows, [2, 3]), Object.values(TYPE_LABELS)),
    listValidation(grid(ids.transactions, rows, [4, 5]), Object.values(CATEGORY_LABELS)),
    listValidation(grid(ids.transactions, rows, [7, 8]), Object.values(PAYMENT_METHOD_LABELS)),
    ...(accountLabels.length > 0
      ? [listValidation(grid(ids.transactions, rows, [8, 9]), accountLabels)]
      : []),
  ];
}

function source(range: sheets_v4.Schema$GridRange): sheets_v4.Schema$ChartData {
  return { sourceRange: { sources: [range] } };
}

function position(
  chartsTab: number,
  row: number,
  column: number,
): sheets_v4.Schema$EmbeddedObjectPosition {
  return {
    overlayPosition: {
      anchorCell: { sheetId: chartsTab, rowIndex: row, columnIndex: column },
      widthPixels: 620,
      heightPixels: 360,
    },
  };
}

function basicChart(
  title: string,
  chartType: 'COLUMN' | 'LINE',
  domain: sheets_v4.Schema$GridRange,
  series: sheets_v4.Schema$GridRange[],
  stacked = false,
): sheets_v4.Schema$ChartSpec {
  return {
    title,
    basicChart: {
      chartType,
      legendPosition: 'BOTTOM_LEGEND',
      headerCount: 1,
      ...(stacked ? { stackedType: 'STACKED' } : {}),
      domains: [{ domain: source(domain) }],
      series: series.map((range) => ({ series: source(range), targetAxis: 'LEFT_AXIS' })),
    },
  };
}

function pieChart(
  title: string,
  domain: sheets_v4.Schema$GridRange,
  series: sheets_v4.Schema$GridRange,
): sheets_v4.Schema$ChartSpec {
  return {
    title,
    pieChart: {
      legendPosition: 'RIGHT_LEGEND',
      pieHole: 0.4,
      domain: source(domain),
      series: source(series),
    },
  };
}

/**
 * Recria os gráficos da aba Gráficos. Só é chamado quando a planilha é nova ou quando
 * muda o número de cartões com fatura (cada cartão é uma série do gráfico de faturas).
 */
export function chartRequests(
  ids: TabIds,
  existingChartIds: readonly number[],
  cardsWithInvoices: number,
): SheetRequest[] {
  const { summary, categories, cards, investments, charts } = ids;
  const helper = (column: number) => grid(summary, [0, 13], [column, column + 1]);
  const specs: [sheets_v4.Schema$ChartSpec, number, number][] = [
    [
      pieChart(
        'Gastos por categoria (mês atual)',
        grid(categories, [1, 12], [0, 1]),
        grid(categories, [1, 12], [1, 2]),
      ),
      0,
      0,
    ],
    [
      basicChart('Receitas × despesas × investido (12 meses)', 'COLUMN', helper(13), [
        helper(14),
        helper(15),
        helper(17),
      ]),
      0,
      7,
    ],
    [
      basicChart('Sobra e investido acumulado (12 meses)', 'LINE', helper(13), [
        helper(16),
        helper(18),
      ]),
      19,
      0,
    ],
    [
      pieChart(
        'Investimentos por destino',
        grid(investments, [1, 1 + MAX_INVESTMENT_ROWS], [0, 1]),
        grid(investments, [1, 1 + MAX_INVESTMENT_ROWS], [3, 4]),
      ),
      38,
      0,
    ],
  ];
  if (cardsWithInvoices > 0) {
    const invoiceRows: [number, number] = [1, 2 + INVOICE_ROWS];
    specs.push([
      basicChart(
        'Faturas por cartão (com parcelas futuras)',
        'COLUMN',
        grid(cards, invoiceRows, [0, 1]),
        Array.from({ length: cardsWithInvoices }, (_, i) =>
          grid(cards, invoiceRows, [1 + i, 2 + i]),
        ),
        true,
      ),
      19,
      7,
    ]);
  }

  return [
    ...existingChartIds.map((objectId): SheetRequest => ({ deleteEmbeddedObject: { objectId } })),
    ...specs.map(([spec, row, column]): SheetRequest => ({
      addChart: { chart: { spec, position: position(charts, row, column) } },
    })),
  ];
}

/** Ajusta a largura das colunas ao conteúdo (depois de escrever os valores). */
export function autoResizeRequests(ids: TabIds): SheetRequest[] {
  return (['transactions', 'summary', 'categories', 'cards', 'investments'] as const).map(
    (key) => ({
      autoResizeDimensions: {
        dimensions: { sheetId: ids[key], dimension: 'COLUMNS', startIndex: 0, endIndex: 20 },
      },
    }),
  );
}
