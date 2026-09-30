import { describe, expect, it } from 'vitest';
import { redactSecrets } from './logger.js';

describe('redactSecrets', () => {
  it('esconde o token do Telegram, códigos de autorização e tokens do Google', () => {
    const line = JSON.stringify({
      err: {
        message:
          'request to https://api.telegram.org/bot123456789:AAH-tokenFalsoParaTeste_0123456789/sendMessage failed',
      },
      req: { url: '/oauth/google/callback?state=abc-123&iss=x&code=4/0AXlqoi5ls&scope=drive' },
      headers: { authorization: 'Bearer ya29.a0AfB_byC-tok.en' },
    });

    const safe = redactSecrets(line);

    expect(safe).not.toContain('tokenFalso');
    expect(safe).toContain('api.telegram.org/bot<oculto>/sendMessage');
    expect(safe).toContain('?state=<oculto>&iss=x&code=<oculto>&scope=drive');
    expect(safe).not.toContain('a0AfB_byC');
  });

  it('não mexe em linhas comuns', () => {
    const line =
      '{"msg":"backup: enviado ao Google Drive","name":"financeiro-2026-09-30-0300.sql.gz"}';

    expect(redactSecrets(line)).toBe(line);
  });
});
