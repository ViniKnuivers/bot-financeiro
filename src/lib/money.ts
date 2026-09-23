const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Formata centavos como "R$ 18,50". A divisão por 100 aqui é só para exibição:
 * nenhum cálculo com dinheiro é feito em ponto flutuante.
 */
export function formatCents(cents: number): string {
  return brl.format(cents / 100);
}
