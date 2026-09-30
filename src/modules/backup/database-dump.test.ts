import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pgDumpCommand, runDump } from './database-dump.js';

describe('pgDumpCommand', () => {
  it('tira a senha e os parâmetros do Prisma da URL; a senha vai por PGPASSWORD', () => {
    const { args, env } = pgDumpCommand(
      'postgresql://financeiro:s%40nha@db:5432/financeiro?schema=public',
    );

    expect(args[0]).toBe('--dbname');
    expect(args[1]).toBe('postgresql://financeiro@db:5432/financeiro');
    expect(env.PGPASSWORD).toBe('s@nha');
    expect(args).toEqual(
      expect.arrayContaining([
        '--clean',
        '--if-exists',
        '--no-owner',
        '--exclude-table-data=credentials',
      ]),
    );
  });
});

describe('runDump', () => {
  it('devolve a saída do comando compactada', async () => {
    const data = await runDump(
      process.execPath,
      ['-e', 'process.stdout.write("-- PostgreSQL database dump\\n")'],
      process.env,
    );

    expect(gunzipSync(data).toString()).toBe('-- PostgreSQL database dump\n');
  });

  it('falha com o código e o erro do comando', async () => {
    await expect(
      runDump(
        process.execPath,
        ['-e', 'process.stderr.write("senha errada"); process.exit(1)'],
        process.env,
      ),
    ).rejects.toThrow('falhou (código 1): senha errada');
  });

  it('sem o pg_dump instalado, diz o que falta', async () => {
    await expect(runDump('pg_dump_que_nao_existe', [], process.env)).rejects.toThrow(
      'não encontrado',
    );
  });
});
