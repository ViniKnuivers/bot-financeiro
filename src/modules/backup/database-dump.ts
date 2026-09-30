import { spawn } from 'node:child_process';
import { buffer } from 'node:stream/consumers';
import { createGzip } from 'node:zlib';

/** Tabela das chaves (autorização do Drive): vai só a estrutura, sem os dados. */
export const CREDENTIALS_TABLE = 'credentials';

/**
 * Argumentos do pg_dump. A senha sai da URL e vai por variável de ambiente (não aparece
 * na lista de processos), e os parâmetros do Prisma (?schema=...) são removidos, porque
 * o pg_dump não os aceita.
 */
export function pgDumpCommand(databaseUrl: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const url = new URL(databaseUrl);
  const password = decodeURIComponent(url.password);
  url.password = '';
  url.search = '';
  return {
    args: [
      '--dbname',
      url.toString(),
      // Restaurável em qualquer banco: apaga e recria o que existir, sem donos/permissões.
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      `--exclude-table-data=${CREDENTIALS_TABLE}`,
    ],
    env: { ...process.env, PGPASSWORD: password },
  };
}

/** Roda um comando de dump e devolve a saída compactada (gzip). */
export async function runDump(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Buffer> {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(`${command} não encontrado (instale o cliente do PostgreSQL 18)`)
          : error,
      );
    });
    child.once('close', resolve);
  });
  const [code, data] = await Promise.all([exit, buffer(child.stdout.pipe(createGzip()))]);
  if (code !== 0) {
    throw new Error(`${command} falhou (código ${String(code)}): ${stderr.trim().slice(0, 300)}`);
  }
  return data;
}

/** Cópia completa do banco (SQL compactado), pronta para restaurar com psql. */
export function dumpDatabase(databaseUrl: string): Promise<Buffer> {
  const { args, env } = pgDumpCommand(databaseUrl);
  return runDump('pg_dump', args, env);
}
