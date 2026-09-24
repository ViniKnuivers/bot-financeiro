import { GoogleGenAI } from '@google/genai';
import type { FastifyServerOptions } from 'fastify';
import { GeminiTransactionParser } from './ai/gemini-transaction-parser.js';
import { Assistant } from './assistant/assistant.js';
import { TelegramChannel } from './channels/telegram/telegram-channel.js';
import { loadEnv, type Env } from './config/env.js';
import { buildServer } from './http/server.js';
import { createPrismaClient } from './lib/prisma.js';
import { PrismaAccountRepository } from './modules/accounts/account.repository.js';
import { PrismaInvoicePaymentRepository } from './modules/accounts/invoice-payment.repository.js';
import { AccountService } from './modules/accounts/account.service.js';
import { PrismaChatStateRepository } from './modules/conversation/chat-state.repository.js';
import { PrismaPendingRepository } from './modules/pending/pending.repository.js';
import { PrismaTransactionRepository } from './modules/transactions/transaction.repository.js';
import { TransactionService } from './modules/transactions/transaction.service.js';

// Composition root: único lugar que conhece as implementações concretas e
// conecta as peças. O resto do código depende só de interfaces e parâmetros.

function loggerOptions(env: Env): FastifyServerOptions['logger'] {
  if (env.NODE_ENV === 'development') {
    return { level: env.LOG_LEVEL, transport: { target: 'pino-pretty' } };
  }
  return { level: env.LOG_LEVEL };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrismaClient(env.DATABASE_URL);

  const app = buildServer({
    logger: loggerOptions(env),
    checkDatabase: async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
  });
  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  // Encerra na ordem inversa da dependência: para de receber mensagens,
  // depois fecha o HTTP e, por último (hook onClose), o banco.
  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ reason }, 'encerrando');
    try {
      await channel.stop();
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, 'erro ao encerrar');
      exitCode = 1;
    }
    process.exit(exitCode);
  };

  const transactionRepository = new PrismaTransactionRepository(prisma);
  const assistant = new Assistant({
    parser: new GeminiTransactionParser({
      models: new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }).models,
      model: env.GEMINI_MODEL,
      fallbackModels: env.GEMINI_FALLBACK_MODELS,
      timeZone: env.APP_TIMEZONE,
      logger: app.log,
    }),
    transactions: new TransactionService(transactionRepository),
    accounts: new AccountService(
      new PrismaAccountRepository(prisma),
      transactionRepository,
      new PrismaInvoicePaymentRepository(prisma),
    ),
    pending: new PrismaPendingRepository(prisma),
    chatState: new PrismaChatStateRepository(prisma),
    logger: app.log,
    timeZone: env.APP_TIMEZONE,
  });

  const channel = new TelegramChannel({
    token: env.TELEGRAM_BOT_TOKEN,
    allowedUserId: env.ALLOWED_TELEGRAM_USER_ID,
    handler: assistant,
    logger: app.log,
    onFatalError: (error) => {
      app.log.fatal({ err: error }, 'telegram: polling interrompido');
      void shutdown('telegram-fatal', 1);
    },
  });

  process.once('SIGINT', (signal) => void shutdown(signal, 0));
  process.once('SIGTERM', (signal) => void shutdown(signal, 0));

  await app.listen({ host: env.HOST, port: env.PORT });
  try {
    await channel.start();
  } catch (error) {
    app.log.fatal({ err: error }, 'telegram: falha ao iniciar');
    await shutdown('telegram-start-failed', 1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
