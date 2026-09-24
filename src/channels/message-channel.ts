/**
 * Contrato entre um canal de mensagens (Telegram hoje, WhatsApp no futuro) e o
 * assistente. O canal só traduz o protocolo da plataforma; toda a lógica de
 * negócio fica no `MessageHandler`, que não sabe de onde a mensagem veio.
 */

export interface IncomingTextMessage {
  text: string;
  receivedAt: Date;
}

export interface IncomingAudioMessage {
  audio: Buffer;
  /** Ex.: "audio/ogg" (mensagens de voz do Telegram são OGG/Opus). */
  mimeType: string;
  receivedAt: Date;
}

/** Um botão anexado à resposta. O canal decide como desenhá-lo (ex.: botão inline). */
export interface ReplyAction {
  label: string;
  /** Identificador opaco devolvido em `handleAction` quando o botão é tocado (máx. 64 bytes). */
  id: string;
}

export interface OutgoingMessage {
  text: string;
  /** Botões em linhas: cada array interno é uma linha. */
  actions?: ReplyAction[][];
}

/**
 * Resposta ao toque num botão. "replace" troca o texto e os botões da mensagem tocada
 * (perguntas em vários passos); "append" acrescenta o texto e remove os botões
 * (ex.: "↩️ Desfeito" embaixo do resumo).
 */
export interface ActionReply extends OutgoingMessage {
  mode: 'replace' | 'append';
}

export interface MessageHandler {
  handleStart(): OutgoingMessage;
  handleText(message: IncomingTextMessage): Promise<OutgoingMessage>;
  handleAudio(message: IncomingAudioMessage): Promise<OutgoingMessage>;
  handleAction(actionId: string): Promise<ActionReply>;
  /** Últimos lançamentos registrados. */
  handleLatest(): Promise<OutgoingMessage>;
  /** Apaga o último lançamento registrado. */
  handleUndoLast(): Promise<OutgoingMessage>;
  /** Menu de cartões e contas. */
  handleAccounts(): Promise<OutgoingMessage>;
  /** Lançamentos esperando resposta (uma mensagem por pendência). */
  handlePending(): Promise<OutgoingMessage[]>;
  /** Resumo do mês. */
  handleSummary(): Promise<OutgoingMessage>;
  /** Menu de orçamento por categoria. */
  handleBudgets(): Promise<OutgoingMessage>;
  /** Menu de gastos fixos. */
  handleRecurring(): Promise<OutgoingMessage>;
  /** Link e situação da planilha Google. */
  handleSpreadsheet(): Promise<OutgoingMessage>;
  /** Link da aba de gráficos. */
  handleCharts(): Promise<OutgoingMessage>;
}

/** Envia mensagens por iniciativa do bot (gastos fixos, aviso do dia 1, alertas). */
export interface Notifier {
  notify(message: OutgoingMessage): Promise<void>;
}

export interface MessageChannel extends Notifier {
  readonly name: string;
  /** Resolve quando o canal já está recebendo mensagens. */
  start(): Promise<void>;
  stop(): Promise<void>;
}
