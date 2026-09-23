import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy';
import type { MessageChannel, MessageHandler, OutgoingMessage } from '../message-channel.js';
import type { Logger } from '../../lib/logger.js';
import { onlyAllowedUser } from './only-allowed-user.js';

export interface TelegramChannelOptions {
  token: string;
  allowedUserId: number;
  handler: MessageHandler;
  logger: Logger;
  /** Chamado se o polling parar por um erro irrecuperável (ex.: token revogado). */
  onFatalError: (error: unknown) => void;
}

export class TelegramChannel implements MessageChannel {
  readonly name = 'telegram';
  private readonly bot: Bot;
  private readonly logger: Logger;
  private readonly onFatalError: (error: unknown) => void;

  constructor({ token, allowedUserId, handler, logger, onFatalError }: TelegramChannelOptions) {
    this.bot = new Bot(token);
    this.logger = logger;
    this.onFatalError = onFatalError;

    // O filtro vem antes de tudo: nenhum handler abaixo roda para outros usuários.
    this.bot.use(onlyAllowedUser(allowedUserId, logger));

    this.bot.command('start', async (ctx) => {
      await sendReply(ctx, handler.handleStart());
    });

    this.bot.on('message:text', async (ctx) => {
      const { text, date } = ctx.message;
      if (text.startsWith('/')) {
        await ctx.reply('Comando desconhecido. Use /start para ver o que eu sei fazer.');
        return;
      }
      // Indicador "digitando..." enquanto processa (a IA pode levar alguns segundos).
      await ctx.replyWithChatAction('typing');
      const reply = await handler.handleText({ text, receivedAt: new Date(date * 1000) });
      await sendReply(ctx, reply);
    });

    // Toque em um botão inline (ex.: "Desfazer").
    this.bot.on('callback_query:data', async (ctx) => {
      // Responde logo ao Telegram para o botão parar de mostrar "carregando".
      await ctx.answerCallbackQuery();
      const reply = await handler.handleAction(ctx.callbackQuery.data);

      // Edita a mensagem original: acrescenta o resultado e remove o botão,
      // para o mesmo lote não ser "desfeito" duas vezes por engano.
      const original = ctx.callbackQuery.message?.text;
      if (original) {
        await ctx.editMessageText(`${original}\n\n${reply.text}`);
      } else {
        await sendReply(ctx, reply);
      }
    });

    // Erros dentro dos handlers: loga e avisa o usuário, sem derrubar o bot.
    this.bot.catch(async (err) => {
      this.logger.error({ err: err.error, updateId: err.ctx.update.update_id }, 'telegram: erro');
      try {
        await err.ctx.reply('Ops, algo deu errado aqui. Tenta de novo em instantes.');
      } catch {
        // Se nem a resposta de erro sair (ex.: sem rede), o log acima já basta.
      }
    });
  }

  async start(): Promise<void> {
    // init() chama getMe: valida o token antes de começar, com um erro claro se for inválido.
    try {
      await this.bot.init();
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 401) {
        throw new Error('TELEGRAM_BOT_TOKEN inválido: o Telegram recusou o token.', {
          cause: error,
        });
      }
      throw error;
    }

    await this.bot.api.setMyCommands([{ command: 'start', description: 'Boas-vindas e exemplos' }]);

    // bot.start() só resolve quando o polling para; por isso não é aguardado aqui.
    // Erros de rede são re-tentados pelo grammY; só erros irrecuperáveis chegam no catch
    // (token revogado, ou 409 se outra instância do bot estiver rodando com o mesmo token).
    this.bot
      .start({
        onStart: (me) => {
          this.logger.info({ username: me.username }, 'telegram: bot ouvindo (long polling)');
        },
      })
      .catch((error: unknown) => {
        this.onFatalError(error);
      });
  }

  async stop(): Promise<void> {
    if (this.bot.isRunning()) {
      await this.bot.stop();
    }
  }
}

/** Envia a resposta; ações viram botões inline, cada um devolvendo seu `id` no clique. */
function sendReply(ctx: Context, message: OutgoingMessage) {
  const actions = message.actions ?? [];
  if (actions.length === 0) return ctx.reply(message.text);

  const keyboard = new InlineKeyboard();
  for (const action of actions) keyboard.text(action.label, action.id);
  return ctx.reply(message.text, { reply_markup: keyboard });
}
