import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

export interface ServerDeps {
  logger: FastifyServerOptions['logger'];
  /** Verifica se o banco responde. Injetado para o servidor não conhecer o Prisma. */
  checkDatabase: () => Promise<void>;
}

export function buildServer({ logger, checkDatabase }: ServerDeps): FastifyInstance {
  const app = Fastify({ logger });

  app.get('/health', async (_request, reply) => {
    try {
      await checkDatabase();
      return { status: 'ok', database: 'up' };
    } catch (error) {
      app.log.error({ err: error }, 'health check: banco indisponível');
      return reply.code(503).send({ status: 'degraded', database: 'down' });
    }
  });

  return app;
}
