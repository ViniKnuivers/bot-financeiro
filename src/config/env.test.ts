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
    expect(env.telegram).toEqual({ token: '123456789:AAH-abc_DEF', allowedUserId: 987654321 });
    expect(env.whatsapp).toBeNull();
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
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
    const { TELEGRAM_BOT_TOKEN: _, ALLOWED_TELEGRAM_USER_ID: __, ...noChannel } = validEnv;
    expect(() => loadEnv(noChannel)).toThrow(/pelo menos um canal/);
  });

  const whatsapp = {
    WHATSAPP_ACCESS_TOKEN: 'EAAG-fake',
    WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    WHATSAPP_APP_SECRET: 'segredo',
    WHATSAPP_VERIFY_TOKEN: 'verificacao-123',
    ALLOWED_WHATSAPP_NUMBER: '5511999998888',
  };

  it('só WhatsApp: Telegram desligado, WhatsApp com os padrões', () => {
    const env = loadEnv({
      ...validEnv,
      TELEGRAM_BOT_TOKEN: '',
      ALLOWED_TELEGRAM_USER_ID: '',
      ...whatsapp,
    });

    expect(env.telegram).toBeNull();
    expect(env.whatsapp).toMatchObject({
      phoneNumberId: '1234567890',
      allowedNumber: '5511999998888',
      graphVersion: 'v25.0',
      noticeTemplate: 'avisos_pendentes',
      freeMonthlyMessages: 1000,
      usageWarningAt: 900,
    });
  });

  it('WhatsApp pela metade: aponta o que falta', () => {
    const { WHATSAPP_APP_SECRET: _, ...partial } = whatsapp;
    expect(() => loadEnv({ ...validEnv, ...partial })).toThrow(/WHATSAPP_APP_SECRET/);
  });

  it('só o verify token preenchido (gerado de antemão) não liga nem quebra nada', () => {
    const env = loadEnv({ ...validEnv, WHATSAPP_VERIFY_TOKEN: 'gerado-antes-123' });
    expect(env.whatsapp).toBeNull();
  });

  it('Telegram pela metade também é erro', () => {
    expect(() => loadEnv({ ...validEnv, ALLOWED_TELEGRAM_USER_ID: '', ...whatsapp })).toThrow(
      /ALLOWED_TELEGRAM_USER_ID/,
    );
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
