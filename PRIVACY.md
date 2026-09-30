# Política de privacidade · bot-financeiro

Última atualização: 30/09/2026

O bot-financeiro é um projeto de código aberto que **cada pessoa roda no próprio
computador**, com as próprias chaves. Não existe um servidor central: quem mantém este
repositório não recebe, guarda nem vê os dados de quem usa o bot.

## Quais dados o bot usa

- **Os lançamentos que você manda:** gastos, receitas, cartões, contas, orçamentos e
  lembretes. Ficam no banco de dados (PostgreSQL) que roda no seu computador.
- **As suas mensagens** no Telegram (ou WhatsApp). O texto e os áudios vão para a API do
  Google Gemini, só para serem entendidos e virarem lançamentos.
- **A sua planilha Google**, se você configurar. O bot escreve e lê nela com uma conta de
  serviço criada por você.
- **O seu Google Drive**, se você ativar o backup. O bot pede só o acesso `drive.file`,
  com o qual ele **enxerga apenas os arquivos que ele mesmo criou**: a pasta
  "Financeiro – backups" e as cópias do banco de dados dentro dela. Os seus outros
  arquivos continuam invisíveis para ele.

## Com quem os dados são compartilhados

Com ninguém além dos serviços que você mesmo configura: Telegram (ou WhatsApp/Meta), Google
Gemini, Google Planilhas e Google Drive, cada um com as suas próprias políticas. Os dados
não são vendidos, usados para publicidade nem enviados a terceiros.

## Como apagar

- **Acesso ao Drive:** remova em https://myaccount.google.com/connections.
- **Backups:** apague a pasta "Financeiro – backups" no seu Drive.
- **Dados do bot:** apague o banco de dados local (`docker compose down -v`).

## Contato

Dúvidas: abra uma issue em https://github.com/ViniKnuivers/bot-financeiro/issues.
