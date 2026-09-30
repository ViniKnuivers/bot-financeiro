import type { FastifyBaseLogger } from 'fastify';

/**
 * O subconjunto do logger (pino, via Fastify) de que as camadas precisam.
 * Depender só disso facilita passar um logger falso nos testes.
 */
export type Logger = Pick<FastifyBaseLogger, 'debug' | 'info' | 'warn' | 'error'>;

/**
 * Tira segredos de uma linha de log já pronta: bibliotecas às vezes colocam o token na
 * mensagem de erro (ex.: o grammY inclui a URL "api.telegram.org/bot<token>/..." quando a
 * rede falha), e a URL do retorno do Google traz o código de autorização.
 */
export function redactSecrets(line: string): string {
  return line
    .replace(/bot\d+:[\w-]{20,}/g, 'bot<oculto>')
    .replace(/([?&](?:code|state|access_token|refresh_token)=)[^&"\s\\]+/g, '$1<oculto>')
    .replace(/\bya29\.[\w.-]+/g, 'ya29.<oculto>')
    .replace(/(Bearer\s+)[\w.~+/-]+=*/gi, '$1<oculto>');
}
