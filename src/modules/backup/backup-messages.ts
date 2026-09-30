import { localTime, toDateOnlyString } from '../../lib/dates.js';
import type { BackupFailure, BackupResult, BackupStatus } from './backup.service.js';
import { FOLDER_NAME } from './google-drive.js';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

function formatWhen(iso: string, timeZone: string): string {
  const instant = new Date(iso);
  const [year, month, day] = toDateOnlyString(instant, timeZone).split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''} ${localTime(instant, timeZone)}`;
}

/** O que o /backup mostra: situação e, sem conexão, o link para autorizar. */
export function formatBackupStatus(
  status: BackupStatus,
  options: { authorizationUrl: string | null; timeZone: string },
): string {
  if (!status.connected) {
    const revoked = status.lastFailure?.reason === 'revoked';
    return [
      '☁️ Backup no Google Drive: ainda não conectado.',
      ...(revoked ? ['A autorização anterior foi removida ou venceu.'] : []),
      '',
      'Abra o link abaixo no computador onde o bot roda (no fim, o Google volta para ele) e autorize com a sua conta:',
      options.authorizationUrl ?? '',
      '',
      'O link vale 10 minutos. Se passar disso, mande /backup de novo.',
    ].join('\n');
  }
  const lines = ['☁️ Backup no Google Drive: conectado ✅'];
  lines.push(
    status.lastSuccess
      ? `Último: ${formatWhen(status.lastSuccess.at, options.timeZone)} · ${formatBytes(status.lastSuccess.bytes)}`
      : 'Ainda nenhum backup.',
  );
  if (status.lastFailure) {
    lines.push(
      `⚠️ A última tentativa falhou (${formatWhen(status.lastFailure.at, options.timeZone)}): ${status.lastFailure.message}`,
    );
  }
  lines.push(
    '',
    `Todo dia a partir das ${String(status.hour)}h, guardando as ${String(status.keep)} cópias mais recentes na pasta "${FOLDER_NAME}" do seu Drive.`,
  );
  return lines.join('\n');
}

export function formatBackupResult(result: BackupResult): string {
  if (!result.ok) return backupFailureNotice(result.failure);
  const { record, pruned } = result;
  const trashed =
    pruned === 0
      ? ''
      : pruned === 1
        ? ' A cópia mais antiga foi para a lixeira do Drive.'
        : ` As ${String(pruned)} cópias mais antigas foram para a lixeira do Drive.`;
  return `✅ Backup feito: ${record.name} (${formatBytes(record.bytes)}), na pasta "${FOLDER_NAME}" do seu Drive.${trashed}`;
}

export function backupFailureNotice(failure: BackupFailure): string {
  switch (failure.reason) {
    case 'revoked':
      return '⚠️ O backup no Google Drive perdeu a autorização (removida ou vencida). Reconecte com /backup.';
    case 'not_connected':
      return '☁️ O Google Drive ainda não está conectado. Mande /backup para conectar.';
    case 'failed':
      return `⚠️ O backup no Google Drive falhou: ${failure.message}. Tento de novo em 1 hora; veja com /backup.`;
  }
}
