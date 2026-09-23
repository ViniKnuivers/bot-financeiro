/**
 * Baixa um arquivo dos servidores do Telegram.
 * A URL contém o token do bot, por isso nunca deve aparecer em logs ou mensagens de erro.
 */
export async function downloadTelegramFile(
  token: string,
  filePath: string,
  timeoutMs = 15_000,
): Promise<Buffer> {
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`download do arquivo falhou: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
