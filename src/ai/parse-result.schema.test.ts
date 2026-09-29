import { describe, expect, it } from 'vitest';
import { buildParseResultJsonSchema, validParseResultSchema } from './parse-result.schema.js';

const baseQuery = {
  kind: 'total',
  type: null,
  categories: ['TRANSPORTE'],
  text: 'uber',
  account: null,
  paymentMethod: null,
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  compareStart: null,
  compareEnd: null,
  rankBy: null,
  sort: null,
  limit: null,
  amountCents: null,
};

const response = (query: Record<string, unknown> | null, intent = 'query') => ({
  intent,
  transactions: [],
  query,
  transcript: null,
  reply: 'Deixa eu ver!',
});

describe('validParseResultSchema: perguntas', () => {
  it('aceita uma pergunta completa; respostas sem o campo query continuam válidas', () => {
    expect(validParseResultSchema.safeParse(response(baseQuery)).success).toBe(true);
    const { query: _, ...old } = response(null, 'other');
    expect(validParseResultSchema.parse(old).query).toBeNull();
  });

  it('recusa pergunta sem query, período invertido, compare sem 2º período e can_afford sem valor', () => {
    const invalid = [
      response(null),
      response({ ...baseQuery, periodStart: '2026-10-01' }),
      response({ ...baseQuery, kind: 'compare' }),
      response({ ...baseQuery, kind: 'can_afford' }),
    ];
    for (const candidate of invalid) {
      expect(validParseResultSchema.safeParse(candidate).success).toBe(false);
    }
  });
});

describe('buildParseResultJsonSchema', () => {
  it('a conta da pergunta também só aceita os cartões cadastrados', () => {
    const schema = buildParseResultJsonSchema(['Itaú', 'VR']) as {
      properties: { query: { anyOf: { properties?: { account?: unknown } }[] } };
    };
    const queryObject = schema.properties.query.anyOf.find((option) => option.properties);

    expect(queryObject?.properties?.account).toEqual({
      anyOf: [{ type: 'string', enum: ['Itaú', 'VR'] }, { type: 'null' }],
    });
  });
});
