import { GoogleGenAI } from '@google/genai';
import type { FastifyServerOptions } from 'fastify';
import { GeminiTransactionParser } from './ai/gemini-transaction-parser.js';
import { Assistant } from './assistant/assistant.js';
import { BroadcastNotifier } from './channels/broadcast-notifier.js';
import type { MessageChannel } from './channels/message-channel.js';
import { TelegramChannel } from './channels/telegram/telegram-channel.js';
import { GraphWhatsAppApi } from './channels/whatsapp/whatsapp-api.js';
import { WhatsAppChannel } from './channels/whatsapp/whatsapp-channel.js';
import { WhatsAppUsage } from './channels/whatsapp/whatsapp-usage.js';
import { registerWhatsAppWebhook } from './channels/whatsapp/whatsapp-webhook.js';
import { WhatsAppWindow } from './channels/whatsapp/whatsapp-window.js';
import { loadEnv, type Env } from './config/env.js';
import { PrismaJobStateRepository } from './jobs/job-state.repository.js';
import { monthlyReportJob } from './jobs/monthly-report.job.js';
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
import {
  PrismaSheetSnapshotRepository,
  PrismaTrashRepository,
} from './modules/sheets/sheet-sync.repositories.js';
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
      for (const channel of channels) await channel.stop();
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
  const jobState = new PrismaJobStateRepository(prisma);

  // Planilha Google (opcional). As mensagens de falha vão para os chats, que são criados
  // mais abaixo: por isso o envio chama `notifier` só na hora de avisar.
  const sheets = createSheetSync({
    env,
    logger: app.log,
    deps: {
      transactions: transactionRepository,
      accounts,
      reports,
      budgets,
      jobState,
      transactionService: transactions,
      snapshots: new PrismaSheetSnapshotRepository(prisma),
      trash: new PrismaTrashRepository(prisma),
      notify: (message) => notifier.notify(message),
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

  // Canais ligados no .env (pelo menos um; os dois podem funcionar juntos).
  const channels: MessageChannel[] = [];
  if (env.telegram) {
    channels.push(
      new TelegramChannel({
        token: env.telegram.token,
        allowedUserId: env.telegram.allowedUserId,
        handler: assistant,
        logger: app.log,
        onFatalError: (error) => {
          app.log.fatal({ err: error }, 'telegram: polling interrompido');
          void shutdown('telegram-fatal', 1);
        },
      }),
    );
  }
  if (env.whatsapp) {
    const config = env.whatsapp;
    const whatsapp = new WhatsAppChannel({
      api: new GraphWhatsAppApi(config),
      handler: assistant,
      allowedNumber: config.allowedNumber,
      window: new WhatsAppWindow(jobState),
      usage: new WhatsAppUsage({
        jobState,
        freeMonthlyMessages: config.freeMonthlyMessages,
        warnAt: config.usageWarningAt,
        month: () => today().slice(0, 7),
        onNearLimit: (text) => notifier.notify({ text }),
        hasTelegram: env.telegram !== null,
        logger: app.log,
      }),
      noticeTemplate: { name: config.noticeTemplate, language: config.templateLanguage },
      logger: app.log,
    });
    await registerWhatsAppWebhook(app, {
      verifyToken: config.verifyToken,
      appSecret: config.appSecret,
      logger: app.log,
      onMessages: (messages) => {
        whatsapp.receive(messages);
      },
    });
    channels.push(whatsapp);
  }
  // Avisos do bot (dia 1, gastos fixos, planilha) vão para todos os canais ligados.
  const notifier = new BroadcastNotifier(channels, app.log);

  process.once('SIGINT', (signal) => void shutdown(signal, 0));
  process.once('SIGTERM', (signal) => void shutdown(signal, 0));

  // Tarefas automáticas. Só começam depois que o canal consegue enviar.
  const scheduler = new Scheduler(
    [
      recurringJob({
        recurring,
        assistant,
        notifier,
        today,
        onChange: () => sheets?.requestSync(),
      }),
      ...(sheets ? [sheetRefreshJob(sheets)] : []),
      monthlyReportJob({
        jobState,
        notifier,
        today,
        monthClosedMessage: (month) => assistant.monthClosedMessage(month),
      }),
    ],
    app.log,
  );

  await app.listen({ host: env.HOST, port: env.PORT });
  try {
    for (const channel of channels) await channel.start();
    app.log.info({ channels: channels.map((c) => c.name) }, 'canais ligados');
    scheduler.start();
  } catch (error) {
    app.log.fatal({ err: error }, 'canal: falha ao iniciar');
    await shutdown('channel-start-failed', 1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
