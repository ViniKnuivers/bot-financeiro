import type { MiddlewareFn } from 'grammy';

interface Logger {
  warn(obj: object, msg: string): void;
}

/**
 * Deixa passar apenas updates do usuário autorizado, em chat privado.
 * Qualquer outra coisa é descartada sem resposta, para não revelar que o bot existe.
 *
 * O filtro de chat privado impede que, se o bot for adicionado a um grupo, mensagens
 * suas nesse grupo (e as respostas com seus gastos) fiquem visíveis para outras pessoas.
 */
export function onlyAllowedUser(allowedUserId: number, logger: Logger): MiddlewareFn {
  return async (ctx, next) => {
    const isAllowedUser = ctx.from?.id === allowedUserId;
    // Callback queries (cliques em botões inline) trazem o chat em ctx.chat também.
    const isPrivateChat = ctx.chat?.type === 'private';

    if (!isAllowedUser || !isPrivateChat) {
      logger.warn(
        { fromId: ctx.from?.id, chatType: ctx.chat?.type },
        'telegram: update ignorado (usuário ou chat não autorizado)',
      );
      return;
    }

    await next();
  };
}
