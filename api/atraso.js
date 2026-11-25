/* ==========================================================================
   Use Arcanju — Aviso de pedido atrasado (WhatsApp)
   Endpoint: GET /api/atraso?k=ADMIN_KEY
   Chamado 1x por dia (ex.: 10h) por um agendador (cron-job.org).

   Regra:
     - Pega os pedidos PAGOS dos últimos 60 dias que ainda NÃO foram enviados.
     - O prazo de cada pedido vem do frete que o próprio cliente escolheu,
       ex.: "Frete Econômico para: Acre (12 até 16 dias úteis)".
     - Prazo = data do pagamento + N dias úteis (N = o menor número, "12",
       ou o maior, "16", conforme PRAZO_USAR). Sábado, domingo e feriados
       nacionais não contam.
     - Se hoje já passou do prazo e o pedido não foi enviado → manda o aviso.
     - Cada pedido recebe o aviso UMA ÚNICA VEZ (registro no Upstash Redis).
     - Só envia de segunda a quarta-feira, porque a mensagem promete
       "devem sair ainda nesta semana". Atrasos de quinta/sexta saem na segunda.
     - Modo teste: &teste=1 mostra o que faria, sem enviar.
       &teste=1&para=5537999999999 manda 1 exemplo só para esse número.

   Variáveis de ambiente (Vercel):
     ADMIN_KEY, NUVEMSHOP_ACCESS_TOKEN, NUVEMSHOP_STORE_ID,
     WHATSAPP_TOKEN, WHATSAPP_PHONE_ID,
     UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
     TEMPLATE_ATRASO   (ex: pedido_atrasado)
     ATRASO_ATIVO      (padrão "nao") → só envia de verdade quando for "sim"
     PRAZO_USAR        (padrão "min") → "min" usa o menor número do prazo,
                                         "max" usa o maior
   ========================================================================== */

import { registrarEnvio } from './_registro.js';
const H = 3600 * 1000;
const DIA = 24 * H;
const JANELA_DIAS = 60;

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

// Data "AAAA-MM-DD" no horário de Brasília (UTC-3)
function diaBrasilia(ms) { return new Date(ms - 3 * H).toISOString().slice(0, 10); }
function diaSemana(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); } // 0 = domingo
function somarDias(iso, n) { return new Date(new Date(iso + 'T12:00:00Z').getTime() + n * DIA).toISOString().slice(0, 10); }

// Domingo de Páscoa (algoritmo de Meeus)
function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

const cacheFeriados = {};
function feriados(ano) {
  if (cacheFeriados[ano]) return cacheFeriados[ano];
  const fixos = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].map((d) => `${ano}-${d}`);
  const p = pascoa(ano);
  const moveis = [somarDias(p, -48), somarDias(p, -47), somarDias(p, -2), somarDias(p, 60)]; // carnaval (2 dias), sexta-feira santa, corpus christi
  return (cacheFeriados[ano] = new Set([...fixos, ...moveis]));
}
function diaUtil(iso) {
  const s = diaSemana(iso);
  return s !== 0 && s !== 6 && !feriados(+iso.slice(0, 4)).has(iso);
}
// Data em que vence o prazo: N dias úteis depois do pagamento
function somarDiasUteis(iso, n) {
  let d = iso, contados = 0;
  while (contados < n) { d = somarDias(d, 1); if (diaUtil(d)) contados++; }
  return d;
}

// Lê o prazo do frete escolhido no pedido
function prazoDoPedido(p, usar) {
  const min = parseInt(p.shipping_min_days, 10);
  const max = parseInt(p.shipping_max_days, 10);
  if (min > 0 || max > 0) return usar === 'max' ? (max || min) : (min || max);
  const nome = String(p.shipping_option || '');
  const m = nome.match(/(\d+)\s*(?:até|a|-)\s*(\d+)\s*dias/i) || nome.match(/(\d+)\s*dias/i);
  if (!m) return null;
  const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
  return usar === 'max' ? b : a;
}

function foiEnviado(p) {
  if (p.shipped_at) return true;
  return ['shipped', 'fulfilled', 'delivered'].includes(String(p.shipping_status || '').toLowerCase());
}

/* ------------------------------ Upstash Redis ---------------------------- */

async function redis(comando) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando)
  });
  const j = await r.json();
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}
const temRedis = () => !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const jaAvisado = async (id) => (temRedis() ? (await redis(['GET', `atraso:${id}`])) !== null : false);
const marcarAvisado = (id) => redis(['SET', `atraso:${id}`, String(Date.now()), 'EX', String(90 * 86400)]);

/* ------------------------------ Nuvemshop ------------------------------- */

async function nsListar(caminho, paginasMax) {
  const todos = [];
  for (let page = 1; page <= (paginasMax || 10); page++) {
    const sep = caminho.includes('?') ? '&' : '?';
    const r = await fetch(`https://api.tiendanube.com/v1/${process.env.NUVEMSHOP_STORE_ID}${caminho}${sep}per_page=100&page=${page}`, {
      headers: {
        'Authentication': `bearer ${process.env.NUVEMSHOP_ACCESS_TOKEN}`,
        'User-Agent': 'Use Arcanju (contato@usearcanju.com.br)',
        'Content-Type': 'application/json'
      }
    });
    if (r.status === 404) break;
    if (!r.ok) throw new Error(`Nuvemshop ${caminho} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const lote = await r.json();
    if (!Array.isArray(lote) || !lote.length) break;
    todos.push(...lote);
    if (lote.length < 100) break;
  }
  return todos;
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

  const teste = url.searchParams.get('teste') === '1' || process.env.ATRASO_ATIVO !== 'sim';
  const paraForcado = normalizarTelefone(url.searchParams.get('para'));
  const usar = (process.env.PRAZO_USAR || 'min').toLowerCase() === 'max' ? 'max' : 'min';
  const hoje = diaBrasilia(Date.now());
  const semana = diaSemana(hoje);
  const diaDeEnviar = semana >= 1 && semana <= 3; // segunda a quarta

  if (!teste && !temRedis()) return res.status(500).json({ erro: 'Configure o Upstash Redis antes de ativar (evita avisos duplicados)' });
  if (!teste && !process.env.TEMPLATE_ATRASO) return res.status(500).json({ erro: 'Configure TEMPLATE_ATRASO na Vercel' });

  const relatorio = { modo: teste ? 'TESTE (nada enviado)' : 'ATIVO', hoje, dia_de_enviar: diaDeEnviar, prazo_usado: usar, atrasados: [], ignorados: 0 };
  let exemploEnviado = false;

  try {
    const desde = new Date(Date.now() - JANELA_DIAS * DIA).toISOString();
    const pedidos = await nsListar(`/orders?payment_status=paid&created_at_min=${encodeURIComponent(desde)}`, 10);
    relatorio.pedidos_pagos = pedidos.length;

    for (const p of pedidos) {
      if (p.status === 'cancelled' || foiEnviado(p)) { relatorio.ignorados++; continue; }

      const dias = prazoDoPedido(p, usar);
      const pagoEm = diaBrasilia(new Date(p.paid_at || p.created_at).getTime());
      const base = { pedido: p.number, nome: primeiroNome(p.contact_name || (p.customer && p.customer.name)), pago_em: pagoEm, frete: p.shipping_option || '—' };

      if (!dias) { relatorio.atrasados.push({ ...base, acao: 'sem prazo no frete — conferir à mão' }); continue; }
      const vence = somarDiasUteis(pagoEm, dias);
      if (hoje <= vence) { relatorio.ignorados++; continue; }           // ainda dentro do prazo

      const telefone = normalizarTelefone(p.contact_phone || (p.customer && p.customer.phone) || (p.shipping_address && p.shipping_address.phone));
      const registro = { ...base, prazo_dias_uteis: dias, venceu_em: vence };

      if (!telefone) { relatorio.atrasados.push({ ...registro, acao: 'sem telefone válido' }); continue; }
      if (await jaAvisado(p.id)) { relatorio.atrasados.push({ ...registro, acao: 'já avisado antes' }); continue; }
      if (!diaDeEnviar) { relatorio.atrasados.push({ ...registro, acao: 'atrasado — aviso sai na segunda-feira' }); continue; }

      if (!teste) {
        await marcarAvisado(p.id);                                     // marca antes: nunca duplica
        await enviarTemplate(telefone, process.env.TEMPLATE_ATRASO, [base.nome, String(p.number)]);
        relatorio.atrasados.push({ ...registro, acao: 'AVISO ENVIADO', para: telefone });
      } else {
        if (paraForcado && !exemploEnviado && process.env.TEMPLATE_ATRASO) {
          await enviarTemplate(paraForcado, process.env.TEMPLATE_ATRASO, [base.nome, String(p.number)]);
          exemploEnviado = true;
        }
        relatorio.atrasados.push({ ...registro, acao: 'aviso (simulado)', para: telefone });
      }
    }

    return res.status(200).json(relatorio);
  } catch (e) {
    console.error('[atraso] FALHA:', e && e.message);
    return res.status(200).json({ ...relatorio, erro: String(e && e.message) });
  }
}
