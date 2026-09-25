/**
 * A API do Google interpreta fórmulas no idioma da planilha, e a planilha do bot é pt_BR:
 * lá o separador de argumentos é ";", o de colunas em matrizes "{a\b}" é "\" e o decimal
 * é ",". As fórmulas ficam escritas no código na sintaxe em inglês (a da documentação) e
 * são convertidas aqui, sem mexer no que está dentro de textos ("...") e nomes de aba ('...').
 */
export function toLocaleFormula(formula: string): string {
  let out = '';
  const brackets: string[] = [];
  for (let i = 0; i < formula.length; i++) {
    const char = formula.charAt(i);
    if (char === '"' || char === "'") {
      const end = closingQuote(formula, i);
      out += formula.slice(i, end + 1);
      i = end;
      continue;
    }
    if (char === '(' || char === '{') brackets.push(char);
    else if (char === ')' || char === '}') brackets.pop();

    if (char === ',') out += brackets.at(-1) === '{' ? '\\' : ';';
    else if (char === '.' && isDigit(formula.charAt(i - 1)) && isDigit(formula.charAt(i + 1)))
      out += ',';
    else out += char;
  }
  return out;
}

/** Número como o usuário digitaria na planilha pt_BR ("0.8" → "0,8"), para regras. */
export function toLocaleNumber(value: number): string {
  return String(value).replace('.', ',');
}

/** Posição da aspa que fecha o texto aberto em `start` (aspas dobradas são escape). */
function closingQuote(formula: string, start: number): number {
  const quote = formula.charAt(start);
  let i = start + 1;
  while (i < formula.length) {
    if (formula.charAt(i) === quote) {
      if (formula.charAt(i + 1) !== quote) return i;
      i += 2;
    } else {
      i += 1;
    }
  }
  return formula.length - 1;
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}
