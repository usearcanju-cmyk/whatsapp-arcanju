/* ==========================================================================
   Use Arcanju — Campanha em massa pelo WhatsApp oficial (ex.: Black Friday)
   Endpoint: /api/campanha?k=ADMIN_KEY&acao=...

   Ações:
     acao=cupom      cria o cupom da campanha na Nuvemshop (uma vez; se já existir, só avisa)
     acao=preparar   monta a fila: primeiro quem já comprou (mais recente primeiro),
                     depois quem abandonou carrinho (mais recente primeiro).
                     Sem número repetido, sem quem pediu SAIR, sem quem já recebeu.
                     &teste=1 só mostra os números, não grava a fila.
     acao=enviar     manda o próximo lote da fila (chamado pelo agendador a cada 10 min).
                     Respeita o limite diário e para sozinho no fim da campanha.
                     &teste=1&para=DDD+número manda 1 mensagem só para esse número.
     acao=status     quantos na fila, enviados hoje, enviados no total, falhas,
                     e as vendas que usaram o cupom.
     acao=pausar / acao=retomar

   Variáveis de ambiente (Vercel):
     CAMPANHA_ID           (ex.: black2026)            — separa uma campanha da outra
     TEMPLATE_CAMPANHA     (ex.: black_friday_99)      — modelo aprovado na Meta, só {{1}} = nome
     CAMPANHA_CUPOM        (ex.: BLACK99)
     CAMPANHA_CUPOM_VALOR  (ex.: 80)                   — R$ de desconto
     CAMPANHA_CUPOM_MINIMO (ex.: 150)                  — pedido mínimo (1 camiseta não usa)
     CAMPANHA_FIM          (ex.: 2026-11-29T23:59:00-03:00)
     CAMPANHA_ATIVA        "sim" para enviar de verdade (padrão: não envia)
     CAMPANHA_LOTE         mensagens por rodada (padrão 40)
     CAMPANHA_LIMITE_DIA   máximo por dia (padrão 250 — limite inicial da Meta para número novo)
     CAMPANHA_CARRINHOS_DIAS  quantos dias de carrinhos abandonados olhar (padrão 30)
     CAMPANHA_IMAGEM       (opcional) link da imagem, se o modelo tiver imagem no cabeçalho
     + as mesmas do recuperador: NUVEMSHOP_*, WHATSAPP_*, UPSTASH_*
   ========================================================================== */

import { registrarEnvio } from './_registro.js';

export const config = { maxDuration: 60 };

const H = 3600 * 1000;

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
  if (!p || /\d|@/.test(p)) return 'tudo bem';
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

const hojeBrasilia = () => new Date(Date.now() - 3 * H).toISOString().slice(0, 10);

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

/* ------------------------------ Nuvemshop ------------------------------- */

function nsCabecalhos() {
  return {
    'Authentication': `bearer ${process.env.NUVEMSHOP_ACCESS_TOKEN}`,
    'User-Agent': 'Use Arcanju (contato@usearcanju.com.br)',
    'Content-Type': 'application/json'
  };
}
const nsBase = () => `https://api.tiendanube.com/v1/${process.env.NUVEMSHOP_STORE_ID}`;

async function nsListar(caminho, paginasMax) {
  const todos = [];
  for (let page = 1; page <= paginasMax; page++) {
    const sep = caminho.includes('?') ? '&' : '?';
    const r = await fetch(`${nsBase()}${caminho}${sep}per_page=200&page=${page}`, { headers: nsCabecalhos() });
    if (r.status === 404) break;
    if (!r.ok) throw new Error(`Nuvemshop ${caminho} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const lote = await r.json();
    if (!Array.isArray(lote) || !lote.length) break;
    todos.push(...lote);
    if (lote.length < 200) break;
  }
  return todos;
}

/* ------------------------------ WhatsApp -------------------------------- */

async function enviarTemplate(telefone, template, nome) {
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
        components: [
          // modelo com imagem no topo: a imagem vai junto em cada envio (CAMPANHA_IMAGEM = link público .jpg/.png)
          ...(process.env.CAMPANHA_IMAGEM ? [{ type: 'header', parameters: [{ type: 'image', image: { link: process.env.CAMPANHA_IMAGEM } }] }] : []),
          { type: 'body', parameters: [{ type: 'text', text: String(nome) }] }
        ]
      }
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = (j && j.error) || {};
    const erro = new Error(`WhatsApp ${r.status}: ${e.message || JSON.stringify(j).slice(0, 200)}`);
    erro.codigo = e.code;
    throw erro;
  }
  await registrarEnvio(j, template, telefone, [nome]);
  return j;
}

/* ------------------------------ ações ---------------------------------- */

const CAMP = () => process.env.CAMPANHA_ID || 'campanha';
const K = (s) => `camp:${CAMP()}:${s}`;

async function acaoCupom() {
  const codigo = (process.env.CAMPANHA_CUPOM || '').toUpperCase();
  if (!codigo) throw new Error('Defina CAMPANHA_CUPOM na Vercel');
  const existentes = await nsListar(`/coupons?q=${encodeURIComponent(codigo)}`, 1).catch(() => []);
  const ja = existentes.find((c) => String(c.code).toUpperCase() === codigo);
  if (ja) return { cupom: codigo, situacao: 'já existe', id: ja.id, valor: ja.value, minimo: ja.min_price, fim: ja.end_date };
  const fim = (process.env.CAMPANHA_FIM || '').slice(0, 10);
  const r = await fetch(`${nsBase()}/coupons`, {
    method: 'POST',
    headers: nsCabecalhos(),
    body: JSON.stringify({
      code: codigo,
      type: 'absolute',
      value: Number(process.env.CAMPANHA_CUPOM_VALOR || 80).toFixed(2),
      valid: true,
      min_price: Number(process.env.CAMPANHA_CUPOM_MINIMO || 150).toFixed(2),
      start_date: hojeBrasilia(),
      ...(fim ? { end_date: fim } : {})
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Cupom ${codigo} → HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return { cupom: codigo, situacao: 'criado', id: j.id, valor: j.value, minimo: j.min_price, fim: j.end_date };
}

async function acaoPreparar(teste) {
  const diasCarrinho = Number(process.env.CAMPANHA_CARRINHOS_DIAS || 30);
  const desdeCarrinho = new Date(Date.now() - diasCarrinho * 24 * H).toISOString();

  const [pedidos, checkouts] = await Promise.all([
    nsListar('/orders?fields=id,contact_name,contact_phone,created_at,status,payment_status,customer,shipping_address', 40),
    nsListar(`/checkouts?created_at_min=${encodeURIComponent(desdeCarrinho)}`, 10)
  ]);

  const compradoras = new Map(); // tel → {nome, quando}
  for (const p of pedidos) {
    if (p.status === 'cancelled') continue;
    if (!['paid', 'authorized'].includes(p.payment_status)) continue;
    const tel = normalizarTelefone(p.contact_phone || (p.customer && p.customer.phone) || (p.shipping_address && p.shipping_address.phone));
    if (!tel) continue;
    const t = new Date(p.created_at).getTime();
    const atual = compradoras.get(tel);
    if (!atual || t > atual.quando) compradoras.set(tel, { nome: primeiroNome(p.contact_name || (p.customer && p.customer.name)), quando: t });
  }

  const carrinhos = new Map();
  for (const c of checkouts) {
    if (c.completed_at) continue;
    const tel = normalizarTelefone(c.contact_phone || (c.shipping_address && c.shipping_address.phone));
    if (!tel || compradoras.has(tel)) continue;
    const t = new Date(c.created_at).getTime();
    const atual = carrinhos.get(tel);
    if (!atual || t > atual.quando) carrinhos.set(tel, { nome: primeiroNome(c.contact_name), quando: t });
  }

  const ordem = (m, origem) => [...m.entries()].sort((a, b) => b[1].quando - a[1].quando)
    .map(([tel, v]) => ({ tel, nome: v.nome, origem }));
  const candidatos = [...ordem(compradoras, 'comprou'), ...ordem(carrinhos, 'carrinho')];

  // tira quem pediu SAIR e quem já recebeu esta campanha
  const fila = [];
  let sairam = 0, jaRecebeu = 0;
  for (let i = 0; i < candidatos.length; i += 100) {
    const bloco = candidatos.slice(i, i + 100);
    const optouts = await redis(['MGET', ...bloco.map((c) => `optout:${c.tel}`)]);
    const enviados = await redis(['SMISMEMBER', K('enviados'), ...bloco.map((c) => c.tel)]);
    bloco.forEach((c, j) => {
      if (optouts[j] !== null) { sairam++; return; }
      if (enviados[j]) { jaRecebeu++; return; }
      fila.push(c);
    });
  }

  const resumo = {
    campanha: CAMP(),
    compradoras: compradoras.size,
    carrinhos_sem_compra: carrinhos.size,
    pediram_sair: sairam,
    ja_receberam: jaRecebeu,
    na_fila: fila.length
  };
  if (teste) return { ...resumo, modo: 'TESTE (fila não gravada)', primeiros: fila.slice(0, 10).map((c) => ({ ...c, tel: '•••' + c.tel.slice(-4) })) };

  await redis(['DEL', K('fila')]);
  for (let i = 0; i < fila.length; i += 200) {
    await redis(['RPUSH', K('fila'), ...fila.slice(i, i + 200).map((c) => JSON.stringify(c))]);
  }
  await redis(['SET', K('preparadaEm'), new Date().toISOString()]);
  return { ...resumo, modo: 'fila gravada' };
}

async function acaoEnviar(teste, para) {
  const template = process.env.TEMPLATE_CAMPANHA;
  if (!template) throw new Error('Defina TEMPLATE_CAMPANHA na Vercel');

  if (teste) {
    if (!para) return { modo: 'TESTE', aviso: 'Use &para=DDDNUMERO para receber 1 mensagem de teste' };
    const r = await enviarTemplate(para, template, 'Mateus');
    return { modo: 'TESTE', enviada_para: '•••' + para.slice(-4), id: r.messages && r.messages[0] && r.messages[0].id };
  }

  if (process.env.CAMPANHA_ATIVA !== 'sim') return { parado: 'CAMPANHA_ATIVA não está "sim"' };
  if (await redis(['GET', K('pausada')])) return { parado: 'campanha pausada' };
  const fim = process.env.CAMPANHA_FIM ? new Date(process.env.CAMPANHA_FIM).getTime() : 0;
  if (fim && Date.now() > fim - 2 * H) return { parado: 'campanha terminando ou terminada — não envia mais' };

  const limiteDia = Number(process.env.CAMPANHA_LIMITE_DIA || 250);
  const lote = Number(process.env.CAMPANHA_LOTE || 40);
  const chaveDia = K(`dia:${hojeBrasilia()}`);
  const jaHoje = Number(await redis(['GET', chaveDia])) || 0;
  const podem = Math.min(lote, limiteDia - jaHoje);
  if (podem <= 0) return { parado: `limite do dia atingido (${limiteDia})` };

  const res = { enviadas: 0, falhas: 0, puladas: 0, erros: [] };
  for (let i = 0; i < podem; i++) {
    const bruto = await redis(['LPOP', K('fila')]);
    if (!bruto) { res.fila_vazia = true; break; }
    const c = JSON.parse(bruto);
    // checa de novo na hora de enviar (pode ter pedido SAIR ou recebido em outra rodada)
    if (await redis(['GET', `optout:${c.tel}`]) !== null) { res.puladas++; continue; }
    const novo = await redis(['SADD', K('enviados'), c.tel]);
    if (!novo) { res.puladas++; continue; }
    try {
      await enviarTemplate(c.tel, template, c.nome);
      res.enviadas++;
      await redis(['INCR', chaveDia]);
      await redis(['EXPIRE', chaveDia, String(3 * 86400)]);
    } catch (e) {
      res.falhas++;
      await redis(['RPUSH', K('falhas'), JSON.stringify({ ...c, erro: e.message, em: new Date().toISOString() })]);
      if (res.erros.length < 3) res.erros.push(e.message);
      // limite da Meta (131048/131056/80007): para a rodada para não queimar o número
      if ([131048, 131056, 80007, 130429].includes(e.codigo)) { res.parou_por_limite_meta = true; break; }
    }
  }
  return res;
}

async function acaoStatus() {
  const [fila, enviados, falhas, hoje, pausada, preparadaEm] = await Promise.all([
    redis(['LLEN', K('fila')]),
    redis(['SCARD', K('enviados')]),
    redis(['LLEN', K('falhas')]),
    redis(['GET', K(`dia:${hojeBrasilia()}`)]),
    redis(['GET', K('pausada')]),
    redis(['GET', K('preparadaEm')])
  ]);
  const st = {
    campanha: CAMP(),
    ativa: process.env.CAMPANHA_ATIVA === 'sim' && !pausada,
    pausada: !!pausada,
    fim: process.env.CAMPANHA_FIM || null,
    fila_preparada_em: preparadaEm,
    na_fila: fila,
    enviadas_total: Number(enviados) - Number(falhas),
    enviadas_hoje: Number(hoje) || 0,
    limite_dia: Number(process.env.CAMPANHA_LIMITE_DIA || 250),
    falhas: falhas
  };
  // vendas com o cupom desde que a fila foi preparada
  const cupom = (process.env.CAMPANHA_CUPOM || '').toUpperCase();
  if (cupom && preparadaEm) {
    try {
      const desde = new Date(new Date(preparadaEm).getTime() - 24 * H).toISOString();
      const pedidos = await nsListar(`/orders?created_at_min=${encodeURIComponent(desde)}&fields=id,number,total,coupon,status,payment_status`, 10);
      const comCupom = pedidos.filter((p) => p.status !== 'cancelled' && ['paid', 'authorized'].includes(p.payment_status) &&
        (Array.isArray(p.coupon) ? p.coupon : [p.coupon]).some((c) => c && String(c.code || c).toUpperCase() === cupom));
      st.vendas_com_cupom = comCupom.length;
      st.faturamento_com_cupom = +comCupom.reduce((s, p) => s + Number(p.total || 0), 0).toFixed(2);
    } catch (e) { st.vendas_erro = e.message; }
  }
  return st;
}

/* ------------------------------ handler -------------------------------- */

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const chave = process.env.ADMIN_KEY || process.env.WEBHOOK_SECRET;
  if (!chave || url.searchParams.get('k') !== chave) return res.status(401).json({ erro: 'Chave inválida' });

  const acao = url.searchParams.get('acao') || 'status';
  const teste = url.searchParams.get('teste') === '1';
  const para = normalizarTelefone(url.searchParams.get('para'));
  try {
    let r;
    if (acao === 'cupom') r = await acaoCupom();
    else if (acao === 'preparar') r = await acaoPreparar(teste);
    else if (acao === 'enviar') r = await acaoEnviar(teste, para);
    else if (acao === 'pausar') { await redis(['SET', K('pausada'), '1']); r = { pausada: true }; }
    else if (acao === 'retomar') { await redis(['DEL', K('pausada')]); r = { pausada: false }; }
    else r = await acaoStatus();
    return res.status(200).json(r);
  } catch (e) {
    console.error('[campanha] FALHA:', e && e.message);
    return res.status(200).json({ erro: String(e && e.message) });
  }
}
