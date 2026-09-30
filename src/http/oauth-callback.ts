import type { FastifyInstance } from 'fastify';
import type { Logger } from '../lib/logger.js';
import { DriveAuthError } from '../modules/backup/google-oauth.js';

export const OAUTH_CALLBACK_PATH = '/oauth/google/callback';

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}

function page(title: string, detail: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15171c;color:#e8e6e1;font:16px/1.5 system-ui,sans-serif}
main{max-width:420px;padding:32px;text-align:center}h1{color:#d4af37;font-size:22px}</style></head>
<body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}

/**
 * Retorno da autorização do Google Drive. A porta do bot só é publicada em 127.0.0.1;
 * mesmo assim, recusa o que chega repassado (ex.: pelo ngrok do WhatsApp), e a troca
 * só funciona com o `state` de um link gerado pelo /backup há menos de 10 minutos.
 */
export async function registerOAuthCallback(
  app: FastifyInstance,
  deps: {
    connect: (query: CallbackQuery) => Promise<void>;
    /** Depois de conectar (avisar no chat e fazer o primeiro backup). */
    onConnected: () => void;
    logger: Logger;
  },
): Promise<void> {
  await app.register((scope, _options, done) => {
    scope.get<{ Querystring: CallbackQuery }>(OAUTH_CALLBACK_PATH, async (request, reply) => {
      if (request.headers['x-forwarded-for'] !== undefined) return reply.code(404).send();
      void reply.type('text/html; charset=utf-8');
      const { code, state, error } = request.query;
      try {
        await deps.connect({ code, state, error });
      } catch (failure) {
        deps.logger.warn({ err: failure }, 'backup: autorização do Google Drive falhou');
        if (failure instanceof DriveAuthError && failure.reason === 'state') {
          return reply
            .code(400)
            .send(
              page(
                'Link vencido',
                'Este link já foi usado ou passou de 10 minutos. Mande /backup de novo no chat para gerar outro.',
              ),
            );
        }
        if (failure instanceof DriveAuthError && failure.reason === 'denied') {
          return reply
            .code(400)
            .send(
              page(
                'Autorização cancelada',
                'Nada foi conectado. Quando quiser, mande /backup de novo.',
              ),
            );
        }
        return reply
          .code(502)
          .send(
            page(
              'Não deu certo',
              'O Google não confirmou a autorização. Tente de novo com /backup; o erro ficou no log do bot.',
            ),
          );
      }
      deps.onConnected();
      return reply.send(
        page(
          '✅ Google Drive conectado',
          'Pode fechar esta página. O bot vai avisar no chat quando o primeiro backup terminar.',
        ),
      );
    });
    done();
  });
}
