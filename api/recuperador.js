/* ==========================================================================
   Use Arcanju — Recuperador de carrinhos abandonados (WhatsApp)
   Endpoint: GET /api/recuperador?k=ADMIN_KEY
   Chamado a cada 15 minutos por um agendador (cron-job.org ou Upstash QStash).

   Sequência:
     Etapa 1 — ~1h após o abandono: lembrete gentil + link do carrinho (sem cupom)
     Etapa 2 — ~23h após o abandono, se não comprou: lembra o cupom fixo
               da loja CARRINHO10 (10% de desconto), que já está no texto do modelo

   Proteções:
     - nunca manda a mesma etapa duas vezes (registro no Upstash Redis)
     - não manda para quem já comprou depois de abandonar
     - não manda para quem respondeu SAIR
     - manda 24 horas por dia (decisão da loja)
     - modo teste: &teste=1 só mostra o que faria, sem enviar nada

   Variáveis de ambiente (Vercel):
     ADMIN_KEY, NUVEMSHOP_ACCESS_TOKEN, NUVEMSHOP_STORE_ID,
     WHATSAPP_TOKEN, WHATSAPP_PHONE_ID,
     UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
     TEMPLATE_CARRINHO_1   (ex: carrinho_lembrete)
     TEMPLATE_CARRINHO_2   (ex: carrinho_cupom)
     RECUPERADOR_ATIVO     (padrão "nao")  → só envia de verdade quando for "sim"
     RECUPERADOR_DESDE     (opcional)      → ex. 2026-11-20T08:00:00-03:00; carrinhos
                                             criados antes disso são ignorados
   ========================================================================== */

import { registrarEnvio } from './_registro.js';
const H = 3600 * 1000;
const ETAPA1_DEPOIS = 1 * H;      // manda o lembrete depois de 1h parado
const ETAPA1_ATE = 20 * H;        // ...se ainda estiver dentro de 20h
const ETAPA2_DEPOIS = 23 * H;     // cupom depois de ~23h
const ETAPA2_ATE = 72 * H;        // ...até 3 dias
const JANELA_BUSCA_DIAS = 4;

/* ------------------------------ utilidades ------------------------------ */

function normalizarTelefone(bruto) {
  if (!bruto) return null;
  let n = String(bruto).replace(/\D/g, '');
  if (n.startsWith('55') && n.length >= 12) n = n.slice(2);
  if (n.startsWith('0')) n = n.replace(/^0+/, '');
  if (n.length === 10) {
    const ddd = n.slice(0, 2), numero = n.slice(2);
    n = numero.length === 8 && /^[6-9]/.test(numero) ? ddd + '9' + numero : n;
  }
  if (n.length !== 10 && n.length !== 11) return null;
  return '55' + n;
}

function primeiroNome(nome) {
  if (!nome) return 'tudo bem';
  const p = String(nome).trim().split(/\s+/)[0];
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

// Hora e data de Brasília (UTC-3, sem horário de verão)
function agoraBrasilia() {
  return new Date(Date.now() - 3 * H);
}
function horaBrasilia() { return agoraBrasilia().getUTCHours(); }
function dataBrasilia(diasAFrente) {
  const d = new Date(agoraBrasilia().getTime() + (diasAFrente || 0) * 24 * H);
  return d.toISOString().slice(0, 10); // AAAA-MM-DD
}
function dataCurta(iso) { const [, m, d] = iso.split('-'); return `${d}/${m}`; }

function resumoProdutos(produtos) {
  if (!Array.isArray(produtos) || !produtos.length) return 'suas camisetas';
  const nomes = produtos.map((p) => {
    let nome = String(p.name || p.product_name || 'camiseta');
    // "CAMISETA OFF-WHITE PREMIUM - SÃO BENTO (P)" → "São Bento"
    const partes = nome.split(/\s[-–—]\s/);
    nome = (partes.length > 1 ? partes[partes.length - 1] : nome).replace(/\s*\(.*?\)\s*$/, '').trim();
    nome = nome.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
    return nome;
  });
  const unicos = [...new Set(nomes)];
  if (unicos.length === 1) return `a camiseta ${unicos[0]}`;
  if (unicos.length === 2) return `as camisetas ${unicos[0]} e ${unicos[1]}`;
  return `as camisetas ${unicos[0]}, ${unicos[1]} e mais ${unicos.length - 2}`;
}

function totalItens(produtos) {
  return (produtos || []).reduce((s, p) => s + (parseInt(p.quantity, 10) || 1), 0);
}

/* ------------------------------ Upstash Redis ---------------------------- */

async function redis(comando) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL/TOKEN não configurados');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando)
  });
  const j = await r.json();
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}
const temRedis = () => !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const jaFeito = async (chave) => (temRedis() ? (await redis(['GET', chave])) !== null : false);
const marcar = (chave, dias) => redis(['SET', chave, String(Date.now()), 'EX', String(dias * 86400)]);

/* ------------------------------ Nuvemshop ------------------------------- */

function nsCabecalhos() {
  return {
    'Authentication': `bearer ${process.env.NUVEMSHOP_ACCESS_TOKEN}`,
    'User-Agent': 'Use Arcanju (contato@usearcanju.com.br)',
    'Content-Type': 'application/json'
  };
}
function nsBase() { return `https://api.tiendanube.com/v1/${process.env.NUVEMSHOP_STORE_ID}`; }

async function nsListar(caminho, paginasMax) {
  const todos = [];
  for (let page = 1; page <= (paginasMax || 5); page++) {
    const sep = caminho.includes('?') ? '&' : '?';
    const r = await fetch(`${nsBase()}${caminho}${sep}per_page=100&page=${page}`, { headers: nsCabecalhos() });
    if (r.status === 404) break;                 // Nuvemshop devolve 404 quando acabam as páginas
    if (!r.ok) throw new Error(`Nuvemshop ${caminho} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const lote = await r.json();
    if (!Array.isArray(lote) || !lote.length) break;
    todos.push(...lote);
    if (lote.length < 100) break;
  }
  return todos;
}

async function criarCupom(codigo, valor, minimo, validoAte) {
  const r = await fetch(`${nsBase()}/coupons`, {
    method: 'POST',
    headers: nsCabecalhos(),
    body: JSON.stringify({
      code: codigo,
      type: 'absolute',
      value: Number(valor).toFixed(2),
      valid: true,
      max_uses: 1,
      min_price: Number(minimo).toFixed(2),
      start_date: dataBrasilia(0),
      end_date: validoAte
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Cupom ${codigo} → HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

function gerarCodigo(nome) {
  const base = String(nome || 'ARCANJU').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'ARCANJU';
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I para não confundir
  let sufixo = '';
  for (let i = 0; i < 4; i++) sufixo += letras[Math.floor(Math.random() * letras.length)];
  return `${base}${sufixo}`;
}

/* ------------------------------ WhatsApp -------------------------------- */

async function enviarTemplate(telefone, template, parametros) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefone,
      type: 'template',
      template: {
        name: template,
        language: { code: 'pt_BR' },
        components: [{ type: 'body', parameters: parametros.map((t) => ({ type: 'text', text: String(t) })) }]
      }
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`WhatsApp ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  await registrarEnvio(j, template, telefone, parametros);
  return j;
}

/* ------------------------------ handler -------------------------------- */

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const chave = process.env.ADMIN_KEY || process.env.WEBHOOK_SECRET;
  if (!chave || url.searchParams.get('k') !== chave) return res.status(401).json({ erro: 'Chave inválida' });

  const teste = url.searchParams.get('teste') === '1' || process.env.RECUPERADOR_ATIVO !== 'sim';
  const paraForcado = normalizarTelefone(url.searchParams.get('para')); // em teste, manda tudo para este número
  const valorCupom = Number(process.env.CUPOM_VALOR || 15);
  const minimoCupom = Number(process.env.CUPOM_MINIMO || 170);
  // Data/hora (ISO) a partir da qual o robô assume os carrinhos. Antes disso, planilha manual.
  const inicio = process.env.RECUPERADOR_DESDE ? new Date(process.env.RECUPERADOR_DESDE).getTime() : 0;
  // em teste com &para=, manda no máximo 1 mensagem por etapa
  const enviados = { 1: 0, 2: 0 };
  if (!teste && !temRedis()) return res.status(500).json({ erro: 'Configure o Upstash Redis antes de ativar (evita mensagens duplicadas)' });
  const relatorio = { modo: teste ? 'TESTE (nada enviado)' : 'ATIVO', hora_brasilia: horaBrasilia(), acoes: [] };

  try {
    const desde = new Date(Date.now() - JANELA_BUSCA_DIAS * 24 * H).toISOString();

    // 1) carrinhos abandonados e pedidos recentes
    const [checkouts, pedidos] = await Promise.all([
      nsListar(`/checkouts?created_at_min=${encodeURIComponent(desde)}`, 5),
      nsListar(`/orders?created_at_min=${encodeURIComponent(desde)}&fields=id,number,contact_email,contact_phone,created_at,status`, 5)
    ]);
    relatorio.checkouts_encontrados = checkouts.length;

    // quem comprou (por e-mail e telefone) e quando — pedidos cancelados não contam.
    // Inclui pedidos manuais (criados no painel), desde que tenham e-mail ou telefone.
    const compras = {};
    for (const p of pedidos) {
      if (p.status === 'cancelled') continue;
      const t = new Date(p.created_at).getTime();
      const email = (p.contact_email || '').toLowerCase();
      const tel = normalizarTelefone(p.contact_phone);
      if (email) compras[email] = Math.max(compras[email] || 0, t);
      if (tel) compras[tel] = Math.max(compras[tel] || 0, t);
    }

    const silencio = false; // envia 24h por dia

    for (const c of checkouts) {
      const telefone = normalizarTelefone(c.contact_phone || (c.shipping_address && c.shipping_address.phone));
      const email = (c.contact_email || '').toLowerCase();
      const link = c.abandoned_checkout_url;
      const criadoEm = new Date(c.created_at).getTime();
      const ultimoMovimento = new Date(c.updated_at || c.created_at).getTime();
      const idade = Date.now() - ultimoMovimento;
      const id = c.id;
      const registro = { checkout: id, nome: primeiroNome(c.contact_name), idade_h: +(idade / H).toFixed(1) };

      // Carrinhos anteriores à ativação já foram tratados à mão pela planilha
      if (inicio && criadoEm < inicio) { relatorio.acoes.push({ ...registro, acao: 'ignorado: anterior a RECUPERADOR_DESDE' }); continue; }
      if (!telefone || !link) { relatorio.acoes.push({ ...registro, acao: 'ignorado: sem telefone ou link' }); continue; }
      if (c.completed_at) { relatorio.acoes.push({ ...registro, acao: 'ignorado: checkout concluído' }); continue; }

      // Já comprou? Qualquer pedido (não cancelado) feito DEPOIS que este carrinho foi criado,
      // com o mesmo e-mail ou telefone — inclusive em outro carrinho ou por pedido manual.
      // Usa a data de CRIAÇÃO do carrinho: quem compra num carrinho novo e depois reabre
      // o link do antigo não recebe mensagem. Se a pessoa comprou ANTES e depois montou
      // um carrinho novo, é outra compra — aí a mensagem segue normalmente.
      const ultimaCompra = Math.max(compras[email] || 0, compras[telefone] || 0);
      if (ultimaCompra && ultimaCompra >= criadoEm - 10 * 60 * 1000) {
        relatorio.acoes.push({ ...registro, acao: 'ignorado: já comprou' }); continue;
      }

      if (await jaFeito(`optout:${telefone}`)) { relatorio.acoes.push({ ...registro, acao: 'ignorado: pediu para sair' }); continue; }

      const destino = teste && paraForcado ? paraForcado : telefone;
      const nome = primeiroNome(c.contact_name);
      const produtos = resumoProdutos(c.products);
      const feito1 = await jaFeito(`rec:${id}:1`);
      const feito2 = await jaFeito(`rec:${id}:2`);

      // ---- Etapa 1: lembrete
      if (!feito1 && idade >= ETAPA1_DEPOIS && idade < ETAPA1_ATE) {
        if (silencio) { relatorio.acoes.push({ ...registro, acao: 'etapa 1 aguardando 8h' }); continue; }
        if (!teste || (paraForcado && !enviados[1])) {
          await enviarTemplate(destino, process.env.TEMPLATE_CARRINHO_1, [nome, produtos, link]);
          enviados[1]++;
        }
        if (!teste) await marcar(`rec:${id}:1`, 10);
        relatorio.acoes.push({ ...registro, acao: teste ? 'etapa 1 (simulada)' : 'etapa 1 ENVIADA', para: destino, produtos });
        continue;
      }

      // ---- Etapa 2: cupom (só se a etapa 1 já foi, ou se ela perdeu a janela)
      if (!feito2 && idade >= ETAPA2_DEPOIS && idade < ETAPA2_ATE) {
        if (silencio) { relatorio.acoes.push({ ...registro, acao: 'etapa 2 aguardando 8h' }); continue; }
        // Cupom fixo da loja (CARRINHO10, 10%), escrito direto no texto do modelo.
        // O modelo só tem 2 campos: {{1}} nome e {{2}} link do carrinho.
        if (!teste) {
          await marcar(`rec:${id}:2`, 10);                 // marca antes: nunca duplica
          await enviarTemplate(destino, process.env.TEMPLATE_CARRINHO_2, [nome, link]);
        } else if (paraForcado && !enviados[2]) {
          enviados[2]++;
          await enviarTemplate(destino, process.env.TEMPLATE_CARRINHO_2, [nome, link]);
        }
        relatorio.acoes.push({ ...registro, acao: teste ? 'etapa 2 (simulada)' : 'etapa 2 ENVIADA', para: destino });
        continue;
      }

      relatorio.acoes.push({ ...registro, acao: 'nada a fazer agora' });
    }

    return res.status(200).json(relatorio);
  } catch (e) {
    console.error('[recuperador] FALHA:', e && e.message);
    return res.status(200).json({ ...relatorio, erro: String(e && e.message) });
  }
}
