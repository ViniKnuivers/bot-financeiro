/**
 * Posições fixas das abas da planilha. Os gráficos apontam para essas faixas, então elas
 * não podem "andar": cada tabela tem um número fixo de linhas reservado.
 */

export const TABS = {
  dashboard: 'Painel',
  transactions: 'Lançamentos',
  summary: 'Resumo',
  categories: 'Categorias',
  cards: 'Cartões e vales',
  investments: 'Investimentos',
  data: 'Dados',
  report: 'Relatório',
} as const;

export type TabKey = keyof typeof TABS;

/** Ordem das abas na planilha. */
export const TAB_ORDER: readonly TabKey[] = [
  'dashboard',
  'transactions',
  'summary',
  'categories',
  'cards',
  'investments',
  'data',
  'report',
];

/** Abas só de leitura (calculadas pelo bot): editar à mão mostra um aviso. */
export const READ_ONLY_TABS: readonly TabKey[] = [
  'dashboard',
  'summary',
  'categories',
  'cards',
  'investments',
  'data',
  'report',
];

/** Abas que versões antigas do bot criavam e que ele mesmo remove (os gráficos foram para o Painel). */
export const LEGACY_TAB_TITLES: readonly string[] = ['Gráficos'];

export const TRANSACTION_HEADERS = [
  'ID',
  'Data',
  'Tipo',
  'Descrição',
  'Categoria',
  'Valor',
  'Parcelas',
  'Forma',
  'Cartão/Conta',
  'Origem',
  'Status',
] as const;

/** Resumo: tabela mês a mês em D1:L25 (cabeçalho + 24 meses). Gráficos usam os 12 últimos. */
export const SUMMARY_MONTHS = 24;
export const CHART_MONTHS = 12;
export const SUMMARY_TABLE_HEADERS = [
  'Mês',
  'Receitas',
  'Despesas',
  'Sobra',
  'Aportes',
  'Resgates',
  'Investido no mês',
  'Livre',
  'Investido acumulado',
] as const;
/** Saldos das contas no Resumo: A11:B20. */
export const MAX_BALANCE_ROWS = 10;

/** Cartões: faturas de 3 meses atrás até 6 à frente (A3:?12). */
export const INVOICE_MONTHS_BACK = 3;
export const INVOICE_MONTHS_AHEAD = 6;
export const INVOICE_ROWS = INVOICE_MONTHS_BACK + 1 + INVOICE_MONTHS_AHEAD;
export const MAX_CARD_ROWS = 10;

/** Investimentos: A2:D31. */
export const MAX_INVESTMENT_ROWS = 30;

/** "'Cartões e vales'!A1:B2": nomes com espaço ou acento precisam de aspas. */
export function a1(tab: TabKey, range: string): string {
  return `'${TABS[tab]}'!${range}`;
}

/** Coluna por índice zero-based: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let letter = '';
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}
