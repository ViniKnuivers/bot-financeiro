import { describe, expect, it } from 'vitest';
import { InMemoryTransactionRepository } from '../../test/in-memory-transaction-repository.js';
import { TransactionService, type ResolvedDraft } from './transaction.service.js';

function draft(overrides: Partial<ResolvedDraft> = {}): ResolvedDraft {
  return {
    type: 'EXPENSE',
    amountCents: 3200,
    description: 'Almoço',
    category: 'ALIMENTACAO',
    paymentMethod: 'PIX',
    accountId: null,
    installments: 1,
    occurredAt: '2026-09-23',
    ...overrides,
  };
}

function setup() {
  const repository = new InMemoryTransactionRepository();
  let batchSequence = 0;
  const service = new TransactionService(repository, () => `batch-${++batchSequence}`);
  return { repository, service };
}

describe('TransactionService', () => {
  describe('register', () => {
    it('salva todas as transações da mensagem no mesmo lote', async () => {
      const { service, repository } = setup();

      const batch = await service.register({
        drafts: [draft(), draft({ amountCents: 1850, description: 'Uber' })],
        rawInput: 'almoço 32 e uber 18,50',
        source: 'TEXT',
      });

      expect(batch.batchId).toBe('batch-1');
      expect(repository.rows).toHaveLength(2);
      expect(repository.rows.every((row) => row.batchId === 'batch-1')).toBe(true);
    });

    it('guarda o texto original e a origem em cada transação, para auditoria', async () => {
      const { service, repository } = setup();

      await service.register({
        drafts: [draft(), draft({ description: 'Uber' })],
        rawInput: 'ontem almocei 32 e peguei um uber',
        source: 'AUDIO',
      });

      for (const row of repository.rows) {
        expect(row.rawInput).toBe('ontem almocei 32 e peguei um uber');
        expect(row.source).toBe('AUDIO');
      }
    });

    it('converte a data YYYY-MM-DD para meia-noite UTC, sem trocar o dia', async () => {
      const { service, repository } = setup();

      await service.register({
        drafts: [draft({ occurredAt: '2026-09-01' })],
        rawInput: 'x',
        source: 'TEXT',
      });

      expect(repository.rows[0]?.occurredAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    it('guarda a conta e o número de parcelas', async () => {
      const { service, repository } = setup();

      await service.register({
        drafts: [draft({ paymentMethod: 'CREDITO', accountId: 7, installments: 3 })],
        rawInput: 'tênis 300 em 3x',
        source: 'TEXT',
      });

      expect(repository.rows[0]).toMatchObject({ accountId: 7, installments: 3 });
    });

    it('mantém o valor em centavos inteiros', async () => {
      const { service, repository } = setup();

      await service.register({
        drafts: [draft({ amountCents: 1999 })],
        rawInput: 'x',
        source: 'TEXT',
      });

      expect(repository.rows[0]?.amountCents).toBe(1999);
    });

    it('recusa lote vazio sem tocar no repositório', async () => {
      const { service, repository } = setup();

      await expect(
        service.register({ drafts: [], rawInput: 'x', source: 'TEXT' }),
      ).rejects.toThrow();
      expect(repository.rows).toHaveLength(0);
    });
  });

  describe('undoBatch', () => {
    it('apaga só as transações daquele lote', async () => {
      const { service, repository } = setup();
      const first = await service.register({
        drafts: [draft(), draft()],
        rawInput: 'a',
        source: 'TEXT',
      });
      await service.register({ drafts: [draft()], rawInput: 'b', source: 'TEXT' });

      const count = await service.undoBatch(first.batchId);

      expect(count).toBe(2);
      expect(repository.rows.map((row) => row.rawInput)).toEqual(['b']);
    });

    it('retorna 0 se o lote já foi desfeito', async () => {
      const { service } = setup();
      const batch = await service.register({ drafts: [draft()], rawInput: 'a', source: 'TEXT' });
      await service.undoBatch(batch.batchId);

      expect(await service.undoBatch(batch.batchId)).toBe(0);
    });
  });

  describe('listLatest', () => {
    it('lista no máximo 10, mais recentes primeiro', async () => {
      const { service } = setup();
      for (let i = 1; i <= 12; i++) {
        await service.register({
          drafts: [draft({ description: `Gasto ${i}` })],
          rawInput: `gasto ${i}`,
          source: 'TEXT',
        });
      }

      const latest = await service.listLatest();

      expect(latest).toHaveLength(10);
      expect(latest[0]?.description).toBe('Gasto 12');
      expect(latest[9]?.description).toBe('Gasto 3');
    });
  });

  describe('undoLast', () => {
    it('apaga só a última transação, mesmo que ela faça parte de um lote', async () => {
      const { service, repository } = setup();
      await service.register({
        drafts: [draft({ description: 'Almoço' }), draft({ description: 'Uber' })],
        rawInput: 'almoço e uber',
        source: 'TEXT',
      });

      const deleted = await service.undoLast();

      expect(deleted?.description).toBe('Uber');
      expect(repository.rows.map((row) => row.description)).toEqual(['Almoço']);
    });

    it('retorna null quando não há nada para desfazer', async () => {
      const { service } = setup();

      expect(await service.undoLast()).toBeNull();
    });
  });
});
