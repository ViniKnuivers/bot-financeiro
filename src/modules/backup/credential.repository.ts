import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Chaves que o bot recebe em uso (ex.: a autorização do Google Drive). Ficam numa tabela
 * própria, que o backup exporta sem os dados: o arquivo no Drive não carrega a chave.
 */
export interface CredentialRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class PrismaCredentialRepository implements CredentialRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async get(key: string): Promise<string | null> {
    return (await this.prisma.credential.findUnique({ where: { key } }))?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.prisma.credential.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  async delete(key: string): Promise<void> {
    await this.prisma.credential.deleteMany({ where: { key } });
  }
}
