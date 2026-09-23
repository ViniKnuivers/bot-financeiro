import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

  // Formato do BotFather: "<id numérico>:<segredo>".
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]+$/, 'formato esperado: 123456:ABC-xyz'),
  // IDs de usuário do Telegram cabem com folga em um number (até 52 bits).
  ALLOWED_TELEGRAM_USER_ID: z.coerce.number().int().positive(),

  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1).default('gemini-3.8-flash'),
  // Lista separada por vírgula, usada quando o modelo principal está sobrecarregado.
  GEMINI_FALLBACK_MODELS: z
    .string()
    .default('gemini-3.6-flash,gemini-3.5-flash-lite')
    .transform((value) =>
      value
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean),
    ),

  APP_TIMEZONE: z
    .string()
    .refine(isValidTimeZone, 'fuso horário IANA inválido')
    .default('America/Sao_Paulo'),
});

export type Env = z.infer<typeof envSchema>;

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
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Variáveis de ambiente inválidas:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
