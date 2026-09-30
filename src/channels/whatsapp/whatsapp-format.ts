import type { OutgoingMessage, ReplyAction } from '../message-channel.js';
import type { WhatsAppListRow, WhatsAppOutgoing } from './whatsapp-api.js';

// Limites da Cloud API (Meta, v25.0).
const MAX_BUTTONS = 3;
const BUTTON_TITLE = 20;
const BUTTONS_BODY = 1024;
const MAX_LIST_ROWS = 10;
const ROW_TITLE = 24;
const ROW_DESCRIPTION = 72;
const LIST_BODY = 4096;
const TEXT_BODY = 4096;
const CAPTION = 1024;

const LIST_BUTTON = 'Escolher';

/**
 * Converte uma resposta do bot em mensagens do WhatsApp:
 * - sem ações: texto (dividido se passar do limite);
 * - até 3 ações com nomes curtos: botões;
 * - senão: lista (até 10 opções por mensagem; mais que isso vira várias listas).
 * O WhatsApp não edita mensagens já enviadas: respostas a toques sempre chegam como novas.
 */
export function toWhatsAppMessages(message: OutgoingMessage): WhatsAppOutgoing[] {
  if (message.document) {
    // Arquivo com o texto de legenda (ou antes, se passar do limite), e os botões depois.
    const { document, actions } = message;
    const fitsCaption = length(message.text) <= CAPTION;
    return [
      ...(fitsCaption ? [] : textMessages(message.text)),
      {
        kind: 'document',
        filename: document.filename,
        data: document.data,
        ...(fitsCaption ? { caption: message.text } : {}),
      },
      ...(actions && actions.flat().length > 0
        ? toWhatsAppMessages({ text: 'Mais opções:', actions })
        : []),
    ];
  }
  const actions = (message.actions ?? []).flat();
  if (actions.length === 0) return textMessages(message.text);

  if (actions.length <= MAX_BUTTONS && actions.every((a) => length(a.label) <= BUTTON_TITLE)) {
    const buttons = actions.map((a) => ({ id: a.id, title: a.label }));
    if (length(message.text) <= BUTTONS_BODY) {
      return [{ kind: 'buttons', body: message.text, buttons }];
    }
    return [
      ...textMessages(message.text),
      { kind: 'buttons', body: 'Escolha uma opção:', buttons },
    ];
  }

  const groups = chunkEvenly(actions, MAX_LIST_ROWS);
  const lead: WhatsAppOutgoing[] =
    length(message.text) <= LIST_BODY ? [] : textMessages(message.text);
  const firstBody = lead.length === 0 ? message.text : 'Escolha uma opção:';
  return [
    ...lead,
    ...groups.map((group, i): WhatsAppOutgoing => ({
      kind: 'list',
      body: i === 0 ? firstBody : `Mais opções (${i + 1}/${groups.length}):`,
      button: LIST_BUTTON,
      rows: group.map(toRow),
    })),
  ];
}

/** Nome cortado cabe no título; o nome inteiro vai na descrição. */
function toRow(action: ReplyAction): WhatsAppListRow {
  if (length(action.label) <= ROW_TITLE) return { id: action.id, title: action.label };
  return {
    id: action.id,
    title: clip(action.label, ROW_TITLE),
    description: clip(action.label, ROW_DESCRIPTION),
  };
}

/** Texto em pedaços de até 4096 caracteres, quebrando de preferência em fim de linha. */
function textMessages(text: string): WhatsAppOutgoing[] {
  const parts: string[] = [];
  let rest = text;
  while (length(rest) > TEXT_BODY) {
    const window = Array.from(rest).slice(0, TEXT_BODY).join('');
    const cut = window.lastIndexOf('\n') > TEXT_BODY / 2 ? window.lastIndexOf('\n') : window.length;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  parts.push(rest);
  return parts.map((part) => ({ kind: 'text', text: part }));
}

/** Divide em grupos de tamanho parecido (12 → 6 + 6, e não 10 + 2). */
function chunkEvenly<T>(items: readonly T[], max: number): T[][] {
  const count = Math.ceil(items.length / max);
  const size = Math.ceil(items.length / count);
  return Array.from({ length: count }, (_, i) => items.slice(i * size, (i + 1) * size));
}

/** Tamanho em caracteres visíveis (emoji conta como 1, como no WhatsApp). */
function length(text: string): number {
  return Array.from(text).length;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}
