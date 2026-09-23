import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * No Prisma 7 o client não tem mais um engine em Rust: ele conversa com o banco
 * por um "driver adapter" (aqui, o driver `pg`), que precisa ser passado explicitamente.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}
