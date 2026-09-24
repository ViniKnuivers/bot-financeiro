import type { PrismaClient } from '../generated/prisma/client.js';

/** Memória das tarefas automáticas (ex.: "último mês com resumo enviado"). */
export interface JobStateRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export class PrismaJobStateRepository implements JobStateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async get(key: string): Promise<string | null> {
    return (await this.prisma.jobState.findUnique({ where: { key } }))?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.prisma.jobState.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
}
