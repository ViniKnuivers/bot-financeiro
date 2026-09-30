import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { DriveAuthError } from '../modules/backup/google-oauth.js';
import { OAUTH_CALLBACK_PATH, registerOAuthCallback } from './oauth-callback.js';

async function setup(connect: () => Promise<void>) {
  const app = Fastify();
  const onConnected = vi.fn();
  const connectSpy = vi.fn(connect);
  await registerOAuthCallback(app, {
    connect: connectSpy,
    onConnected,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { app, onConnected, connect: connectSpy };
}

describe('retorno da autorização do Google', () => {
  it('conecta, avisa o bot e mostra a página de sucesso', async () => {
    const { app, onConnected, connect } = await setup(() => Promise.resolve());

    const response = await app.inject(`${OAUTH_CALLBACK_PATH}?code=abc&state=xyz`);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Google Drive conectado');
    expect(connect).toHaveBeenCalledWith({ code: 'abc', state: 'xyz', error: undefined });
    expect(onConnected).toHaveBeenCalledOnce();
  });

  it('link vencido ou cancelado: página explicando, sem conectar', async () => {
    for (const [reason, text] of [
      ['state', 'Link vencido'],
      ['denied', 'Autorização cancelada'],
      ['failed', 'Não deu certo'],
    ] as const) {
      const { app, onConnected } = await setup(() =>
        Promise.reject(new DriveAuthError(reason, 'x')),
      );

      const response = await app.inject(`${OAUTH_CALLBACK_PATH}?state=s`);

      expect(response.body).toContain(text);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(onConnected).not.toHaveBeenCalled();
    }
  });

  it('recusa o que chega repassado de fora (ex.: pelo ngrok)', async () => {
    const { app, connect } = await setup(() => Promise.resolve());

    const response = await app.inject({
      url: `${OAUTH_CALLBACK_PATH}?code=abc&state=xyz`,
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });

    expect(response.statusCode).toBe(404);
    expect(connect).not.toHaveBeenCalled();
  });
});
