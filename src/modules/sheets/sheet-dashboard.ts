import type { sheets_v4 } from '@googleapis/sheets';
import { formatMonthShort, toSheetSerial } from '../../lib/dates.js';
import { ACCOUNT_KIND_ICONS, accountLabel } from '../accounts/account-kinds.js';
import {
  categoryLabelWithIcon,
  TYPE_ICONS,
  TYPE_LABELS,
} from '../transactions/transaction.labels.js';
import type { Transaction } from '../transactions/transaction.repository.js';
import { a1, CHART_MONTHS, INVOICE_ROWS, MAX_CARD_ROWS, SUMMARY_MONTHS } from './sheet-layout.js';
import type { Cell, SheetData } from './sheet-content.js';
import { toLocaleFormula, toLocaleNumber } from './sheet-formula.js';
import {
  borders,
  bottomBorder,
  cellFormat,
  color,
  conditionalText,
  rgb,
  textFormat,
  THEME,
} from './sheet-theme.js';
import type { RangeValues, SheetRequest } from './spreadsheet-gateway.js';

/*
 * O Painel mostra o mês escolhido numa lista suspensa e precisa reagir na hora, então é
 * feito de fórmulas. Os números continuam calculados pelo bot (o mesmo ReportService do
 * /resumo): ele escreve tudo pronto na aba oculta "Dados", e as fórmulas do Painel só
 * procuram o mês escolhido lá. As fórmulas são fixas: escritas quando a estrutura muda.
 */

const reais = (cents: number): number => cents / 100;

/**
 * Uso do orçamento e do limite: a partir daqui a barra fica âmbar, acima de 100% vermelha
 * (os mesmos 80% e 100% do alerta do bot, em `budgets/budget.service.ts`).
 */
const WARN_RATIO = 0.8;

// ---------------------------------------------------------------------------------------
// Aba Dados (oculta): tabelas escritas pelo bot a cada sincronização
// ---------------------------------------------------------------------------------------

const MAX_TOP = 5;
const MAX_LATEST = 8;
const MAX_CATEGORY_ROWS = 11;
const MAX_BALANCES = 10;

/** Posições na aba Dados. Chaves "set/2026#1" ligam cada linha ao mês e à posição. */
export const DATA = {
  /** A1:I25: Mês, Receitas, Despesas, Sobra, Aportes, Resgates, Investido, Livre, Acumulado. */
  months: `A1:I${1 + SUMMARY_MONTHS}`,
  /** K1:P13: os 12 últimos meses, com cabeçalho próprio (a legenda dos gráficos vem dele). */
  chart: `K1:P${1 + CHART_MONTHS}`,
  /** R:T: gasto por categoria em cada mês, do maior para o menor. */
  categories: `R1:T${1 + SUMMARY_MONTHS * MAX_CATEGORY_ROWS}`,
  /** V:Z: categorias com orçamento em cada mês, da mais usada para a menos. */
  budgets: `V1:Z${1 + SUMMARY_MONTHS * MAX_CATEGORY_ROWS}`,
  /** AB:AF: os maiores gastos de cada mês. */
  top: `AB1:AF${1 + SUMMARY_MONTHS * MAX_TOP}`,
  latest: `AH1:AL${1 + MAX_LATEST}`,
  cards: `AN1:AR${1 + MAX_CARD_ROWS}`,
  balances: `AT1:AU${1 + MAX_BALANCES}`,
  status: 'AW1:AX3',
  monthList: `AZ1:AZ${1 + SUMMARY_MONTHS}`,
  /** Tudo que o bot reescreve (as fórmulas de apoio, de BB em diante, ficam). */
  clear: 'A1:AZ400',
} as const;

/** A aba Dados vai até a coluna BN; abas novas nascem só com A..Z (26 colunas). */
export const DATA_COLUMN_COUNT = 70;

/** Faixas usadas nas fórmulas (absolutas, na aba Dados). */
const LAST_MONTH_ROW = 1 + SUMMARY_MONTHS;
const MONTHS_COLUMN = (letter: string) => `Dados!$${letter}$2:$${letter}$${LAST_MONTH_ROW}`;
const CATEGORIES_TABLE = `Dados!$R$2:$T$${1 + SUMMARY_MONTHS * MAX_CATEGORY_ROWS}`;
const BUDGETS_TABLE = `Dados!$V$2:$Z$${1 + SUMMARY_MONTHS * MAX_CATEGORY_ROWS}`;
const TOP_TABLE = `Dados!$AB$2:$AF$${1 + SUMMARY_MONTHS * MAX_TOP}`;
/** Só a coluna de chaves ("set/2026#1"), para saber se o mês tem alguma linha. */
const BUDGET_KEYS = `Dados!$V$2:$V$${1 + SUMMARY_MONTHS * MAX_CATEGORY_ROWS}`;
const TOP_KEYS = `Dados!$AB$2:$AB$${1 + SUMMARY_MONTHS * MAX_TOP}`;
/**
 * O Painel e o Relatório (aba oculta, exportada em PDF) usam o mesmo layout e as mesmas
 * fórmulas; mudam a aba, de onde vem o mês e as colunas de apoio na aba Dados.
 */
export interface DashboardVariant {
  tab: 'dashboard' | 'report';
  /** Colunas na aba Dados: rótulo e valor do mês escolhido, e rótulo e valor da rosca. */
  helper: { label: string; value: string; donutLabel: string; donutValue: string };
}

export const PANEL_VARIANT: DashboardVariant = {
  tab: 'dashboard',
  helper: { label: 'BB', value: 'BC', donutLabel: 'BE', donutValue: 'BF' },
};

export const REPORT_VARIANT: DashboardVariant = {
  tab: 'report',
  helper: { label: 'BH', value: 'BI', donutLabel: 'BK', donutValue: 'BL' },
};

/** Início e fim (números de série) do mês do relatório, escritos pelo bot ao gerar o PDF. */
export const REPORT_PERIOD = 'BN1:BN2';

/** Mês escolhido ("set/2026") e a linha dele na tabela de meses. */
const selectedMonth = (v: DashboardVariant) => `Dados!$${v.helper.value}$1`;
const selectedRow = (v: DashboardVariant) => `Dados!$${v.helper.value}$2`;
/** Célula do mês na própria aba (seletor no Painel; preenchida pelo bot no Relatório). */
const monthCellRef = (v: DashboardVariant) =>
  v.tab === 'dashboard' ? 'Painel!$H$2' : "'Relatório'!$H$2";

/** Tabela mês a mês (24 meses), a mesma do Resumo. */
export function monthTable(input: SheetData): Cell[][] {
  let cumulative = input.netInvestedBefore;
  return input.months.map((m) => {
    cumulative += m.netInvestedCents;
    return [
      formatMonthShort(m.month),
      reais(m.incomeCents),
      reais(m.expenseCents),
      reais(m.surplusCents),
      reais(m.investedCents),
      reais(m.redeemedCents),
      reais(m.netInvestedCents),
      reais(m.freeCents),
      reais(cumulative),
    ];
  });
}

/** Valor com sinal, do ponto de vista da conta: entrou (+) ou saiu (−). */
function signedReais(t: Transaction): number {
  const cents = t.type === 'INCOME' || t.type === 'REDEMPTION' ? t.amountCents : -t.amountCents;
  return reais(cents);
}

const dateCell = (t: Transaction): number => toSheetSerial(t.occurredAt.toISOString().slice(0, 10));

/** Conteúdo da aba Dados, pronto para gravar (valores crus). */
export function dataTabContent(input: SheetData): RangeValues[] {
  const table = monthTable(input);
  const labels = input.months.map((m) => formatMonthShort(m.month));

  const chartRows = table
    .slice(-CHART_MONTHS)
    .map((row): Cell[] => [0, 1, 2, 3, 6, 8].map((i) => row[i] ?? null));

  const categoryRows: Cell[][] = [];
  const budgetRows: Cell[][] = [];
  const limits = new Map(input.budgets.map((b) => [b.category, b.limitCents]));
  input.months.forEach((m, i) => {
    const label = labels[i] ?? '';
    const spent = new Map(m.byCategory.map((c) => [c.category, c.cents]));
    m.byCategory
      .filter((c) => c.cents > 0)
      .slice(0, MAX_CATEGORY_ROWS)
      .forEach((c, n) => {
        categoryRows.push([`${label}#${n + 1}`, categoryLabelWithIcon(c.category), reais(c.cents)]);
      });
    [...limits]
      .filter(([, limit]) => limit > 0)
      .map(([category, limit]) => ({ category, limit, cents: spent.get(category) ?? 0 }))
      .sort((a, b) => b.cents / b.limit - a.cents / a.limit)
      .slice(0, MAX_CATEGORY_ROWS)
      .forEach((b, n) => {
        budgetRows.push([
          `${label}#${n + 1}`,
          categoryLabelWithIcon(b.category),
          reais(b.cents),
          reais(b.limit),
          b.cents / b.limit,
        ]);
      });
  });

  const expensesByMonth = new Map<string, Transaction[]>();
  for (const t of input.transactions) {
    if (t.type !== 'EXPENSE') continue;
    const month = t.occurredAt.toISOString().slice(0, 7);
    expensesByMonth.set(month, [...(expensesByMonth.get(month) ?? []), t]);
  }
  const topRows: Cell[][] = input.months.flatMap((m, i) =>
    [...(expensesByMonth.get(m.month) ?? [])]
      .sort((a, b) => b.amountCents - a.amountCents || b.id.localeCompare(a.id))
      .slice(0, MAX_TOP)
      .map((t, n): Cell[] => [
        `${labels[i] ?? ''}#${n + 1}`,
        dateCell(t),
        t.description,
        categoryLabelWithIcon(t.category),
        reais(t.amountCents),
      ]),
  );

  // No mesmo dia, o registrado por último vem primeiro.
  const latestRows: Cell[][] = [...input.transactions]
    .sort(
      (a, b) =>
        b.occurredAt.getTime() - a.occurredAt.getTime() ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    )
    .slice(0, MAX_LATEST)
    .map((t) => [
      dateCell(t),
      t.description,
      categoryLabelWithIcon(t.category),
      `${TYPE_ICONS[t.type]} ${TYPE_LABELS[t.type]}`,
      signedReais(t),
    ]);

  const cardRows: Cell[][] = input.cards.slice(0, MAX_CARD_ROWS).map(({ account, summary }) => {
    const limit = account.creditLimitCents;
    const available = summary?.availableCents ?? null;
    return [
      account.name,
      summary ? reais(summary.openInvoiceCents) : '',
      limit === null ? '' : reais(limit),
      limit && available !== null ? (limit - available) / limit : '',
      available === null ? '' : reais(available),
    ];
  });

  const balanceRows: Cell[][] = input.balances
    .slice(0, MAX_BALANCES)
    .map(({ account, cents }) => [
      `${ACCOUNT_KIND_ICONS[account.kind]} ${accountLabel(account)}`,
      reais(cents),
    ]);
  const bankCents = input.balances
    .filter(({ account }) => account.kind === 'BANK')
    .reduce((sum, { cents }) => sum + cents, 0);

  return [
    {
      range: a1('data', DATA.months),
      values: [
        [
          'Mês',
          'Receitas',
          'Despesas',
          'Sobra',
          'Aportes',
          'Resgates',
          'Investido no mês',
          'Livre',
          'Investido acumulado',
        ],
        ...table,
      ],
    },
    {
      range: a1('data', DATA.chart),
      values: [
        ['Mês', 'Receitas', 'Despesas', 'Sobra', 'Investido no mês', 'Investido acumulado'],
        ...chartRows,
      ],
    },
    {
      range: a1('data', DATA.categories),
      values: [['Chave', 'Categoria', 'Gasto'], ...categoryRows],
    },
    {
      range: a1('data', DATA.budgets),
      values: [['Chave', 'Categoria', 'Gasto', 'Limite', 'Uso'], ...budgetRows],
    },
    {
      range: a1('data', DATA.top),
      values: [['Chave', 'Data', 'Descrição', 'Categoria', 'Valor'], ...topRows],
    },
    {
      range: a1('data', DATA.latest),
      values: [['Data', 'Descrição', 'Categoria', 'Tipo', 'Valor'], ...latestRows],
    },
    {
      range: a1('data', DATA.cards),
      values: [['Cartão', 'Fatura aberta', 'Limite', 'Uso', 'Disponível'], ...cardRows],
    },
    { range: a1('data', DATA.balances), values: [['Conta', 'Saldo'], ...balanceRows] },
    {
      range: a1('data', DATA.status),
      values: [
        ['Atualizado em', input.updatedAt],
        ['Saldo em conta', reais(bankCents)],
        ['Previsão', input.forecast ?? ''],
      ],
    },
    {
      range: a1('data', DATA.monthList),
      values: [['Mês atual'], ...[...labels].reverse().map((label): Cell[] => [label])],
    },
  ];
}

/**
 * Fórmulas de apoio na aba Dados (de BB em diante, fora do que o bot reescreve):
 * o mês escolhido e as categorias desse mês, que alimentam a rosca.
 */
function dataFormulas(v: DashboardVariant): RangeValues[] {
  const { label, value, donutLabel, donutValue } = v.helper;
  const lastLabel = `$A$${LAST_MONTH_ROW}`;
  const labelsRange = `$A$2:$A$${LAST_MONTH_ROW}`;
  const month = monthCellRef(v);
  const donut: Cell[][] = Array.from({ length: MAX_CATEGORY_ROWS }, (_, i) => {
    const key = `$${value}$1&"#${i + 1}"`;
    const table = CATEGORIES_TABLE.replace('Dados!', '');
    // Mês sem gastos: um anel único "Sem gastos", em vez do aviso de gráfico vazio.
    const [fallbackLabel, fallbackValue] = i === 0 ? ['"Sem gastos neste mês"', '1'] : ['""', '""'];
    return [
      `=IFERROR(VLOOKUP(${key},${table},2,FALSE),${fallbackLabel})`,
      `=IFERROR(VLOOKUP(${key},${table},3,FALSE),${fallbackValue})`,
    ];
  });
  return [
    {
      range: a1('data', `${label}1:${value}2`),
      values: [
        [
          v.tab === 'dashboard' ? 'Mês escolhido' : 'Mês do relatório',
          `=IF(COUNTIF(${labelsRange},${month})=0,${lastLabel},${month})`,
        ],
        ['Linha do mês', `=MATCH($${value}$1,${labelsRange},0)`],
      ],
    },
    {
      range: a1('data', `${donutLabel}1:${donutValue}${1 + MAX_CATEGORY_ROWS}`),
      values: [['Categoria', 'Gasto'], ...donut],
    },
  ];
}

// ---------------------------------------------------------------------------------------
// Painel: layout fixo (linhas em notação A1, 1 = primeira linha)
// ---------------------------------------------------------------------------------------

const COLUMN_PX = 124;
const MARGIN_PX = 20;
/** Colunas úteis: B..K (1..10). Metade esquerda B..F, direita G..K. */
const LEFT = [1, 6] as const;
const RIGHT = [6, 11] as const;
const CHART_WIDTH = 5 * COLUMN_PX - 8;
const CHART_HEIGHT = 360;

export const PANEL = {
  title: 2,
  selector: 'H2',
  kpiLabel: 4,
  kpiValue: 5,
  kpiDelta: 6,
  /** Faixa larga com a previsão do fim do mês. */
  forecast: 8,
  chartsTop: 10,
  sections: 29,
  tableHeader: 30,
  firstRow: 31,
  budgetRows: 8,
  cardRows: 5,
  balancesTitle: 37,
  balanceRows: 4,
  charts2Top: 43,
  listsTitle: 62,
  listsHeader: 63,
  listsFirst: 64,
  footer: 73,
} as const;

/** Relatório: depois do Painel, a lista de todos os lançamentos do mês. */
export const REPORT_TABLE = {
  title: 75,
  header: 76,
  first: 77,
  /** Até onde formatar (a lista cresce com a fórmula FILTER). */
  last: 700,
  headers: ['Data', 'Valor', 'Tipo', 'Categoria', 'Forma', 'Cartão/Conta', 'Descrição'],
} as const;

/**
 * O que vai para o PDF: A..L (as colunas úteis B..K e as margens) até a última linha da
 * lista, mais uma de margem. Sem isso, o PDF leva as linhas e colunas vazias da aba.
 */
export function reportPrintRange(entryCount: number): string {
  return `A1:L${REPORT_TABLE.first + Math.max(1, entryCount)}`;
}

/** Altura das linhas (px), da linha 1 em diante; o resto fica com 21 px (padrão). */
function rowHeights(): [number, number, number][] {
  const p = PANEL;
  return [
    [1, 1, 10],
    [p.title, p.title, 44],
    [3, 3, 10],
    [p.kpiLabel, p.kpiLabel, 26],
    [p.kpiValue, p.kpiValue, 44],
    [p.kpiDelta, p.kpiDelta, 24],
    [p.forecast - 1, p.forecast - 1, 12],
    [p.forecast, p.forecast, 32],
    [p.forecast + 1, p.forecast + 1, 16],
    [p.chartsTop, p.chartsTop + 17, 21],
    [p.sections - 1, p.sections - 1, 18],
    [p.sections, p.sections, 30],
    [p.tableHeader, p.tableHeader, 24],
    [p.firstRow, p.balancesTitle + p.balanceRows, 26],
    [p.charts2Top - 1, p.charts2Top - 1, 18],
    [p.charts2Top, p.charts2Top + 17, 21],
    [p.listsTitle - 1, p.listsTitle - 1, 18],
    [p.listsTitle, p.listsTitle, 30],
    [p.listsHeader, p.listsHeader, 24],
    [p.listsFirst, p.listsFirst + 7, 26],
    [p.footer, p.footer, 24],
  ];
}

interface Kpi {
  label: string;
  /** Coluna da tabela de meses (Dados), ou null para o saldo da conta (não depende do mês). */
  column: string | null;
  /** Subir é bom (verde) ou ruim (vermelho, como nas despesas). */
  upIsGood: boolean;
}

const KPIS: readonly Kpi[] = [
  { label: '💰 Receitas', column: 'B', upIsGood: true },
  { label: '💸 Despesas', column: 'C', upIsGood: false },
  { label: '🪙 Sobra', column: 'D', upIsGood: true },
  { label: '📈 Investido', column: 'G', upIsGood: true },
  { label: '🏦 Saldo em conta', column: null, upIsGood: true },
];

/** Coluna (letra) do cartão de número `k` (0..4): B, D, F, H, J. */
const kpiColumn = (k: number): string => String.fromCharCode(66 + 2 * k);

/** "▲ 12% vs ago/2026" (ou "= igual a ago/2026") comparando o mês escolhido com o anterior. */
function deltaFormula(column: string, v: DashboardVariant): string {
  const range = MONTHS_COLUMN(column);
  return (
    `=LET(i,${selectedRow(v)},v,INDEX(${range},i),p,IF(i<2,0,INDEX(${range},i-1)),` +
    `IF(p=0,"—",IF(v=p,"= igual a ",IF(v>p,"▲ ","▼ ")&TEXT(ABS(v-p)/ABS(p),"0%")&" vs ")&INDEX(${MONTHS_COLUMN('A')},i-1)))`
  );
}

/** Barra colorida (verde, âmbar a partir de 80%, vermelha acima de 100%). */
function barFormula(ratioCell: string, emptyWhen: string): string {
  return (
    `=IF(${emptyWhen},"",SPARKLINE(MIN(${ratioCell},1),{"charttype","bar";"max",1;"color1",` +
    `IF(${ratioCell}>1,"${THEME.red}",IF(${ratioCell}>=${WARN_RATIO},"${THEME.amber}","${THEME.green}"))}))`
  );
}

/** Células do Painel (textos fixos e fórmulas), já na sintaxe da planilha pt_BR. */
export function dashboardCells(options: {
  cardsWithInvoices: number;
  includeSelector: boolean;
  variant?: DashboardVariant;
}): RangeValues[] {
  const v = options.variant ?? PANEL_VARIANT;
  const report = v.tab === 'report';
  const SELECTED_MONTH = selectedMonth(v);
  const SELECTED_ROW = selectedRow(v);
  const p = PANEL;
  const cells = new Map<string, Cell>();
  const put = (ref: string, value: Cell) => cells.set(ref, value);

  put(`B${p.title}`, report ? `="📄 Relatório · "&${SELECTED_MONTH}` : '💰 Painel financeiro');
  put(`G${p.title}`, '📅 Mês');
  if (options.includeSelector && !report) put(p.selector, 'Mês atual');
  put(`J${p.title}`, '=IF(Dados!$AX$1="","","Atualizado em "&Dados!$AX$1)');
  // A previsão é sempre do mês atual (o seletor não muda o futuro); no relatório de um mês
  // que já fechou, a faixa fica vazia.
  put(
    `B${p.forecast}`,
    report
      ? `=IF(${SELECTED_MONTH}<>Dados!$A$${LAST_MONTH_ROW},"",IF(Dados!$AX$3="","",Dados!$AX$3))`
      : '=IF(Dados!$AX$3="","",Dados!$AX$3)',
  );

  KPIS.forEach((kpi, k) => {
    const col = kpiColumn(k);
    put(`${col}${p.kpiLabel}`, kpi.label);
    if (kpi.column) {
      put(`${col}${p.kpiValue}`, `=INDEX(${MONTHS_COLUMN(kpi.column)},${SELECTED_ROW})`);
      put(`${col}${p.kpiDelta}`, deltaFormula(kpi.column, v));
    } else {
      put(`${col}${p.kpiValue}`, '=Dados!$AX$2');
      put(`${col}${p.kpiDelta}`, 'hoje, somando as contas');
    }
  });

  // Orçamento do mês escolhido.
  // Avisos de "vazio" vão no título (que ocupa a largura toda): numa célula da tabela, as
  // vizinhas com fórmula (mesmo vazias) cortariam o texto.
  const whenEmpty = (condition: string, title: string, hint: string) =>
    `="${title}"&IF(${condition},"  ·  ${hint}","")`;
  put(
    `B${p.sections}`,
    whenEmpty(
      `COUNTIF(${BUDGET_KEYS},${SELECTED_MONTH}&"#1")=0`,
      '🎯 Orçamento do mês',
      'defina limites com /orcamento',
    ),
  );
  ['Categoria', 'Gasto', 'Limite', 'Uso', '%'].forEach((h, i) => {
    put(`${String.fromCharCode(66 + i)}${p.tableHeader}`, h);
  });
  for (let n = 1; n <= p.budgetRows; n++) {
    const row = p.firstRow + n - 1;
    const key = `${SELECTED_MONTH}&"#${n}"`;
    const lookup = (col: number) => `VLOOKUP(${key},${BUDGETS_TABLE},${col},FALSE)`;
    put(`B${row}`, `=IFERROR(${lookup(2)},"")`);
    put(`C${row}`, `=IFERROR(${lookup(3)},"")`);
    put(`D${row}`, `=IFERROR(${lookup(4)},"")`);
    put(`F${row}`, `=IFERROR(${lookup(5)},"")`);
    put(`E${row}`, barFormula(`F${row}`, `F${row}=""`));
  }

  // Cartões de crédito (situação de hoje).
  put(
    `G${p.sections}`,
    whenEmpty('Dados!$AN$2=""', '💳 Cartões de crédito', 'cadastre com /cartoes'),
  );
  ['Cartão', 'Fatura aberta', 'Limite', 'Uso', 'Disponível'].forEach((h, i) => {
    put(`${String.fromCharCode(71 + i)}${p.tableHeader}`, h);
  });
  for (let n = 1; n <= p.cardRows; n++) {
    const row = p.firstRow + n - 1;
    const at = (letter: string) => `INDEX(Dados!$${letter}$2:$${letter}$${1 + MAX_CARD_ROWS},${n})`;
    put(`G${row}`, `=IF(${at('AN')}="","",${at('AN')})`);
    put(`H${row}`, `=IF(${at('AN')}="","",${at('AO')})`);
    put(`I${row}`, `=IF(${at('AN')}="","",${at('AP')})`);
    put(`J${row}`, barFormula(at('AQ'), `OR(${at('AN')}="",${at('AQ')}="")`));
    put(`K${row}`, `=IF(${at('AN')}="","",${at('AR')})`);
  }

  // Contas e vales.
  put(`G${p.balancesTitle}`, '👛 Contas e vales');
  for (let n = 1; n <= p.balanceRows; n++) {
    const row = p.balancesTitle + n;
    const at = (letter: string) => `INDEX(Dados!$${letter}$2:$${letter}$${1 + MAX_BALANCES},${n})`;
    put(`G${row}`, `=IF(${at('AT')}="","",${at('AT')})`);
    put(`I${row}`, `=IF(${at('AT')}="","",${at('AU')})`);
  }

  if (options.cardsWithInvoices === 0) {
    put(
      `G${p.charts2Top}`,
      '💳 As faturas aparecem aqui quando o cartão tiver dia de fechamento (/cartoes).',
    );
  }

  // Maiores gastos do mês escolhido e últimos lançamentos.
  put(
    `B${p.listsTitle}`,
    whenEmpty(
      `COUNTIF(${TOP_KEYS},${SELECTED_MONTH}&"#1")=0`,
      '🔥 Maiores gastos do mês',
      'nenhum gasto neste mês',
    ),
  );
  put(`G${p.listsTitle}`, '🕒 Últimos lançamentos');
  put(`B${p.listsHeader}`, 'Data');
  put(`C${p.listsHeader}`, 'Descrição');
  put(`E${p.listsHeader}`, 'Categoria');
  put(`F${p.listsHeader}`, 'Valor');
  ['Data', 'Descrição', 'Categoria', 'Tipo', 'Valor'].forEach((h, i) => {
    put(`${String.fromCharCode(71 + i)}${p.listsHeader}`, h);
  });
  for (let n = 1; n <= MAX_TOP; n++) {
    const row = p.listsFirst + n - 1;
    const lookup = (col: number) => `VLOOKUP(${SELECTED_MONTH}&"#${n}",${TOP_TABLE},${col},FALSE)`;
    put(`B${row}`, `=IFERROR(${lookup(2)},"")`);
    put(`C${row}`, `=IFERROR(${lookup(3)},"")`);
    put(`E${row}`, `=IFERROR(${lookup(4)},"")`);
    put(`F${row}`, `=IFERROR(${lookup(5)},"")`);
  }
  for (let n = 1; n <= MAX_LATEST; n++) {
    const row = p.listsFirst + n - 1;
    ['AH', 'AI', 'AJ', 'AK', 'AL'].forEach((letter, i) => {
      const ref = `Dados!$${letter}$${n + 1}`;
      put(`${String.fromCharCode(71 + i)}${row}`, `=IF(${ref}="","",${ref})`);
    });
  }

  put(
    `B${p.footer}`,
    report
      ? '="Gerado pelo bot financeiro em "&Dados!$AX$1&". Cartões, contas e últimos lançamentos mostram a situação desse dia."'
      : 'Atualiza sozinho a cada lançamento. Para corrigir, adicionar ou apagar, use a aba Lançamentos.',
  );

  if (report) {
    // Todos os lançamentos do mês, em ordem de data. O período vem de Dados!BN1:BN2,
    // escrito pelo bot na hora de gerar o PDF.
    const t = REPORT_TABLE;
    const column = (letter: string) => `'Lançamentos'!$${letter}$2:$${letter}`;
    put(`B${t.title}`, `="📋 Lançamentos de "&${SELECTED_MONTH}`);
    t.headers.forEach((h, i) => {
      put(`${String.fromCharCode(66 + i)}${t.header}`, h);
    });
    put(
      `B${t.first}`,
      `=IFERROR(SORT(FILTER({${['B', 'F', 'C', 'E', 'H', 'I', 'D'].map(column).join(',')}},` +
        `${column('B')}>=Dados!$BN$1,${column('B')}<Dados!$BN$2),1,TRUE),"Nenhum lançamento neste mês")`,
    );
  }

  const localize = (value: Cell): Cell =>
    typeof value === 'string' && value.startsWith('=') ? toLocaleFormula(value) : value;
  return [
    ...[...cells].map(([ref, value]) => ({
      range: a1(v.tab, ref),
      values: [[localize(value)]],
    })),
    ...dataFormulas(v).map((r) => ({ ...r, values: r.values.map((row) => row.map(localize)) })),
  ];
}

/** O que limpar antes de reescrever as fórmulas (no Painel, tudo menos o mês escolhido). */
export function dashboardClearRanges(v: DashboardVariant = PANEL_VARIANT): string[] {
  const { label, donutValue } = v.helper;
  return [
    a1(v.tab, 'A1:Z1'),
    a1(v.tab, 'A2:G2'),
    a1(v.tab, 'J2:Z2'),
    a1(v.tab, `A3:Z${REPORT_TABLE.last}`),
    a1('data', `${label}1:${v.tab === 'report' ? 'BN' : donutValue}100`),
  ];
}

// ---------------------------------------------------------------------------------------
// Painel: formatos, tamanhos, cartões e regras
// ---------------------------------------------------------------------------------------

function gridRange(
  sheetId: number,
  rows: readonly [number, number],
  columns: readonly [number, number],
): sheets_v4.Schema$GridRange {
  return {
    sheetId,
    startRowIndex: rows[0] - 1,
    endRowIndex: rows[1],
    startColumnIndex: columns[0],
    endColumnIndex: columns[1],
  };
}

const CURRENCY = { type: 'CURRENCY', pattern: '"R$" #,##0.00' };
const SIGNED_CURRENCY = { type: 'CURRENCY', pattern: '+"R$" #,##0.00;-"R$" #,##0.00' };
const DATE = { type: 'DATE', pattern: 'dd/mm/yyyy' };
const PERCENT = { type: 'PERCENT', pattern: '0%' };

function merge(range: sheets_v4.Schema$GridRange): SheetRequest {
  return { mergeCells: { range, mergeType: 'MERGE_ALL' } };
}

/** Formatos, tamanhos e regras do Painel (a aba inteira é reformatada do zero). */
export function dashboardFormatRequests(
  sheetId: number,
  variant: DashboardVariant = PANEL_VARIANT,
): SheetRequest[] {
  const p = PANEL;
  const g = (rows: readonly [number, number], columns: readonly [number, number]) =>
    gridRange(sheetId, rows, columns);
  const all = { sheetId };
  const requests: SheetRequest[] = [
    { unmergeCells: { range: all } },
    cellFormat(all, {
      backgroundColorStyle: color(THEME.background),
      textFormat: textFormat(THEME.text, { size: 10 }),
      verticalAlignment: 'MIDDLE',
      // Texto longo invade a célula vizinha quando ela está vazia (e é cortado quando não).
      wrapStrategy: 'OVERFLOW_CELL',
      borders: {},
    }),
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: MARGIN_PX },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 11 },
        properties: { pixelSize: COLUMN_PX },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 11, endIndex: 12 },
        properties: { pixelSize: MARGIN_PX },
        fields: 'pixelSize',
      },
    },
    ...rowHeights().map(([from, to, px]): SheetRequest => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: from - 1, endIndex: to },
        properties: { pixelSize: px },
        fields: 'pixelSize',
      },
    })),

    // Título, seletor de mês e "Atualizado em".
    merge(g([p.title, p.title], [1, 6])),
    cellFormat(g([p.title, p.title], [1, 6]), {
      textFormat: textFormat(THEME.gold, { bold: true, size: 20 }),
    }),
    cellFormat(g([p.title, p.title], [6, 7]), {
      textFormat: textFormat(THEME.muted, { size: 10 }),
      horizontalAlignment: 'RIGHT',
    }),
    merge(g([p.title, p.title], [7, 9])),
    cellFormat(g([p.title, p.title], [7, 9]), {
      backgroundColorStyle: color(THEME.card),
      textFormat: textFormat(THEME.gold, { bold: true, size: 11 }),
      horizontalAlignment: 'CENTER',
    }),
    borders(g([p.title, p.title], [7, 9]), THEME.gold),
    // Só o Painel tem a lista de meses; no Relatório o mês é preenchido pelo bot.
    ...(variant.tab === 'dashboard'
      ? [
          {
            setDataValidation: {
              range: g([p.title, p.title], [7, 8]),
              rule: {
                condition: {
                  type: 'ONE_OF_RANGE',
                  values: [{ userEnteredValue: `=Dados!$AZ$1:$AZ$${1 + SUMMARY_MONTHS}` }],
                },
                showCustomUi: true,
                strict: true,
              },
            },
          } satisfies SheetRequest,
        ]
      : []),
    merge(g([p.title, p.title], [9, 11])),
    cellFormat(g([p.title, p.title], [9, 11]), {
      textFormat: textFormat(THEME.muted, { size: 9 }),
      horizontalAlignment: 'RIGHT',
    }),

    // Faixa da previsão: vermelha quando o mês vai fechar negativo (texto começa com ⚠️).
    merge(g([p.forecast, p.forecast], [1, 11])),
    cellFormat(g([p.forecast, p.forecast], [1, 11]), {
      backgroundColorStyle: color(THEME.card),
      textFormat: textFormat(THEME.gold, { bold: true, size: 11 }),
      horizontalAlignment: 'CENTER',
    }),
    borders(g([p.forecast, p.forecast], [1, 11]), THEME.border),
    conditionalText(g([p.forecast, p.forecast], [1, 11]), textStartsWith('⚠️'), THEME.red, true),
  ];

  // Cartões com os números do mês.
  KPIS.forEach((kpi, k) => {
    const cols = [1 + 2 * k, 3 + 2 * k] as const;
    for (const row of [p.kpiLabel, p.kpiValue, p.kpiDelta])
      requests.push(merge(g([row, row], cols)));
    requests.push(
      cellFormat(g([p.kpiLabel, p.kpiDelta], cols), {
        backgroundColorStyle: color(THEME.card),
        horizontalAlignment: 'CENTER',
      }),
      cellFormat(g([p.kpiLabel, p.kpiLabel], cols), {
        textFormat: textFormat(THEME.gold, { bold: true, size: 10 }),
      }),
      cellFormat(g([p.kpiValue, p.kpiValue], cols), {
        textFormat: textFormat(THEME.text, { bold: true, size: 20 }),
        numberFormat: CURRENCY,
      }),
      cellFormat(g([p.kpiDelta, p.kpiDelta], cols), {
        textFormat: textFormat(THEME.muted, { size: 9 }),
      }),
      borders(g([p.kpiLabel, p.kpiDelta], cols), THEME.border),
    );
    const delta = g([p.kpiDelta, p.kpiDelta], cols);
    if (kpi.column) {
      requests.push(
        conditionalText(delta, textStartsWith('▲'), kpi.upIsGood ? THEME.green : THEME.red),
        conditionalText(delta, textStartsWith('▼'), kpi.upIsGood ? THEME.red : THEME.green),
      );
    }
    requests.push(
      conditionalText(g([p.kpiValue, p.kpiValue], cols), numberLess(0), THEME.red, true),
    );
  });

  // Painéis de tabela: fundo de cartão, título dourado e cabeçalho discreto.
  const panels: {
    title: number;
    header: number | null;
    rows: [number, number];
    cols: readonly [number, number];
  }[] = [
    {
      title: p.sections,
      header: p.tableHeader,
      rows: [p.firstRow, p.firstRow + p.budgetRows - 1],
      cols: LEFT,
    },
    {
      title: p.sections,
      header: p.tableHeader,
      rows: [p.firstRow, p.firstRow + p.cardRows - 1],
      cols: RIGHT,
    },
    {
      title: p.balancesTitle,
      header: null,
      rows: [p.balancesTitle + 1, p.balancesTitle + p.balanceRows],
      cols: RIGHT,
    },
    {
      title: p.listsTitle,
      header: p.listsHeader,
      rows: [p.listsFirst, p.listsFirst + MAX_TOP - 1],
      cols: LEFT,
    },
    {
      title: p.listsTitle,
      header: p.listsHeader,
      rows: [p.listsFirst, p.listsFirst + MAX_LATEST - 1],
      cols: RIGHT,
    },
  ];
  for (const panel of panels) {
    const whole = g([panel.title, panel.rows[1]], panel.cols);
    requests.push(
      cellFormat(whole, { backgroundColorStyle: color(THEME.card) }),
      borders(whole, THEME.border),
      merge(g([panel.title, panel.title], panel.cols)),
      cellFormat(g([panel.title, panel.title], panel.cols), {
        textFormat: textFormat(THEME.gold, { bold: true, size: 12 }),
      }),
    );
    if (panel.header !== null) {
      requests.push(
        cellFormat(g([panel.header, panel.header], panel.cols), {
          textFormat: textFormat(THEME.muted, { bold: true, size: 9 }),
        }),
        bottomBorder(g([panel.header, panel.header], panel.cols), THEME.border),
      );
    }
  }

  const budget: [number, number] = [p.firstRow, p.firstRow + p.budgetRows - 1];
  const cards: [number, number] = [p.firstRow, p.firstRow + p.cardRows - 1];
  const balances: [number, number] = [p.balancesTitle + 1, p.balancesTitle + p.balanceRows];
  const top: [number, number] = [p.listsFirst, p.listsFirst + MAX_TOP - 1];
  const latest: [number, number] = [p.listsFirst, p.listsFirst + MAX_LATEST - 1];
  requests.push(
    cellFormat(g(budget, [2, 4]), { numberFormat: CURRENCY }),
    cellFormat(g(budget, [5, 6]), { numberFormat: PERCENT, horizontalAlignment: 'RIGHT' }),
    conditionalText(g(budget, [5, 6]), numberAtLeast(WARN_RATIO), THEME.amber, true),
    conditionalText(g(budget, [5, 6]), numberGreater(1), THEME.red, true),
    cellFormat(g(cards, [7, 9]), { numberFormat: CURRENCY }),
    cellFormat(g(cards, [10, 11]), { numberFormat: CURRENCY }),
    ...[p.balancesTitle + 1, p.balancesTitle + 2, p.balancesTitle + 3, p.balancesTitle + 4].map(
      (row) => merge(g([row, row], [6, 8])),
    ),
    cellFormat(g(balances, [8, 9]), { numberFormat: CURRENCY }),
    ...[p.listsHeader, ...Array.from({ length: MAX_TOP }, (_, i) => p.listsFirst + i)].map((row) =>
      merge(g([row, row], [2, 4])),
    ),
    cellFormat(g(top, [1, 2]), { numberFormat: DATE }),
    cellFormat(g(top, [5, 6]), { numberFormat: CURRENCY }),
    cellFormat(g(latest, [6, 7]), { numberFormat: DATE }),
    cellFormat(g(latest, [10, 11]), { numberFormat: SIGNED_CURRENCY }),
    conditionalText(g(latest, [10, 11]), numberLess(0), THEME.red),
    conditionalText(g(latest, [10, 11]), numberGreater(0), THEME.green),
    merge(g([p.footer, p.footer], [1, 11])),
    cellFormat(g([p.footer, p.footer], [1, 11]), {
      textFormat: textFormat(THEME.muted, { size: 9 }),
      horizontalAlignment: 'CENTER',
    }),
  );
  if (variant.tab === 'report') requests.push(...reportTableFormat(g));
  return requests;
}

/** A lista de lançamentos do Relatório: título, cabeçalho e formatos de data e valor. */
function reportTableFormat(
  g: (
    rows: readonly [number, number],
    columns: readonly [number, number],
  ) => sheets_v4.Schema$GridRange,
): SheetRequest[] {
  const t = REPORT_TABLE;
  const columns = [1, 1 + t.headers.length] as const;
  return [
    merge(g([t.title, t.title], [1, 11])),
    cellFormat(g([t.title, t.title], [1, 11]), {
      textFormat: textFormat(THEME.gold, { bold: true, size: 12 }),
    }),
    cellFormat(g([t.header, t.header], columns), {
      textFormat: textFormat(THEME.muted, { bold: true, size: 9 }),
    }),
    bottomBorder(g([t.header, t.header], columns), THEME.border),
    cellFormat(g([t.first, t.last], [1, 2]), { numberFormat: DATE }),
    cellFormat(g([t.first, t.last], [2, 3]), { numberFormat: CURRENCY }),
  ];
}

function textStartsWith(prefix: string): sheets_v4.Schema$BooleanCondition {
  return { type: 'TEXT_STARTS_WITH', values: [{ userEnteredValue: prefix }] };
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

// ---------------------------------------------------------------------------------------
// Gráficos do Painel
// ---------------------------------------------------------------------------------------

function source(
  sheetId: number,
  rows: readonly [number, number],
  column: number,
): sheets_v4.Schema$ChartData {
  return {
    sourceRange: {
      sources: [
        {
          sheetId,
          startRowIndex: rows[0],
          endRowIndex: rows[1],
          startColumnIndex: column,
          endColumnIndex: column + 1,
        },
      ],
    },
  };
}

/** Moldura escura comum a todos os gráficos (o texto claro vem do tema da planilha). */
function darkSpec(title: string, spec: sheets_v4.Schema$ChartSpec): sheets_v4.Schema$ChartSpec {
  return {
    title,
    fontName: THEME.font,
    backgroundColorStyle: color(THEME.card),
    titleTextFormat: textFormat(THEME.gold, { bold: true, size: 13 }),
    ...spec,
  };
}

function axes(): sheets_v4.Schema$BasicChartAxis[] {
  const format = { foregroundColorStyle: color(THEME.muted), fontFamily: THEME.font };
  return [
    { position: 'BOTTOM_AXIS', format },
    { position: 'LEFT_AXIS', format },
  ];
}

interface ChartIds {
  dashboard: number;
  report: number;
  data: number;
  cards: number;
}

/** "BE" → 56 (índice zero-based da coluna). */
function letterIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + letters.charCodeAt(i) - 64;
  return n - 1;
}

/** Os gráficos do Painel (apaga os que já existem nele e cria de novo). */
export function dashboardChartRequests(
  ids: ChartIds,
  existingChartIds: readonly number[],
  cardsWithInvoices: number,
  variant: DashboardVariant = PANEL_VARIANT,
): SheetRequest[] {
  const { data } = ids;
  const chartRows = [0, 1 + CHART_MONTHS] as const;
  // Colunas da tabela K1:P13 da aba Dados: K=10 mês, L receitas, M despesas, N sobra, P acumulado.
  const month = source(data, chartRows, 10);
  // A cor vai nos dois campos: o Google ignora o `colorStyle` sozinho em algumas séries.
  const series = (column: number, hex: string): sheets_v4.Schema$BasicChartSeries => ({
    series: source(data, chartRows, column),
    targetAxis: 'LEFT_AXIS',
    color: rgb(hex),
    colorStyle: color(hex),
  });

  const specs: [sheets_v4.Schema$ChartSpec, number, number][] = [
    [
      darkSpec('🍩 Gastos por categoria', {
        pieChart: {
          legendPosition: 'RIGHT_LEGEND',
          pieHole: 0.55,
          domain: source(data, [1, 1 + MAX_CATEGORY_ROWS], letterIndex(variant.helper.donutLabel)),
          series: source(data, [1, 1 + MAX_CATEGORY_ROWS], letterIndex(variant.helper.donutValue)),
        },
      }),
      PANEL.chartsTop,
      LEFT[0],
    ],
    [
      darkSpec('📊 Receitas × despesas (12 meses)', {
        basicChart: {
          chartType: 'COLUMN',
          legendPosition: 'TOP_LEGEND',
          headerCount: 1,
          axis: axes(),
          domains: [{ domain: month }],
          series: [series(11, THEME.green), series(12, THEME.red), series(13, THEME.gold)],
        },
      }),
      PANEL.chartsTop,
      RIGHT[0],
    ],
    [
      darkSpec('📈 Investido acumulado (12 meses)', {
        basicChart: {
          chartType: 'AREA',
          legendPosition: 'NO_LEGEND',
          headerCount: 1,
          axis: axes(),
          domains: [{ domain: month }],
          series: [series(15, THEME.blue)],
        },
      }),
      PANEL.charts2Top,
      LEFT[0],
    ],
  ];
  if (cardsWithInvoices > 0) {
    const invoiceRows = [1, 2 + INVOICE_ROWS] as const;
    specs.push([
      darkSpec('💳 Faturas por cartão (com parcelas futuras)', {
        basicChart: {
          chartType: 'COLUMN',
          legendPosition: 'TOP_LEGEND',
          headerCount: 1,
          stackedType: 'STACKED',
          axis: axes(),
          domains: [{ domain: source(ids.cards, invoiceRows, 0) }],
          series: Array.from({ length: cardsWithInvoices }, (_, i) => ({
            series: source(ids.cards, invoiceRows, 1 + i),
            targetAxis: 'LEFT_AXIS',
          })),
        },
      }),
      PANEL.charts2Top,
      RIGHT[0],
    ]);
  }

  return [
    ...existingChartIds.map((objectId): SheetRequest => ({ deleteEmbeddedObject: { objectId } })),
    ...specs.map(([spec, row, column]): SheetRequest => ({
      addChart: {
        chart: {
          spec,
          position: {
            overlayPosition: {
              anchorCell: { sheetId: ids[variant.tab], rowIndex: row - 1, columnIndex: column },
              offsetXPixels: column === RIGHT[0] ? 8 : 0,
              widthPixels: CHART_WIDTH,
              heightPixels: CHART_HEIGHT,
            },
          },
        },
      },
    })),
  ];
}
