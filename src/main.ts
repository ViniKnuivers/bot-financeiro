import { GoogleGenAI } from '@google/genai';
import type { FastifyServerOptions } from 'fastify';
import { GeminiTransactionParser } from './ai/gemini-transaction-parser.js';
import { Assistant } from './assistant/assistant.js';
import { TelegramChannel } from './channels/telegram/telegram-channel.js';
import { loadEnv, type Env } from './config/env.js';
import { PrismaJobStateRepository } from './jobs/job-state.repository.js';
import { recurringJob } from './jobs/recurring.job.js';
import { sheetRefreshJob } from './jobs/sheet-refresh.job.js';
import { Scheduler } from './jobs/scheduler.js';
import { toDateOnlyString } from './lib/dates.js';
import { buildServer } from './http/server.js';
import { createPrismaClient } from './lib/prisma.js';
import { PrismaAccountRepository } from './modules/accounts/account.repository.js';
import { PrismaInvoicePaymentRepository } from './modules/accounts/invoice-payment.repository.js';
import { AccountService } from './modules/accounts/account.service.js';
import { PrismaBudgetRepository } from './modules/budgets/budget.repository.js';
import { BudgetService } from './modules/budgets/budget.service.js';
import { PrismaChatStateRepository } from './modules/conversation/chat-state.repository.js';
import { PrismaPendingRepository } from './modules/pending/pending.repository.js';
import { PrismaRecurringRepository } from './modules/recurring/recurring.repository.js';
import { RecurringService } from './modules/recurring/recurring.service.js';
import { ReportService } from './modules/reports/report.service.js';
import { createSheetSync } from './modules/sheets/create-sheet-sync.js';
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
      scheduler.stop();
      sheets?.stop();
      await channel.stop();
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, 'erro ao encerrar');
      exitCode = 1;
    }
    process.exit(exitCode);
  };

  const transactionRepository = new PrismaTransactionRepository(prisma);
  const transactions = new TransactionService(transactionRepository);
  const accounts = new AccountService(
    new PrismaAccountRepository(prisma),
    transactionRepository,
    new PrismaInvoicePaymentRepository(prisma),
  );
  const recurring = new RecurringService(new PrismaRecurringRepository(prisma), transactions);
  const today = () => toDateOnlyString(new Date(), env.APP_TIMEZONE);
  const reports = new ReportService(transactionRepository, accounts);
  const budgets = new BudgetService(new PrismaBudgetRepository(prisma));

  // Planilha Google (opcional). As mensagens de falha vão para o chat, que é criado
  // mais abaixo: por isso o envio chama `channel` só na hora de avisar.
  const sheets = createSheetSync({
    env,
    logger: app.log,
    deps: {
      transactions: transactionRepository,
      accounts,
      reports,
      budgets,
      jobState: new PrismaJobStateRepository(prisma),
      notify: (message) => channel.notify(message),
      logger: app.log,
      today,
      timeZone: env.APP_TIMEZONE,
    },
  });

  const assistant = new Assistant({
    parser: new GeminiTransactionParser({
      models: new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }).models,
      model: env.GEMINI_MODEL,
      fallbackModels: env.GEMINI_FALLBACK_MODELS,
      timeZone: env.APP_TIMEZONE,
      logger: app.log,
    }),
    transactions,
    accounts,
    pending: new PrismaPendingRepository(prisma),
    chatState: new PrismaChatStateRepository(prisma),
    recurring,
    reports,
    budgets,
    logger: app.log,
    timeZone: env.APP_TIMEZONE,
    ...(sheets ? { sheets } : {}),
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

  // Tarefas automáticas. Só começam depois que o canal consegue enviar.
  const scheduler = new Scheduler(
    [
      recurringJob({
        recurring,
        assistant,
        notifier: channel,
        today,
        onChange: () => sheets?.requestSync(),
      }),
      ...(sheets ? [sheetRefreshJob(sheets)] : []),
    ],
    app.log,
  );

  await app.listen({ host: env.HOST, port: env.PORT });
  try {
    await channel.start();
    scheduler.start();
  } catch (error) {
    app.log.fatal({ err: error }, 'telegram: falha ao iniciar');
    await shutdown('telegram-start-failed', 1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
