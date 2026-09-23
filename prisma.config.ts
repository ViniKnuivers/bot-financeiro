import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// O Prisma 7 não carrega mais o .env sozinho. Usamos o loader nativo do Node
// (sem depender do pacote dotenv); em Docker as variáveis já vêm do ambiente.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Pode estar indefinida em `prisma generate` (ex.: build do Docker), que não conecta no banco.
    url: process.env.DATABASE_URL,
  },
});
