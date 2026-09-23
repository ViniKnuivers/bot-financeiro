/**
 * Contrato entre um canal de mensagens (Telegram hoje, WhatsApp no futuro) e o
 * assistente. O canal só traduz o protocolo da plataforma; toda a lógica de
 * negócio fica no `MessageHandler`, que não sabe de onde a mensagem veio.
 */

export interface IncomingTextMessage {
  text: string;
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
  actions?: ReplyAction[];
}

export interface MessageHandler {
  handleStart(): OutgoingMessage;
  handleText(message: IncomingTextMessage): Promise<OutgoingMessage>;
  handleAction(actionId: string): Promise<OutgoingMessage>;
}

export interface MessageChannel {
  readonly name: string;
  /** Resolve quando o canal já está recebendo mensagens. */
  start(): Promise<void>;
  stop(): Promise<void>;
}
