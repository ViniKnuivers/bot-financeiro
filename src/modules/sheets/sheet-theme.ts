import type { sheets_v4 } from '@googleapis/sheets';
import type { SheetRequest } from './spreadsheet-gateway.js';

/** Tema escuro "premium": grafite com destaque dourado. Um lugar só para todas as cores. */
export const THEME = {
  font: 'Inter',
  background: '#121417',
  card: '#1C1F26',
  border: '#2A2F3A',
  text: '#E6E8EC',
  muted: '#8B93A1',
  gold: '#D4AF37',
  green: '#3FB950',
  red: '#F85149',
  amber: '#D29922',
  blue: '#58A6FF',
  purple: '#A371F7',
  cyan: '#39C5CF',
} as const;

/**
 * Muda quando o visual muda: a planilha de quem já usa o bot é reformatada sozinha no
 * próximo deploy (a versão entra na assinatura da estrutura).
 */
export const THEME_VERSION = 7;

export function rgb(hex: string): sheets_v4.Schema$Color {
  return {
    red: parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

export function color(hex: string): sheets_v4.Schema$ColorStyle {
  return { rgbColor: rgb(hex) };
}

export function textFormat(
  hex: string,
  options: { bold?: boolean; size?: number } = {},
): sheets_v4.Schema$TextFormat {
  return {
    fontFamily: THEME.font,
    foregroundColorStyle: color(hex),
    ...(options.bold ? { bold: true } : {}),
    ...(options.size ? { fontSize: options.size } : {}),
  };
}

/**
 * Tema da planilha: define a fonte padrão, o texto claro (é o que deixa legendas e eixos
 * dos gráficos legíveis no fundo escuro, pois a API não tem cor de legenda) e a paleta das
 * fatias da rosca e das séries sem cor própria. Também garante o idioma pt_BR, do qual
 * dependem as fórmulas (ver `toLocaleFormula`).
 */
export function spreadsheetThemeRequest(timeZone: string): SheetRequest {
  const accents = [THEME.gold, THEME.green, THEME.blue, THEME.red, THEME.purple, THEME.cyan];
  return {
    updateSpreadsheetProperties: {
      properties: {
        locale: 'pt_BR',
        timeZone,
        spreadsheetTheme: {
          primaryFontFamily: THEME.font,
          themeColors: [
            { colorType: 'TEXT', color: color(THEME.text) },
            { colorType: 'BACKGROUND', color: color(THEME.background) },
            { colorType: 'LINK', color: color(THEME.gold) },
            ...accents.map((hex, i) => ({ colorType: `ACCENT${i + 1}`, color: color(hex) })),
          ],
        },
      },
      fields: 'locale,timeZone,spreadsheetTheme',
    },
  };
}

/** Formata as células da faixa (só os campos pedidos, o resto fica como está). */
export function cellFormat(
  range: sheets_v4.Schema$GridRange,
  format: sheets_v4.Schema$CellFormat,
): SheetRequest {
  const fields = Object.keys(format)
    .map((key) => `userEnteredFormat.${key}`)
    .join(',');
  return { repeatCell: { range, cell: { userEnteredFormat: format }, fields } };
}

/** Contorno (e linhas internas, se pedido) numa cor do tema. */
export function borders(
  range: sheets_v4.Schema$GridRange,
  hex: string,
  options: { inner?: boolean; style?: string } = {},
): SheetRequest {
  const line = { style: options.style ?? 'SOLID', colorStyle: color(hex) };
  return {
    updateBorders: {
      range,
      top: line,
      bottom: line,
      left: line,
      right: line,
      ...(options.inner ? { innerHorizontal: line } : {}),
    },
  };
}

/** Linha só embaixo da faixa (cabeçalhos de tabela). */
export function bottomBorder(range: sheets_v4.Schema$GridRange, hex: string): SheetRequest {
  return { updateBorders: { range, bottom: { style: 'SOLID_MEDIUM', colorStyle: color(hex) } } };
}

/** Cor do texto quando a regra bate (ex.: valores negativos em vermelho). */
export function conditionalText(
  range: sheets_v4.Schema$GridRange,
  condition: sheets_v4.Schema$BooleanCondition,
  hex: string,
  bold = false,
): SheetRequest {
  return {
    addConditionalFormatRule: {
      rule: {
        ranges: [range],
        booleanRule: {
          condition,
          format: { textFormat: { foregroundColorStyle: color(hex), ...(bold ? { bold } : {}) } },
        },
      },
      index: 0,
    },
  };
}
