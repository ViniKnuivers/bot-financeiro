import { z } from 'zod';
import { parseSpreadsheetId } from '../modules/sheets/spreadsheet-gateway.js';

/** Variável vazia no .env ("CHAVE=") conta como ausente. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

  // Telegram (opcional, mas pelo menos um canal precisa estar configurado).
  // Formato do BotFather: "<id numérico>:<segredo>".
  TELEGRAM_BOT_TOKEN: optional(
    z.string().regex(/^\d+:[\w-]+$/, 'formato esperado: 123456:ABC-xyz'),
  ),
  // IDs de usuário do Telegram cabem com folga em um number (até 52 bits).
  ALLOWED_TELEGRAM_USER_ID: optional(z.coerce.number().int().positive()),

  // WhatsApp Cloud API (opcional; veja "WhatsApp" no README).
  // "false" pausa o canal sem apagar as chaves (ex.: enquanto não há número brasileiro).
  WHATSAPP_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  // trim: um espaço colado ao copiar ("CHAVE= valor") quebraria a assinatura e o login.
  WHATSAPP_ACCESS_TOKEN: optional(z.string().trim().min(1)),
  WHATSAPP_PHONE_NUMBER_ID: optional(z.string().trim().regex(/^\d+$/, 'só números')),
  WHATSAPP_APP_SECRET: optional(z.string().trim().min(1)),
  WHATSAPP_VERIFY_TOKEN: optional(z.string().trim().min(8)),
  // Seu número com DDI e DDD, só dígitos (ex.: 5511999998888).
  ALLOWED_WHATSAPP_NUMBER: optional(
    z
      .string()
      .trim()
      .regex(/^\d{10,15}$/, 'só dígitos, com DDI e DDD (ex.: 5511999998888)'),
  ),
  WHATSAPP_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v25.0'),
  // Modelo aprovado na Meta para avisar quando a janela de 24h está fechada.
  WHATSAPP_NOTICE_TEMPLATE: z.string().min(1).default('avisos_pendentes'),
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().min(2).default('pt_BR'),
  // Mensagens grátis por mês (regra da Meta desde 01/10/2026) e quando avisar.
  WHATSAPP_FREE_MONTHLY_MESSAGES: z.coerce.number().int().positive().default(1000),
  WHATSAPP_USAGE_WARNING_AT: z.coerce.number().int().positive().default(900),

  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1).default('gemini-3.8-flash'),
  // Lista separada por vírgula, tentada em ordem quando o modelo principal está
  // sobrecarregado ou sem cota. Na camada gratuita cada modelo tem cota diária própria
  // (~20 mensagens), então mais modelos = mais mensagens por dia.
  GEMINI_FALLBACK_MODELS: z
    .string()
    .default(
      'gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite',
    )
    .transform((value) =>
      value
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean),
    ),

  // Planilha Google (opcional). Aceita o ID ou o link inteiro da planilha.
  GOOGLE_SHEETS_ID: z
    .string()
    .optional()
    .transform((value) => (value?.trim() ? parseSpreadsheetId(value) : undefined)),
  GOOGLE_SERVICE_ACCOUNT_FILE: z.string().min(1).default('secrets/google-service-account.json'),

  // Backup diário no Google Drive (opcional; veja "Backup automático" no README).
  // Credencial OAuth do tipo "App para computador", do mesmo projeto da planilha.
  GOOGLE_OAUTH_CLIENT_ID: optional(z.string().trim().min(1)),
  GOOGLE_OAUTH_CLIENT_SECRET: optional(z.string().trim().min(1)),
  // Para onde o Google volta depois da autorização: o próprio bot, só neste computador.
  OAUTH_REDIRECT_BASE: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:3000'),
  BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(30),
  BACKUP_HOUR: z.coerce.number().int().min(0).max(23).default(3),

  APP_TIMEZONE: z
    .string()
    .refine(isValidTimeZone, 'fuso horário IANA inválido')
    .default('America/Sao_Paulo'),
});

const WHATSAPP_REQUIRED = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'ALLOWED_WHATSAPP_NUMBER',
] as const;

/**
 * Cada canal é tudo-ou-nada (evita um canal "meio configurado" que falha só na hora de
 * usar), e pelo menos um precisa existir. O resultado traz `telegram` e `whatsapp` já
 * prontos, ou null quando o canal está desligado.
 */
const configSchema = envSchema
  .superRefine((env, ctx) => {
    const telegram = [env.TELEGRAM_BOT_TOKEN, env.ALLOWED_TELEGRAM_USER_ID];
    const telegramCount = telegram.filter((v) => v !== undefined).length;
    if (telegramCount === 1) {
      ctx.addIssue({
        code: 'custom',
        path: [
          env.TELEGRAM_BOT_TOKEN === undefined ? 'TELEGRAM_BOT_TOKEN' : 'ALLOWED_TELEGRAM_USER_ID',
        ],
        message: 'o Telegram precisa do token e do seu user ID juntos',
      });
    }
    const missing = WHATSAPP_REQUIRED.filter((key) => env[key] === undefined);
    // Só o verify token (que pode ser gerado de antemão) não conta como tentar ligar.
    const attempted = WHATSAPP_REQUIRED.some(
      (key) => key !== 'WHATSAPP_VERIFY_TOKEN' && env[key] !== undefined,
    );
    if (env.WHATSAPP_ENABLED && attempted && missing.length > 0) {
      for (const key of missing) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'faltando para ligar o WhatsApp' });
      }
    }
    if (telegramCount < 2 && (missing.length > 0 || !env.WHATSAPP_ENABLED)) {
      ctx.addIssue({
        code: 'custom',
        path: ['TELEGRAM_BOT_TOKEN'],
        message:
          'configure pelo menos um canal: Telegram (TELEGRAM_BOT_TOKEN e ALLOWED_TELEGRAM_USER_ID) ou WhatsApp',
      });
    }
    if (
      (env.GOOGLE_OAUTH_CLIENT_ID === undefined) !==
      (env.GOOGLE_OAUTH_CLIENT_SECRET === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: [
          env.GOOGLE_OAUTH_CLIENT_ID === undefined
            ? 'GOOGLE_OAUTH_CLIENT_ID'
            : 'GOOGLE_OAUTH_CLIENT_SECRET',
        ],
        message:
          'o backup no Google Drive precisa do ID e da chave secreta do cliente OAuth juntos',
      });
    }
    if (env.WHATSAPP_USAGE_WARNING_AT > env.WHATSAPP_FREE_MONTHLY_MESSAGES) {
      ctx.addIssue({
        code: 'custom',
        path: ['WHATSAPP_USAGE_WARNING_AT'],
        message: 'o aviso precisa vir antes do limite grátis',
      });
    }
  })
  .transform((env) => ({
    ...env,
    telegram:
      env.TELEGRAM_BOT_TOKEN !== undefined && env.ALLOWED_TELEGRAM_USER_ID !== undefined
        ? { token: env.TELEGRAM_BOT_TOKEN, allowedUserId: env.ALLOWED_TELEGRAM_USER_ID }
        : null,
    whatsapp:
      env.WHATSAPP_ENABLED &&
      env.WHATSAPP_ACCESS_TOKEN !== undefined &&
      env.WHATSAPP_PHONE_NUMBER_ID !== undefined &&
      env.WHATSAPP_APP_SECRET !== undefined &&
      env.WHATSAPP_VERIFY_TOKEN !== undefined &&
      env.ALLOWED_WHATSAPP_NUMBER !== undefined
        ? {
            accessToken: env.WHATSAPP_ACCESS_TOKEN,
            phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
            appSecret: env.WHATSAPP_APP_SECRET,
            verifyToken: env.WHATSAPP_VERIFY_TOKEN,
            allowedNumber: env.ALLOWED_WHATSAPP_NUMBER,
            graphVersion: env.WHATSAPP_GRAPH_VERSION,
            noticeTemplate: env.WHATSAPP_NOTICE_TEMPLATE,
            templateLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE,
            freeMonthlyMessages: env.WHATSAPP_FREE_MONTHLY_MESSAGES,
            usageWarningAt: env.WHATSAPP_USAGE_WARNING_AT,
          }
        : null,
    backup:
      env.GOOGLE_OAUTH_CLIENT_ID !== undefined && env.GOOGLE_OAUTH_CLIENT_SECRET !== undefined
        ? {
            clientId: env.GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
            redirectUri: `${env.OAUTH_REDIRECT_BASE.replace(/\/+$/, '')}/oauth/google/callback`,
            keep: env.BACKUP_KEEP,
            hour: env.BACKUP_HOUR,
          }
        : null,
  }));

export type Env = z.infer<typeof configSchema>;
export type WhatsAppConfig = NonNullable<Env['whatsapp']>;
export type BackupConfig = NonNullable<Env['backup']>;

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Valida as variáveis de ambiente uma única vez, na inicialização.
 * Falha cedo, com uma mensagem legível, em vez de quebrar no meio de uma requisição.
 * Recebe o `source` por parâmetro para ser testável sem mexer em `process.env`.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = configSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Variáveis de ambiente inválidas:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
