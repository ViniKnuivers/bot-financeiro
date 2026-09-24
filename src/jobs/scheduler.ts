import type { Logger } from '../lib/logger.js';

export interface Job {
  name: string;
  intervalMs: number;
  run(): Promise<void>;
}

/**
 * Roda tarefas periódicas dentro do próprio processo do bot. Simples de propósito: cada
 * tarefa é idempotente (guarda o que já fez no banco), então rodar de novo depois de um
 * reinício é seguro. Uma execução nunca começa enquanto a anterior da mesma tarefa roda.
 */
export class Scheduler {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();

  constructor(
    private readonly jobs: readonly Job[],
    private readonly logger: Logger,
  ) {}

  start(): void {
    for (const job of this.jobs) {
      void this.runOnce(job);
      this.timers.push(setInterval(() => void this.runOnce(job), job.intervalMs));
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  /** Executa agora (também usado pelos testes e por comandos manuais). */
  async runOnce(job: Job): Promise<void> {
    if (this.running.has(job.name)) return;
    this.running.add(job.name);
    try {
      await job.run();
    } catch (error) {
      this.logger.error({ err: error, job: job.name }, 'tarefa automática falhou');
    } finally {
      this.running.delete(job.name);
    }
  }
}
