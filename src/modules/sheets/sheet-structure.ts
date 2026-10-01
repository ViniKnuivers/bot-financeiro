import type { sheets_v4 } from '@googleapis/sheets';
import type { Category } from '../../generated/prisma/enums.js';
import {
  categoryLabelWithIcon,
  CATEGORY_LABELS,
  PAYMENT_METHOD_LABELS,
  TYPE_LABELS,
} from '../transactions/transaction.labels.js';
import {
  DATA_COLUMN_COUNT,
  dashboardFormatRequests,
  PANEL,
  REPORT_VARIANT,
} from './sheet-dashboard.js';
import {
  INVOICE_ROWS,
  LEGACY_TAB_TITLES,
  MAX_CARD_ROWS,
  MAX_INVESTMENT_ROWS,
  MAX_RECURRING_ROWS,
  READ_ONLY_TABS,
  RECURRING_HEADERS,
  TAB_ORDER,
  TABS,
  type TabKey,
} from './sheet-layout.js';
import type { Cell } from './sheet-content.js';
import { toLocaleNumber } from './sheet-formula.js';
import {
  bottomBorder,
  cellFormat,
  color,
  conditionalText,
  spreadsheetThemeRequest,
  textFormat,
  THEME,
} from './sheet-theme.js';
import type { RangeValues, SheetRequest, SheetTab } from './spreadsheet-gateway.js';

export type TabIds = Record<TabKey, number>;

/** Abas do bot que ainda não existem na planilha. */
export function missingTabs(existing: readonly SheetTab[]): TabKey[] {
  const titles = new Set(existing.map((tab) => tab.title));
  return TAB_ORDER.filter((key) => !titles.has(TABS[key]));
}

export function createTabsRequests(keys: readonly TabKey[], timeZone: string): SheetRequest[] {
  return [
    spreadsheetThemeRequest(timeZone),
    ...keys.map((key): SheetRequest => ({
      addSheet: {
        properties: {
          title: TABS[key],
          index: TAB_ORDER.indexOf(key),
          hidden: key === 'data' || key === 'report',
          gridProperties: {
            frozenRowCount: key === 'dashboard' || key === 'data' || key === 'report' ? 0 : 1,
            ...(key === 'data' ? { columnCount: DATA_COLUMN_COUNT } : {}),
          },
        },
      },
    })),
  ];
}

/** Apaga abas de versões antigas do bot (ex.: "Gráficos", que virou o Painel). */
export function legacyTabRequests(tabs: readonly SheetTab[]): SheetRequest[] {
  return tabs
    .filter((tab) => LEGACY_TAB_TITLES.includes(tab.title))
    .map((tab) => ({ deleteSheet: { sheetId: tab.sheetId } }));
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
  return cellFormat(range, { numberFormat: format });
}

/** Cabeçalho: dourado sobre grafite, com linha embaixo. */
function header(range: sheets_v4.Schema$GridRange): SheetRequest[] {
  return [
    cellFormat(range, {
      backgroundColorStyle: color(THEME.card),
      textFormat: textFormat(THEME.gold, { bold: true }),
    }),
    bottomBorder(range, THEME.gold),
  ];
}

/** Abas de tabela (todas menos o Painel, que tem layout próprio). */
const TABLE_TABS: readonly TabKey[] = [
  'transactions',
  'summary',
  'categories',
  'cards',
  'recurring',
  'investments',
  'data',
];

/** Fundo escuro, fonte e cabeçalhos das abas de tabela, e formatos de número. Seguro reaplicar. */
export function formattingRequests(ids: TabIds): SheetRequest[] {
  const { transactions, summary, categories, cards, investments } = ids;
  return [
    ...TABLE_TABS.map((key) =>
      cellFormat(
        { sheetId: ids[key] },
        {
          backgroundColorStyle: color(THEME.background),
          textFormat: textFormat(THEME.text, { size: 10 }),
          verticalAlignment: 'MIDDLE',
        },
      ),
    ),

    ...header(grid(transactions, [0, 1], [0, 11])),
    numberFormat(grid(transactions, [1, 100_000], [1, 2]), DATE),
    numberFormat(grid(transactions, [1, 100_000], [5, 6]), CURRENCY),

    ...header(grid(summary, [0, 1], [0, 2])),
    ...header(grid(summary, [7, 8], [0, 2])),
    ...header(grid(summary, [0, 1], [3, 10])),
    numberFormat(grid(summary, [1, 6], [1, 2]), CURRENCY),
    numberFormat(grid(summary, [8, 18], [1, 2]), CURRENCY),
    numberFormat(grid(summary, [1, 25], [4, 10]), CURRENCY),

    ...header(grid(categories, [0, 1], [0, 6])),
    numberFormat(grid(categories, [1, 12], [1, 5]), CURRENCY),
    numberFormat(grid(categories, [1, 12], [5, 6]), PERCENT),

    ...header(grid(cards, [0, 2], [0, 1 + MAX_CARD_ROWS])),
    ...header(grid(cards, [13, 15], [0, 6])),
    numberFormat(grid(cards, [2, 2 + INVOICE_ROWS], [1, 1 + MAX_CARD_ROWS]), CURRENCY),
    numberFormat(grid(cards, [15, 15 + MAX_CARD_ROWS], [1, 3]), CURRENCY),
    numberFormat(grid(cards, [15, 15 + MAX_CARD_ROWS], [3, 4]), DATE),
    numberFormat(grid(cards, [15, 15 + MAX_CARD_ROWS], [4, 6]), CURRENCY),

    // Dados: em R$ também, para os eixos dos gráficos do Painel saírem em reais.
    numberFormat(grid(ids.data, [1, 25], [1, 9]), CURRENCY),
    numberFormat(grid(ids.data, [1, 13], [11, 16]), CURRENCY),

    ...header(grid(ids.recurring, [0, 1], [0, RECURRING_HEADERS.length])),
    numberFormat(grid(ids.recurring, [1, 1 + MAX_RECURRING_ROWS], [2, 3]), CURRENCY),
    ...header(grid(ids.recurring, [0, 1], [10, 11])),
    numberFormat(grid(ids.recurring, [0, 1], [11, 12]), CURRENCY),

    ...header(grid(investments, [0, 1], [0, 4])),
    ...header(grid(investments, [0, 1], [5, 6])),
    numberFormat(grid(investments, [1, 1 + MAX_INVESTMENT_ROWS], [1, 4]), CURRENCY),
    numberFormat(grid(investments, [0, 1], [6, 7]), CURRENCY),
  ];
}

const TAB_COLORS: Record<TabKey, string> = {
  dashboard: THEME.gold,
  transactions: THEME.green,
  summary: THEME.border,
  categories: THEME.border,
  cards: THEME.border,
  recurring: THEME.border,
  investments: THEME.border,
  data: THEME.border,
  report: THEME.border,
};

/**
 * O visual completo, reaplicado quando a versão do tema (ou a estrutura) muda: tema da
 * planilha, cores das abas, sem linhas de grade, Lançamentos listrados com filtro e ID
 * escondido, regras de cor e o layout do Painel. Apaga antes as faixas listradas e regras
 * condicionais das abas do bot, para não acumular a cada reaplicação.
 */
export function restyleRequests(
  ids: TabIds,
  tabs: readonly SheetTab[],
  timeZone: string,
): SheetRequest[] {
  const botSheets = new Set(Object.values(ids));
  const cleanup = tabs
    .filter((tab) => botSheets.has(tab.sheetId))
    .flatMap((tab): SheetRequest[] => [
      ...tab.bandedRangeIds.map((bandedRangeId) => ({ deleteBanding: { bandedRangeId } })),
      ...Array.from({ length: tab.conditionalFormatCount }, (): SheetRequest => ({
        deleteConditionalFormatRule: { sheetId: tab.sheetId, index: 0 },
      })),
    ]);

  const { transactions, summary, categories } = ids;
  return [
    ...cleanup,
    spreadsheetThemeRequest(timeZone),
    {
      updateSheetProperties: {
        properties: { sheetId: ids.data, gridProperties: { columnCount: DATA_COLUMN_COUNT } },
        fields: 'gridProperties.columnCount',
      },
    },
    ...TAB_ORDER.map((key): SheetRequest => ({
      updateSheetProperties: {
        properties: {
          sheetId: ids[key],
          tabColorStyle: color(TAB_COLORS[key]),
          hidden: key === 'data' || key === 'report',
          gridProperties: { hideGridlines: true },
        },
        fields: 'tabColorStyle,hidden,gridProperties.hideGridlines',
      },
    })),

    // Lançamentos: linhas listradas, filtro no cabeçalho e a coluna ID escondida.
    {
      addBanding: {
        bandedRange: {
          range: grid(transactions, null, [0, 11]),
          rowProperties: {
            headerColorStyle: color(THEME.card),
            firstBandColorStyle: color(THEME.background),
            secondBandColorStyle: color(THEME.card),
          },
        },
      },
    },
    { setBasicFilter: { filter: { range: grid(transactions, null, [0, 11]) } } },
    {
      updateDimensionProperties: {
        range: { sheetId: transactions, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    },
    conditionalText(grid(transactions, [1, 100_000], [10, 11]), notBlank(), THEME.amber),

    // Resumo: valores negativos (sobra, livre) em vermelho.
    conditionalText(grid(summary, [1, 8], [1, 2]), numberLess(0), THEME.red),
    conditionalText(grid(summary, [1, 25], [4, 12]), numberLess(0), THEME.red),
    // Categorias: % do orçamento em âmbar a partir de 80% e vermelho acima de 100%.
    conditionalText(grid(categories, [1, 12], [5, 6]), numberAtLeast(0.8), THEME.amber, true),
    conditionalText(grid(categories, [1, 12], [5, 6]), numberGreater(1), THEME.red, true),

    ...dashboardFormatRequests(ids.dashboard),
    ...dashboardFormatRequests(ids.report, REPORT_VARIANT),
  ];
}

function notBlank(): sheets_v4.Schema$BooleanCondition {
  return { type: 'NOT_BLANK' };
}

function numberLess(value: number): sheets_v4.Schema$BooleanCondition {
  return { type: 'NUMBER_LESS', values: [{ userEnteredValue: toLocaleNumber(value) }] };
}

function numberGreater(value: number): sheets_v4.Schema$BooleanCondition {
  return { type: 'NUMBER_GREATER', values: [{ userEnteredValue: toLocaleNumber(value) }] };
}

function numberAtLeast(value: number): sheets_v4.Schema$BooleanCondition {
  return { type: 'NUMBER_GREATER_THAN_EQ', values: [{ userEnteredValue: toLocaleNumber(value) }] };
}

/**
 * Abas calculadas pelo bot e as colunas ID/Origem/Status dos lançamentos: editar mostra
 * um aviso ("Tem certeza?"). Só na criação, para não duplicar proteções. No Painel, a
 * célula do mês fica livre (trocar o mês não pede confirmação).
 */
export function protectionRequests(ids: TabIds, created: readonly TabKey[]): SheetRequest[] {
  const requests: SheetRequest[] = READ_ONLY_TABS.filter((key) => created.includes(key)).map(
    (key) => ({
      addProtectedRange: {
        protectedRange: {
          range: { sheetId: ids[key] },
          description: 'Calculada pelo bot: alterações aqui são sobrescritas.',
          warningOnly: true,
          ...(key === 'dashboard'
            ? {
                unprotectedRanges: [grid(ids.dashboard, [PANEL.title - 1, PANEL.title], [7, 9])],
              }
            : {}),
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

/** Listas de seleção nas colunas Tipo, Categoria (com emoji), Forma e Cartão/Conta. */
export function validationRequests(ids: TabIds, accountLabels: readonly string[]): SheetRequest[] {
  const rows: [number, number] = [1, 100_000];
  const categories = (Object.keys(CATEGORY_LABELS) as Category[]).map(categoryLabelWithIcon);
  return [
    listValidation(grid(ids.transactions, rows, [2, 3]), Object.values(TYPE_LABELS)),
    listValidation(grid(ids.transactions, rows, [4, 5]), categories),
    listValidation(grid(ids.transactions, rows, [7, 8]), Object.values(PAYMENT_METHOD_LABELS)),
    ...(accountLabels.length > 0
      ? [listValidation(grid(ids.transactions, rows, [8, 9]), accountLabels)]
      : []),
  ];
}

/** Mínimo com folga para a setinha das listas de seleção (Tipo, Forma...). */
const MIN_COLUMN_PX = 96;
const MAX_COLUMN_PX = 360;
/** A coluna ID (UUID) só existe para o bot; não precisa aparecer inteira. */
const ID_COLUMN_PX = 80;

/**
 * Largura de cada coluna escrita, estimada pelo texto mais longo dela. O ajuste automático
 * do Google (autoResizeDimensions) corta cabeçalhos em negrito e valores em R$.
 * Títulos soltos (faixas de uma célula só) não alargam a coluna: podem transbordar.
 */
export function columnWidthRequests(ids: TabIds, data: readonly RangeValues[]): SheetRequest[] {
  const keyByTitle = new Map<string, TabKey>(
    Object.entries(TABS).map(([key, title]) => [title, key as TabKey]),
  );
  const widths = new Map<string, { sheetId: number; column: number; px: number }>();

  for (const { range, values } of data) {
    const match = /^'(.+)'!([A-Z]+)/.exec(range);
    const key = match?.[1] ? keyByTitle.get(match[1]) : undefined;
    if (!match?.[2] || !key || key === 'dashboard' || key === 'data' || key === 'report') continue;
    if (values.length === 1 && values[0]?.length === 1) continue;
    const start = columnIndex(match[2]);

    for (const row of values) {
      row.forEach((cell, offset) => {
        const column = start + offset;
        const px = key === 'transactions' && column === 0 ? ID_COLUMN_PX : estimatePx(cell);
        const id = `${ids[key]}:${column}`;
        const current = widths.get(id);
        if (!current || px > current.px) widths.set(id, { sheetId: ids[key], column, px });
      });
    }
  }

  return [...widths.values()].map(({ sheetId, column, px }) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: column, endIndex: column + 1 },
      properties: { pixelSize: px },
      fields: 'pixelSize',
    },
  }));
}

/** ~8 px por caractere na Inter 10 (emojis já contam 2 no .length), mais a margem e o filtro. */
function estimatePx(cell: Cell): number {
  const chars = typeof cell === 'number' ? currencyLength(cell) : (cell ?? '').length;
  return Math.min(MAX_COLUMN_PX, Math.max(MIN_COLUMN_PX, Math.ceil(chars * 8) + 32));
}

/** Tamanho de "R$ 1.234,56" (números são valores em R$ ou datas, que são menores). */
function currencyLength(value: number): number {
  const digits = Math.trunc(Math.abs(value)).toString().length;
  return 'R$ '.length + digits + Math.floor((digits - 1) / 3) + ',00'.length + (value < 0 ? 1 : 0);
}

/** "A" → 0, "Z" → 25, "AA" → 26. */
function columnIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + letters.charCodeAt(i) - 64;
  return n - 1;
}
