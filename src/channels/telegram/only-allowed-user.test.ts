import type { Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { onlyAllowedUser } from './only-allowed-user.js';

const ALLOWED_ID = 42;

function fakeContext(fromId: number | undefined, chatType: string | undefined): Context {
  return {
    from: fromId === undefined ? undefined : { id: fromId },
    chat: chatType === undefined ? undefined : { type: chatType },
  } as unknown as Context;
}

async function run(ctx: Context) {
  const logger = { warn: vi.fn() };
  const next = vi.fn(() => Promise.resolve());
  await onlyAllowedUser(ALLOWED_ID, logger)(ctx, next);
  return { next, logger };
}

describe('onlyAllowedUser', () => {
  it('deixa passar o usuário autorizado em chat privado', async () => {
    const { next, logger } = await run(fakeContext(ALLOWED_ID, 'private'));

    expect(next).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('ignora outros usuários', async () => {
    const { next, logger } = await run(fakeContext(999, 'private'));

    expect(next).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('ignora o usuário autorizado fora de chat privado', async () => {
    const { next } = await run(fakeContext(ALLOWED_ID, 'group'));

    expect(next).not.toHaveBeenCalled();
  });

  it('ignora updates sem remetente (ex.: posts de canal)', async () => {
    const { next } = await run(fakeContext(undefined, 'channel'));

    expect(next).not.toHaveBeenCalled();
  });
});
