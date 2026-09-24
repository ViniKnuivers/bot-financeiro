const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Formata centavos como "R$ 18,50". A divisão por 100 aqui é só para exibição:
 * nenhum cálculo com dinheiro é feito em ponto flutuante.
 */
export function formatCents(cents: number): string {
  return brl.format(cents / 100);
}

/**
 * Converte um valor digitado em reais para centavos, sem passar por float:
 * "230,50" → 23050, "R$ 1.234,56" → 123456, "1.500" → 150000, "12.5" → 1250, "0" → 0.
 * Regra brasileira: a vírgula é o separador decimal. Sem vírgula, um ponto seguido de
 * 1 ou 2 dígitos no fim é decimal ("12.50"); com 3 dígitos é milhar ("1.500").
 * Retorna null se não for um valor válido e não negativo.
 */
export function parseBrlToCents(input: string): number | null {
  const text = input.replace(/r\$/i, '').replace(/\s/g, '');
  if (!/^\d[\d.,]*$/.test(text)) return null;

  let integerPart: string;
  let decimalPart: string;
  if (text.includes(',')) {
    const [intText = '', decimals = '', ...rest] = text.split(',');
    if (rest.length > 0) return null;
    integerPart = intText.replace(/\./g, '');
    decimalPart = decimals;
  } else {
    const match = /^(.*)\.(\d{1,2})$/.exec(text);
    integerPart = (match ? (match[1] ?? '') : text).replace(/\./g, '');
    decimalPart = match?.[2] ?? '';
  }

  if (!/^\d+$/.test(integerPart) || !/^\d{0,2}$/.test(decimalPart)) return null;
  return Number(integerPart) * 100 + Number(decimalPart.padEnd(2, '0'));
}
