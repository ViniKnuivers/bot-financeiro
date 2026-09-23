import type { FastifyBaseLogger } from 'fastify';

/**
 * O subconjunto do logger (pino, via Fastify) de que as camadas precisam.
 * Depender só disso facilita passar um logger falso nos testes.
 */
export type Logger = Pick<FastifyBaseLogger, 'debug' | 'info' | 'warn' | 'error'>;
