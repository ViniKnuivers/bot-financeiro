import { describe, expect, it } from 'vitest';
import { columnWidthRequests, type TabIds } from './sheet-structure.js';

const ids: TabIds = {
  transactions: 1,
  summary: 2,
  categories: 3,
  cards: 4,
  investments: 5,
  charts: 6,
};

function widths(requests: ReturnType<typeof columnWidthRequests>) {
  return requests.map((r) => {
    const update = r.updateDimensionProperties;
    return [update?.range?.sheetId, update?.range?.startIndex, update?.properties?.pixelSize];
  });
}

describe('columnWidthRequests', () => {
  it('usa o texto mais longo de cada coluna, a partir da coluna inicial da faixa', () => {
    const requests = columnWidthRequests(ids, [
      {
        range: "'Resumo'!D1:E3",
        values: [
          ['Mês', 'Investido no mês'],
          ['set/2026', 1234.5],
        ],
      },
    ]);
    // "set/2026" (8) → 84 px; "Investido no mês" (16) → 144 px.
    expect(widths(requests)).toEqual([
      [2, 3, 84],
      [2, 4, 144],
    ]);
  });

  it('valores em R$ contam com símbolo, milhares e centavos', () => {
    const requests = columnWidthRequests(ids, [
      { range: "'Categorias'!A1:A3", values: [['X'], [-12345.67]] },
    ]);
    // "-R$ 12.345,67" = 13 caracteres.
    expect(widths(requests)).toEqual([[3, 0, 122]]);
  });

  it('coluna ID estreita, títulos soltos e aba de gráficos não mexem na largura', () => {
    const requests = columnWidthRequests(ids, [
      {
        range: "'Lançamentos'!A1:B",
        values: [
          ['ID', 'Data'],
          ['0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000', 46290],
        ],
      },
      { range: "'Cartões e vales'!A1", values: [['Faturas por mês (inclui parcelas futuras)']] },
      { range: "'Gráficos'!A1:A2", values: [['qualquer coisa'], ['x']] },
    ]);
    expect(widths(requests)).toEqual([
      [1, 0, 80],
      [1, 1, 114],
    ]);
  });

  it('limita colunas muito largas', () => {
    const requests = columnWidthRequests(ids, [
      { range: "'Lançamentos'!K1:K2", values: [['Status'], ['⚠️ '.padEnd(200, 'x')]] },
    ]);
    expect(widths(requests)).toEqual([[1, 10, 360]]);
  });
});
