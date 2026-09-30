import { Bot, GrammyError, InlineKeyboard, InputFile, type Api, type Context } from 'grammy';
import type {
  ActionReply,
  MessageChannel,
  MessageHandler,
  OutgoingMessage,
} from '../message-channel.js';
import type { Logger } from '../../lib/logger.js';
import { downloadTelegramFile } from './download-file.js';
import { onlyAllowedUser } from './only-allowed-user.js';

/**
 * Áudios mais longos que isso são recusados antes do download: gastam muita cota da IA
 * e dificilmente são um lançamento. 2 minutos cobre com folga "almoço 32 e uber 18".
 */
const MAX_VOICE_SECONDS = 120;

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
  private readonly allowedUserId: number;

  constructor({ token, allowedUserId, handler, logger, onFatalError }: TelegramChannelOptions) {
    this.bot = new Bot(token);
    this.allowedUserId = allowedUserId;
    this.logger = logger;
    this.onFatalError = onFatalError;

    // O filtro vem antes de tudo: nenhum handler abaixo roda para outros usuários.
    this.bot.use(onlyAllowedUser(allowedUserId, logger));

    // Comandos vêm antes do handler de texto, senão "/ultimos" seria tratado como texto.
    this.bot.command('start', async (ctx) => {
      await sendReply(ctx, handler.handleStart());
    });
    this.bot.command('ultimos', async (ctx) => {
      await sendReply(ctx, await handler.handleLatest());
    });
    this.bot.command('desfazer', async (ctx) => {
      await sendReply(ctx, await handler.handleUndoLast());
    });
    this.bot.command('cartoes', async (ctx) => {
      await sendReply(ctx, await handler.handleAccounts());
    });
    this.bot.command('resumo', async (ctx) => {
      await sendReply(ctx, await handler.handleSummary());
    });
    this.bot.command('orcamento', async (ctx) => {
      await sendReply(ctx, await handler.handleBudgets());
    });
    this.bot.command('fixos', async (ctx) => {
      await sendReply(ctx, await handler.handleRecurring());
    });
    this.bot.command('lembretes', async (ctx) => {
      await sendReply(ctx, await handler.handleReminders());
    });
    this.bot.command('planilha', async (ctx) => {
      await sendReply(ctx, await handler.handleSpreadsheet());
    });
    this.bot.command('relatorio', async (ctx) => {
      await ctx.replyWithChatAction('upload_document');
      await sendReply(ctx, await handler.handleReport());
    });
    this.bot.command('grafico', async (ctx) => {
      await sendReply(ctx, await handler.handleCharts());
    });
    this.bot.command('pendentes', async (ctx) => {
      for (const message of await handler.handlePending()) {
        await sendReply(ctx, message);
      }
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

    // Mensagem de voz: baixa o .ogg e manda o áudio direto para a IA (sem serviço de transcrição).
    this.bot.on('message:voice', async (ctx) => {
      const { voice, date } = ctx.message;
      if (voice.duration > MAX_VOICE_SECONDS) {
        await ctx.reply(
          `Esse áudio é longo demais (máximo ${MAX_VOICE_SECONDS}s). Pode mandar em partes?`,
        );
        return;
      }

      await ctx.replyWithChatAction('typing');
      const file = await ctx.api.getFile(voice.file_id);
      if (!file.file_path) {
        throw new Error('Telegram não retornou file_path para o áudio');
      }
      const audio = await downloadTelegramFile(token, file.file_path);

      const reply = await handler.handleAudio({
        audio,
        // O Telegram grava voz em OGG/Opus; mime_type pode vir ausente em clientes antigos.
        mimeType: voice.mime_type ?? 'audio/ogg',
        receivedAt: new Date(date * 1000),
      });
      await sendReply(ctx, reply);
    });

    // Qualquer outro tipo de mensagem (foto, figurinha, arquivo...).
    this.bot.on('message', async (ctx) => {
      await ctx.reply('Por enquanto eu entendo só mensagens de texto e de voz.');
    });

    // Toque em um botão inline (ex.: "Desfazer").
    this.bot.on('callback_query:data', async (ctx) => {
      // Responde logo ao Telegram para o botão parar de mostrar "carregando".
      await ctx.answerCallbackQuery();
      const reply = await handler.handleAction(ctx.callbackQuery.data);
      await applyActionReply(ctx, reply);
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

    // Lista que aparece no menu "/" do Telegram.
    await this.bot.api.setMyCommands([
      { command: 'resumo', description: 'Resumo do mês: sobra, investido, saldos' },
      { command: 'ultimos', description: 'Seus 10 últimos lançamentos' },
      { command: 'orcamento', description: 'Limites por categoria' },
      { command: 'planilha', description: 'Link da sua planilha' },
      { command: 'grafico', description: 'Gráficos na planilha' },
      { command: 'fixos', description: 'Gastos fixos lançados todo mês' },
      { command: 'lembretes', description: 'Contas e faturas que vencem logo' },
      { command: 'relatorio', description: 'Relatório do mês em PDF' },
      { command: 'desfazer', description: 'Apaga o último lançamento' },
      { command: 'cartoes', description: 'Seus cartões, contas e saldos' },
      { command: 'pendentes', description: 'Lançamentos esperando resposta' },
      { command: 'start', description: 'Boas-vindas e exemplos' },
    ]);

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

  /** Mensagem por iniciativa do bot. Em chat privado, o id do chat é o id do usuário. */
  async notify(message: OutgoingMessage): Promise<void> {
    await send(this.bot.api, this.allowedUserId, message);
  }

  async stop(): Promise<void> {
    if (this.bot.isRunning()) {
      await this.bot.stop();
    }
  }
}

function keyboardFor(message: OutgoingMessage): InlineKeyboard | undefined {
  const rows = (message.actions ?? []).filter((row) => row.length > 0);
  if (rows.length === 0) return undefined;
  return InlineKeyboard.from(rows.map((row) => row.map((a) => InlineKeyboard.text(a.label, a.id))));
}

/** Limite da legenda de um arquivo no Telegram. */
const CAPTION_LIMIT = 1024;

/**
 * Envia uma mensagem: texto com botões ou, com anexo, o arquivo com o texto de legenda
 * (texto longo demais para legenda vai antes, numa mensagem separada).
 */
export async function send(api: Api, chatId: number, message: OutgoingMessage): Promise<void> {
  const keyboard = keyboardFor(message);
  const markup = keyboard ? { reply_markup: keyboard } : {};
  if (!message.document) {
    await api.sendMessage(chatId, message.text, markup);
    return;
  }
  const file = new InputFile(message.document.data, message.document.filename);
  if (message.text.length <= CAPTION_LIMIT) {
    await api.sendDocument(chatId, file, { caption: message.text, ...markup });
    return;
  }
  await api.sendMessage(chatId, message.text);
  await api.sendDocument(chatId, file, markup);
}

/** Envia a resposta; cada linha de ações vira uma linha de botões inline. */
async function sendReply(ctx: Context, message: OutgoingMessage): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) throw new Error('mensagem sem chat');
  if (message.document) await ctx.replyWithChatAction('upload_document');
  await send(ctx.api, chatId, message);
}

/**
 * Aplica a resposta de um toque na mensagem que tinha o botão.
 * - replace: troca texto e botões (perguntas de vários passos, menus);
 * - append: acrescenta o texto e remove os botões, para o mesmo botão não ser tocado de
 *   novo por engano (ex.: Desfazer).
 */
async function applyActionReply(ctx: Context, reply: ActionReply): Promise<void> {
  // Arquivo não cabe numa edição de mensagem: vai como mensagem nova.
  if (reply.document) {
    await sendReply(ctx, reply);
    return;
  }
  const original = ctx.callbackQuery?.message?.text;
  if (reply.mode === 'append' && !original) {
    await sendReply(ctx, reply);
    return;
  }
  const text = reply.mode === 'append' ? `${original ?? ''}\n\n${reply.text}` : reply.text;
  const keyboard = keyboardFor(reply);
  try {
    await ctx.editMessageText(text, keyboard ? { reply_markup: keyboard } : undefined);
  } catch (error) {
    // Tocar duas vezes no mesmo botão gera uma edição idêntica, que o Telegram recusa.
    if (error instanceof GrammyError && error.description.includes('message is not modified')) {
      return;
    }
    throw error;
  }
}
