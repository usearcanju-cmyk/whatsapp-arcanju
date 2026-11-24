# Carrinho abandonado + aviso de atraso: instalação

## Como funciona

### Carrinho abandonado (`recuperador.js`)

| Quando | Mensagem | Cupom |
|---|---|---|
| ~1h depois do abandono | Lembrete do Ricardo com o nome da camiseta e o link do carrinho | Nenhum |
| ~23h depois, se não comprou | Cupom exclusivo | **R$ 15 OFF**, uso único, válido até o fim do dia seguinte, só para pedidos a partir de **R$ 170** (o kit de 2 = R$ 179) |

- Não manda para quem já comprou depois de criar o carrinho (mesmo e-mail **ou** mesmo telefone, em outro carrinho ou por pedido manual). Pedido cancelado não conta.
- Se a pessoa comprou antes e depois montou um carrinho novo, é outra compra: a mensagem segue.
- Não manda para quem respondeu **SAIR**, nem duas vezes a mesma etapa.
- Ignora carrinhos criados antes de `RECUPERADOR_DESDE` (esses você já chamou pela planilha).
- Envia **24 horas por dia**.
- A recuperação da Appmax continua ligada (ela cuida do Pix/boleto gerado e não pago; o nosso sistema pula esses casos, porque já existe pedido).

### Pedido atrasado (`atraso.js`)

- Roda 1 vez por dia e olha os pedidos **pagos e ainda não enviados** dos últimos 60 dias.
- Prazo = data do pagamento + os dias úteis do frete que a cliente escolheu (ex.: "Frete Econômico para: Acre (12 até 16 dias úteis)" → 12 dias úteis). Sábado, domingo e feriados nacionais não contam.
- Passou do prazo e não foi enviado → manda o aviso **uma única vez** por pedido.
- Só envia de **segunda a quarta**, porque a mensagem diz que sai "ainda nesta semana". Quem atrasar na quinta ou sexta recebe na segunda.

---

## Passo 1: Criar os 3 modelos na Meta

No Gerenciador do WhatsApp: **Modelos de mensagens → Gerenciar modelos → Criar modelo** · Idioma: **Português (BR)**.

### Modelo 1: `carrinho_lembrete` · Categoria **Marketing**
Corpo:
```
Oi, {{1}}! Tudo bem?

Aqui é o Ricardo, da Use Arcanju.

Vi que você separou {{2}} aqui na nossa loja, e fiquei muito feliz com a sua escolha!

Aconteceu alguma coisa na hora de finalizar? Se ficou alguma dúvida sobre tamanho, entrega ou pagamento, é só acessar o nosso suporte: suporte.usearcanju.com.br

Deixei o seu carrinho guardadinho do jeitinho que você montou. É só clicar para concluir:
{{3}}

Que Deus abençoe o seu dia!
```
Rodapé: `Mensagem automática · Para não receber, responda SAIR`
Exemplos: `Maria` · `a camiseta Santa Teresinha` · `https://usearcanju.com.br/checkout/v3/123`

### Modelo 2: `carrinho_cupom` · Categoria **Marketing**
Corpo:
```
Oi, {{1}}! Tudo bem?

Aqui é o Ricardo, da Use Arcanju, de novo.

O seu carrinho continua guardado, e separei um presente para você: o cupom *{{2}}*, que dá R$ {{3}} de desconto no kit de 2 camisetas, com frete grátis, capelinha e sacolinha de presente.

O cupom vale até {{4}} e só pode ser usado uma vez.

É só clicar para concluir:
{{5}}

Que Deus abençoe o seu dia!
```
Rodapé: `Mensagem automática · Para não receber, responda SAIR`
Exemplos: `Maria` · `MARIAK7P2` · `15` · `25/11` · `https://usearcanju.com.br/checkout/v3/123`

### Modelo 3: `pedido_atrasado` · Categoria **Utilidade**
Corpo:
```
Oi, {{1}}! Tudo bem?

Passando para te dar notícias do seu pedido #{{2}}.

Como cada camiseta é produzida e estampada especialmente para você, a nossa produção levou um pouco mais de tempo do que o previsto, e o seu pedido ainda não foi despachado. Pedimos desculpas pela demora!

Não se preocupe: ele deve sair ainda nesta semana, e assim que for enviado você recebe o código de rastreio aqui mesmo.

Lembrando que não respondemos por este WhatsApp. Para conferir o status do seu pedido ou falar com a gente, acesse suporte.usearcanju.com.br

Que Deus abençoe o seu dia!
```
Rodapé: `Aviso automático · Não respondemos por aqui`
Botão: **Visitar site** → texto `Acompanhar pedido` → URL estática `https://suporte.usearcanju.com.br/`
Exemplos: `Maria` · `3147`

---

## Passo 2: Upstash Redis

É ele que lembra quem já recebeu cada mensagem.
1. Em [upstash.com](https://upstash.com), clique em **Create Database** → Redis → região **São Paulo** → plano grátis.
2. Na aba **REST API**, copie `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`.

---

## Passo 3: Variáveis na Vercel (projeto whatsapp-arcanju)

| Key | Value |
|---|---|
| `UPSTASH_REDIS_REST_URL` | (do Upstash) |
| `UPSTASH_REDIS_REST_TOKEN` | (do Upstash) |
| `TEMPLATE_CARRINHO_1` | `carrinho_lembrete` |
| `TEMPLATE_CARRINHO_2` | `carrinho_cupom` |
| `TEMPLATE_ATRASO` | `pedido_atrasado` |
| `CUPOM_VALOR` | `15` |
| `CUPOM_MINIMO` | `170` |
| `RECUPERADOR_DESDE` | data e hora da ativação, ex.: `2026-11-25T08:00:00-03:00` |
| `META_VERIFY_TOKEN` | uma palavra secreta sua, ex.: `arcanju-entrada-2026` |
| `RECUPERADOR_ATIVO` | `nao` (só troque para `sim` depois do teste) |
| `ATRASO_ATIVO` | `nao` (só troque para `sim` depois do teste) |
| `PRAZO_USAR` | `min` (menor prazo do frete) ou `max` (maior prazo) |

Depois de salvar: **Deployments → … → Redeploy**.

---

## Passo 4: Subir os arquivos no GitHub

Na pasta `api` do repositório **whatsapp-arcanju**, envie: `recuperador.js`, `atraso.js` e `entrada.js`.

---

## Passo 5: Ligar as respostas das clientes (webhook de entrada)

É o que faz o **SAIR** funcionar e responde automaticamente com o link do suporte.
1. Em [developers.facebook.com](https://developers.facebook.com) → **Meus apps** → o app do WhatsApp → **WhatsApp → Configuração**.
2. Em **Webhook**, clique em Editar:
   - **URL de retorno:** `https://whatsapp-arcanju.vercel.app/api/entrada`
   - **Token de verificação:** o mesmo `META_VERIFY_TOKEN` do passo 3
3. Salve e, em **Campos do webhook**, assine **messages**.
4. Abra `https://whatsapp-arcanju.vercel.app/api/numero?k=SENHA&acao=assinar` (tem que dar `"ok": true`).

---

## Passo 6: Testar sem enviar nada para clientes

Carrinhos:
```
https://whatsapp-arcanju.vercel.app/api/recuperador?k=SENHA&teste=1
```
Atrasos:
```
https://whatsapp-arcanju.vercel.app/api/atraso?k=SENHA&teste=1
```
As telas mostram cada carrinho/pedido e o que o sistema **faria**. Nada é enviado.

Teste real só no seu celular (troque pelo seu número):
```
https://whatsapp-arcanju.vercel.app/api/recuperador?k=SENHA&teste=1&para=55SEUNUMERO
https://whatsapp-arcanju.vercel.app/api/atraso?k=SENHA&teste=1&para=55SEUNUMERO
```

---

## Passo 7: Ligar de verdade

1. Na Vercel, mude `RECUPERADOR_ATIVO` e `ATRASO_ATIVO` para `sim` e faça um **Redeploy**.
2. Em [cron-job.org](https://cron-job.org), crie 2 tarefas:
   - `https://whatsapp-arcanju.vercel.app/api/recuperador?k=SENHA` → a cada **15 minutos**
   - `https://whatsapp-arcanju.vercel.app/api/atraso?k=SENHA` → **todo dia às 10h**
3. Quando sair o primeiro cupom de verdade, confira em **Nuvemshop → Marketing → Cupons** se ele aparece com R$ 15, mínimo de R$ 170, 1 uso e a data certa.

**Para pausar:** volte a variável para `nao` e faça um Redeploy.

**Custo:** mensagem de marketing ≈ US$ 0,06 (≈ R$ 0,70 por carrinho, com as 2). O aviso de atraso é de utilidade, bem mais barato (≈ US$ 0,01).
