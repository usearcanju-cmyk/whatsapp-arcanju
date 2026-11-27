# Campanha em massa pelo WhatsApp (ex.: Black Friday)

Arquivo: `api/campanha.js`. Manda um modelo de marketing para quem já comprou e para quem abandonou carrinho, em lotes, respeitando o limite diário da Meta. Nada é enviado enquanto `CAMPANHA_ATIVA` não for `sim`.

## Quem recebe
1. Quem **já comprou** (pedido pago, não cancelado), do pedido mais recente para o mais antigo.
2. Depois, quem **abandonou carrinho** nos últimos 30 dias e não comprou.
- Sem número repetido. Pula quem respondeu **SAIR**. Cada número recebe **uma vez** por campanha.

## Passo 1 — Modelo na Meta
WhatsApp Manager → Modelos de mensagem → Criar modelo · Categoria **Marketing** · Idioma **Português (BR)** · Nome `black_friday_99`

**Corpo** (só uma variável, {{1}} = primeiro nome):
```
Oi, {{1}}! Aqui é o Ricardo, da Use Arcanju. 🖤

A nossa Black Friday chegou, e preparei uma condição só para quem já faz parte da nossa família:

👕 *2 camisetas por R$ 99*
🚚 Frete grátis
🎁 Capelinha e sacolinha de presente

É só escolher suas 2 camisetas no site e usar o cupom *BLACK99* no carrinho.

⏳ Válido só até domingo (29/11), às 23h59.

Deus abençoe! 🙏
```
**Rodapé:** `Para não receber mais, responda SAIR.`
**Botão:** Acessar site → `https://usearcanju.com.br`
Exemplo para {{1}}: `Maria`

## Passo 2 — Variáveis na Vercel (projeto whatsapp-arcanju)
| Variável | Valor |
|---|---|
| `CAMPANHA_ID` | `black2026` |
| `TEMPLATE_CAMPANHA` | `black_friday_99` |
| `CAMPANHA_CUPOM` | `BLACK99` |
| `CAMPANHA_CUPOM_VALOR` | `80` (ver Passo 3) |
| `CAMPANHA_CUPOM_MINIMO` | `150` (1 camiseta não usa) |
| `CAMPANHA_FIM` | `2026-11-29T23:59:00-03:00` |
| `CAMPANHA_LIMITE_DIA` | o limite do número no WhatsApp Manager (Visão geral → Limite de mensagens). Número novo costuma começar em 250 |
| `CAMPANHA_LOTE` | `40` |
| `CAMPANHA_ATIVA` | `nao` (só muda para `sim` no Passo 5) |
Depois: Deployments → Redeploy.

## Passo 3 — Cupom
Abrir `/api/campanha?k=ADMIN_KEY&acao=cupom` → cria o BLACK99 na Nuvemshop (R$ 80 de desconto, pedido mínimo R$ 150, até o fim da campanha).
**Testar no site:** colocar 2 camisetas no carrinho e aplicar BLACK99. Tem que dar **R$ 99**.
- Se der R$ 114, o cupom não está somando com o desconto por quantidade: editar o cupom na Nuvemshop para **R$ 95** (e ajustar `CAMPANHA_CUPOM_VALOR`).

## Passo 4 — Teste
- `/api/campanha?k=ADMIN_KEY&acao=preparar&teste=1` → mostra quantas compradoras, carrinhos, SAIR e quantos entram na fila (não grava).
- `/api/campanha?k=ADMIN_KEY&acao=enviar&teste=1&para=37999999999` → manda 1 mensagem para o seu número.

## Passo 5 — Disparar
1. `/api/campanha?k=ADMIN_KEY&acao=preparar` → grava a fila.
2. Vercel: `CAMPANHA_ATIVA` = `sim` → Redeploy.
3. Upstash → QStash → Schedules → novo: URL `https://SEU-DOMINIO/api/campanha?k=ADMIN_KEY&acao=enviar`, a cada **10 minutos** (`*/10 * * * *`).
   - 40 por rodada = até 240 por hora, até bater o limite do dia; no dia seguinte continua sozinho.
   - Para sozinho 2h antes do `CAMPANHA_FIM`.

## Ondas de lembrete (só para quem ainda não comprou)
- Cada onda tem seu modelo aprovado: `TEMPLATE_CAMPANHA_2`, `_3`, `_4` (mesmo formato, só {{1}} = nome).
- Na hora da onda: `/api/campanha?k=ADMIN_KEY&acao=preparar&onda=2` → pega quem recebeu a onda anterior, tira quem já comprou (qualquer pedido pago desde o início da campanha) e quem pediu SAIR.
- O mesmo agendador de 10 em 10 min envia: ondas mais novas primeiro, e a onda 1 continua com as vagas que sobrarem do limite do dia.
- Dá para agendar o "preparar" de cada onda no QStash (um agendamento por onda, no horário dela) e apagar depois.
- Teste de uma onda: `&acao=enviar&teste=1&onda=2&para=37999999999`.

## Acompanhar e controlar
- `/api/campanha?k=ADMIN_KEY&acao=status` → na fila, enviadas hoje/total, falhas e **vendas com o cupom** (quantidade e faturamento).
- `/api/envios?k=ADMIN_KEY` → entregue/lida de cada mensagem (aparece como "Campanha (black2026)").
- `&acao=pausar` / `&acao=retomar` → para na hora e continua depois.
- Se a Meta avisar de limite (erros 131048, 131056, 80007, 130429), a rodada para sozinha.
- Terminou: apagar o schedule do QStash e voltar `CAMPANHA_ATIVA` para `nao`.

## Próxima campanha
Trocar `CAMPANHA_ID` (ex.: `natal2026`), o modelo, o cupom e a data → `acao=preparar` de novo. Quem recebeu uma campanha pode receber a próxima.
