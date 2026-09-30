import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_ACTION_REFRESH_MS, keepAction } from './telegram-channel.js';

describe('keepAction', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renova o "digitando..." enquanto o trabalho não termina, e para depois', async () => {
    vi.useFakeTimers();
    const replyWithChatAction = vi.fn(() => Promise.resolve(true as const));
    let finish: (value: string) => void = () => undefined;
    const work = new Promise<string>((resolve) => {
      finish = resolve;
    });

    const result = keepAction({ replyWithChatAction }, 'typing', () => work);
    await vi.advanceTimersByTimeAsync(CHAT_ACTION_REFRESH_MS * 3 + 100);
    finish('pronto');

    expect(await result).toBe('pronto');
    expect(replyWithChatAction).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(CHAT_ACTION_REFRESH_MS * 3);
    expect(replyWithChatAction).toHaveBeenCalledTimes(4);
  });

  it('falha do indicador não atrapalha; erro do trabalho chega a quem chamou', async () => {
    const replyWithChatAction = vi.fn(() => Promise.reject(new Error('sem rede')));

    await expect(
      keepAction({ replyWithChatAction }, 'typing', () => Promise.resolve(1)),
    ).resolves.toBe(1);
    await expect(
      keepAction({ replyWithChatAction }, 'typing', () => Promise.reject(new Error('ia'))),
    ).rejects.toThrow('ia');
  });
});
