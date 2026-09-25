import { describe, expect, it } from 'vitest';
import { toLocaleFormula, toLocaleNumber } from './sheet-formula.js';

describe('toLocaleFormula', () => {
  it('troca vírgulas de argumentos por ponto e vírgula', () => {
    expect(toLocaleFormula('=IF(B1>5,"ok","não")')).toBe('=IF(B1>5;"ok";"não")');
    expect(toLocaleFormula('=INDEX(B1:B4,MATCH("c",A1:A4,0))')).toBe(
      '=INDEX(B1:B4;MATCH("c";A1:A4;0))',
    );
  });

  it('em matrizes, vírgula separa colunas (\\) e ponto e vírgula continua separando linhas', () => {
    expect(
      toLocaleFormula(
        '=SPARKLINE(B3,{"charttype","bar";"max",1;"color1",IF(B3>=0.8,"#D4AF37","#3FB950")})',
      ),
    ).toBe(
      '=SPARKLINE(B3;{"charttype"\\"bar";"max"\\1;"color1"\\IF(B3>=0,8;"#D4AF37";"#3FB950")})',
    );
  });

  it('decimais viram vírgula, mas textos e nomes de aba ficam intactos', () => {
    expect(toLocaleFormula('=ROUND(B6*2.5,1)')).toBe('=ROUND(B6*2,5;1)');
    expect(toLocaleFormula('=IF(A1="a, b. 1.5","x ""y, z""",\'Aba, 1.2\'!A1)')).toBe(
      '=IF(A1="a, b. 1.5";"x ""y, z""";\'Aba, 1.2\'!A1)',
    );
  });

  it('referências e intervalos não mudam', () => {
    expect(toLocaleFormula('=Dados!$B$2:$B$25')).toBe('=Dados!$B$2:$B$25');
    expect(toLocaleFormula('💰 Painel financeiro')).toBe('💰 Painel financeiro');
  });
});

describe('toLocaleNumber', () => {
  it('usa vírgula decimal', () => {
    expect(toLocaleNumber(0.8)).toBe('0,8');
    expect(toLocaleNumber(1)).toBe('1');
  });
});
