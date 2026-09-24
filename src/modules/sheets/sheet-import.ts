import { z } from 'zod';
import type { ActionReply, OutgoingMessage, ReplyAction } from '../../channels/message-channel.js';
import type { JobStateRepository } from '../../jobs/job-state.repository.js';
import { parseDateOnly } from '../../lib/dates.js';
import { formatCents } from '../../lib/money.js';
import { TYPE_LABELS } from '../transactions/transaction.labels.js';
import type { Transaction, TransactionRepository } from '../transactions/transaction.repository.js';
import type { TransactionService } from '../transactions/transaction.service.js';
import type { Cell } from './sheet-content.js';
import type { SheetChange } from './sheet-diff.js';
import type { SheetRowFields } from './sheet-row.js';
import type { TrashRepository } from './sheet-sync.repositories.js';

const MASS_DELETE_KEY = 'sheets.pendingMassDelete';
const TRASH_PREFIX = 'tr:';
const MASS_DELETE_YES = 'sd:yes';
const MASS_DELETE_NO = 'sd:no';
const COLUMNS = 11;

export interface ImportResult {
  /** Algo mudou no banco (a planilha precisa ser reescrita). */
  changed: boolean;
  /** Coluna Status de lançamentos cuja edição foi recusada. */
  statuses: Map<string, string>;
  /** Linhas novas com erro, mantidas na planilha para correção. */
  pendingRows: Cell[][];
  messages: OutgoingMessage[];
}

export interface SheetImporterDeps {
  transactions: Pick<TransactionRepository, 'update' | 'deleteById' | 'restore' | 'listAll'>;
  service: Pick<TransactionService, 'register'>;
  trash: TrashRepository;
  jobState: JobStateRepository;
}

const idsSchema = z.array(z.string());

/** Aplica no banco o que foi mudado na planilha, e explica no chat o que fez. */
export class SheetImporter {
  /** Erros já avisados, para não repetir o mesmo aviso a cada minuto. */
  private readonly warned = new Set<string>();

  constructor(private readonly deps: SheetImporterDeps) {}

  async apply(changes: readonly SheetChange[]): Promise<ImportResult> {
    const result: ImportResult = {
      changed: false,
      statuses: new Map(),
      pendingRows: [],
      messages: [],
    };
    const updated: string[] = [];
    const created: string[] = [];
    const deleted: { label: string; trashId: number }[] = [];
    const warnings: string[] = [];

    for (const change of changes) {
      switch (change.kind) {
        case 'update':
          // Descreve antes de aplicar: depois, o "antes" já não existe.
          updated.push(describeChange(change.transaction, change.fields));
          await this.deps.transactions.update(change.transaction.id, toPatch(change.fields));
          result.changed = true;
          break;
        case 'create':
          await this.deps.service.register({
            drafts: [{ ...change.fields }],
            rawInput: `Planilha: ${change.fields.description}`,
            source: 'SHEET',
          });
          created.push(describe(change.fields));
          result.changed = true;
          break;
        case 'delete':
          deleted.push({
            label: describe(change.transaction),
            trashId: await this.moveToTrash(change.transaction),
          });
          result.changed = true;
          break;
        case 'conflict':
          warnings.push(
            `⚠️ "${change.transaction.description}" mudou no bot e na planilha ao mesmo tempo; mantive a versão do bot.`,
          );
          result.changed = true;
          break;
        case 'invalid': {
          const status = `⚠️ ${change.error}${change.transaction ? ' (edição desfeita)' : ''}`;
          if (change.transaction) {
            result.statuses.set(change.transaction.id, status);
            result.changed = true;
          } else {
            const cells = [...change.row.cells.slice(0, COLUMNS)] as Cell[];
            while (cells.length < COLUMNS) cells.push('');
            cells[COLUMNS - 1] = status;
            result.pendingRows.push(cells);
          }
          const key = `${change.transaction?.id ?? `linha:${JSON.stringify(change.row.cells.slice(1, 9))}`}:${change.error}`;
          if (!this.warned.has(key)) {
            this.warned.add(key);
            warnings.push(
              change.transaction
                ? `⚠️ Não apliquei a edição de "${change.transaction.description}" na planilha: ${change.error}`
                : `⚠️ A linha nova ${change.row.rowNumber} da planilha tem um erro: ${change.error} Corrija lá que eu registro.`,
            );
          }
          break;
        }
        case 'mass_delete': {
          const message = await this.askMassDelete(change.transactions);
          if (message) result.messages.push(message);
          result.changed = true;
          break;
        }
      }
    }

    if (updated.length > 0)
      result.messages.push({ text: `✏️ Atualizei pela planilha:\n${updated.join('\n')}` });
    if (created.length > 0)
      result.messages.push({ text: `➕ Registrei pela planilha:\n${created.join('\n')}` });
    if (deleted.length > 0) {
      result.messages.push({
        text: `🗑️ Apaguei porque as linhas foram removidas da planilha:\n${deleted.map((d) => d.label).join('\n')}`,
        actions: deleted.map((d): ReplyAction[] => [
          { label: `↩️ Desfazer: ${d.label}`.slice(0, 60), id: `${TRASH_PREFIX}${d.trashId}` },
        ]),
      });
    }
    if (warnings.length > 0) result.messages.push({ text: warnings.join('\n\n') });
    return result;
  }

  /** Botões de "Desfazer" (lixeira) e da confirmação de exclusão em massa. */
  async handleAction(actionId: string): Promise<ActionReply | null> {
    if (actionId.startsWith(TRASH_PREFIX)) {
      const id = Number(actionId.slice(TRASH_PREFIX.length));
      const transaction = Number.isInteger(id) ? await this.deps.trash.take(id) : null;
      if (!transaction) return { mode: 'append', text: 'Esse lançamento já foi restaurado.' };
      await this.deps.transactions.restore(transaction);
      return { mode: 'append', text: `↩️ Restaurei: ${describe(transaction)}` };
    }
    if (actionId === MASS_DELETE_YES || actionId === MASS_DELETE_NO) {
      const stored = await this.deps.jobState.get(MASS_DELETE_KEY);
      await this.deps.jobState.set(MASS_DELETE_KEY, '[]');
      const ids = idsSchema.safeParse(JSON.parse(stored ?? '[]'));
      if (actionId === MASS_DELETE_NO || !ids.success || ids.data.length === 0) {
        return {
          mode: 'replace',
          text: '👍 Mantive tudo no bot, e as linhas voltaram para a planilha.',
        };
      }
      const wanted = new Set(ids.data);
      const all = (await this.deps.transactions.listAll()).filter((t) => wanted.has(t.id));
      for (const transaction of all) await this.moveToTrash(transaction);
      return {
        mode: 'replace',
        text: `🗑️ Apaguei ${all.length} lançamentos no bot. Eles ficaram na lixeira do banco, caso precise recuperar.`,
      };
    }
    return null;
  }

  private async moveToTrash(transaction: Transaction): Promise<number> {
    const trashId = await this.deps.trash.put(transaction);
    await this.deps.transactions.deleteById(transaction.id);
    return trashId;
  }

  /**
   * Muitas linhas sumiram de uma vez: não apaga nada (a próxima escrita as devolve para a
   * planilha) e pergunta, uma vez, se era para apagar no bot também.
   */
  private async askMassDelete(
    transactions: readonly Transaction[],
  ): Promise<OutgoingMessage | null> {
    const ids = JSON.stringify(transactions.map((t) => t.id).sort());
    if ((await this.deps.jobState.get(MASS_DELETE_KEY)) === ids) return null;
    await this.deps.jobState.set(MASS_DELETE_KEY, ids);
    return {
      text: `⚠️ ${transactions.length} linhas sumiram da planilha de uma vez. Por segurança, não apaguei nada no bot e vou devolvê-las à planilha. Se foi de propósito, confirme:`,
      actions: [
        [
          { label: `🗑️ Apagar os ${transactions.length} no bot`, id: MASS_DELETE_YES },
          { label: 'Manter', id: MASS_DELETE_NO },
        ],
      ],
    };
  }
}

function toPatch(fields: SheetRowFields) {
  return { ...fields, occurredAt: parseDateOnly(fields.occurredAt) };
}

/** "Despesa · Almoço · R$ 32,00" */
function describe(t: {
  type: Transaction['type'];
  description: string;
  amountCents: number;
}): string {
  return `${TYPE_LABELS[t.type]} · ${t.description} · ${formatCents(t.amountCents)}`;
}

/** "Almoço: R$ 32,00 → R$ 35,00" (ou só a descrição, se o valor não mudou). */
function describeChange(before: Transaction, after: SheetRowFields): string {
  return before.amountCents === after.amountCents
    ? `${after.description}: ${formatCents(after.amountCents)}`
    : `${after.description}: ${formatCents(before.amountCents)} → ${formatCents(after.amountCents)}`;
}
