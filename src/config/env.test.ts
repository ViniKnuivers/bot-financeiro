import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const validEnv = {
  DATABASE_URL: 'postgresql://financeiro:financeiro@localhost:5432/financeiro?schema=public',
  TELEGRAM_BOT_TOKEN: '123456789:AAH-abc_DEF',
  ALLOWED_TELEGRAM_USER_ID: '987654321',
  GEMINI_API_KEY: 'fake-key',
};

describe('loadEnv', () => {
  it('aplica os valores padrão e converte tipos', () => {
    const env = loadEnv(validEnv);

    expect(env.PORT).toBe(3000);
    expect(env.ALLOWED_TELEGRAM_USER_ID).toBe(987654321);
    expect(env.APP_TIMEZONE).toBe('America/Sao_Paulo');
    expect(env.GEMINI_MODEL).toBe('gemini-3.8-flash');
    expect(env.GEMINI_FALLBACK_MODELS).toEqual([
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
    ]);
  });

  it('aceita lista de modelos reserva com espaços e itens vazios', () => {
    const env = loadEnv({ ...validEnv, GEMINI_FALLBACK_MODELS: ' a , b,, ' });

    expect(env.GEMINI_FALLBACK_MODELS).toEqual(['a', 'b']);
  });

  it('lista as variáveis ausentes', () => {
    expect(() => loadEnv({})).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('rejeita URL de banco que não é PostgreSQL', () => {
    expect(() => loadEnv({ ...validEnv, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejeita fuso horário inexistente', () => {
    expect(() => loadEnv({ ...validEnv, APP_TIMEZONE: 'America/Atlantida' })).toThrow(
      /APP_TIMEZONE/,
    );
  });
});
