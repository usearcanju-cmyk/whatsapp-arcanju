/* ==========================================================================
   Use Arcanju — Avisos automáticos no WhatsApp
   Recebe webhooks da Nuvemshop e envia mensagens pela Cloud API do Meta.
   Endpoint: POST /api/webhook
   ========================================================================== */

import crypto from 'crypto';

/* --------------------------------------------------------------------------
   Variáveis de ambiente (configurar na Vercel):
   WEBHOOK_SECRET           → chave secreta na URL, valida a origem do webhook
   NUVEMSHOP_CLIENT_SECRET  → (opcional) segredo do app, se existir valida por HMAC
   NUVEMSHOP_ACCESS_TOKEN   → token da sua loja na Nuvemshop
   NUVEMSHOP_STORE_ID       → id numérico da loja
   WHATSAPP_TOKEN           → token permanente da Cloud API
   WHATSAPP_PHONE_ID        → id do número remetente (Phone Number ID)
   TEMPLATE_CONFIRMACAO     → nome do template aprovado (ex: pedido_confirmado)
   TEMPLATE_ENVIO           → nome do template aprovado (ex: pedido_enviado)
   -------------------------------------------------------------------------- */

export const config = { api: { bodyParser: false } };

/* ------------------------------ utilidades ------------------------------ */

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let dados = '';
    req.on('data', (p) => { dados += p; });
    req.on('end', () => resolve(dados));
    req.on('error', reject);
  });
}

// Confirma que o webhook veio mesmo da Nuvemshop
function assinaturaValida(corpoBruto, assinatura) {
  const segredo = process.env.NUVEMSHOP_CLIENT_SECRET;
  if (!segredo || !assinatura) return false;
  const esperado = crypto.createHmac('sha256', segredo).update(corpoBruto, 'utf8').digest('hex');
  const a = Buffer.from(esperado);
  const b = Buffer.from(assinatura);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Normaliza o telefone para o formato que a Meta espera: 55DDNNNNNNNNN
   Trata os casos brasileiros: com/sem +55, com/sem o nono dígito,
   com parênteses, traços e espaços. */
function normalizarTelefone(bruto) {
  if (!bruto) return null;
  let n = String(bruto).replace(/\D/g, '');

  if (n.startsWith('55') && n.length >= 12) n = n.slice(2);   // tira o país
  if (n.startsWith('0')) n = n.replace(/^0+/, '');            // tira zeros à esquerda

  if (n.length === 10) {                                      // fixo ou celular antigo
    const ddd = n.slice(0, 2);
    const numero = n.slice(2);
    n = numero.length === 8 && /^[6-9]/.test(numero) ? ddd + '9' + numero : n;
  }

  if (n.length !== 10 && n.length !== 11) return null;
  return '55' + n;
}

function primeiroNome(nomeCompleto) {
  if (!nomeCompleto) return 'tudo bem';
  return String(nomeCompleto).trim().split(/\s+/)[0];
}

/* ---------------------------- Nuvemshop API ---------------------------- */

async function buscarPedido(orderId) {
  const token = process.env.NUVEMSHOP_ACCESS_TOKEN;
  const loja = process.env.NUVEMSHOP_STORE_ID;

  if (!token) throw new Error('NUVEMSHOP_ACCESS_TOKEN não está configurado na Vercel');
  if (!loja) throw new Error('NUVEMSHOP_STORE_ID não está configurado na Vercel');
  console.log('[arcanju] loja:', loja, '| token termina em:', token.slice(-4));

  // Alguns apps autenticam com "Authentication: bearer", outros com
  // "Authorization: Bearer". Tentamos os dois antes de desistir.
  const tentativas = [
    { nome: 'Authentication/bearer', headers: { 'Authentication': `bearer ${token}` } },
    { nome: 'Authorization/Bearer',  headers: { 'Authorization': `Bearer ${token}` } }
  ];

  const url = `https://api.tiendanube.com/v1/${loja}/orders/${orderId}`;
  let ultimoErro = '';

  for (const t of tentativas) {
    const r = await fetch(url, {
      headers: Object.assign({
        'User-Agent': 'Use Arcanju (contato@usearcanju.com.br)',
        'Content-Type': 'application/json'
      }, t.headers)
    });

    if (r.ok) {
      console.log('[arcanju] Nuvemshop OK via', t.nome);
      return r.json();
    }

    ultimoErro = `${t.nome} → HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`;
    console.warn('[arcanju] Nuvemshop falhou:', ultimoErro);
  }

  throw new Error('Nuvemshop recusou as duas formas de autenticação. ' + ultimoErro);
}

/* ----------------------------- WhatsApp API ----------------------------- */

async function enviarTemplate(telefone, template, parametros) {
  if (!process.env.WHATSAPP_TOKEN) throw new Error('WHATSAPP_TOKEN não configurado');
  if (!process.env.WHATSAPP_PHONE_ID) throw new Error('WHATSAPP_PHONE_ID não configurado');
  if (!template) throw new Error('Nome do template não configurado (TEMPLATE_*)');
  console.log('[arcanju] enviando template', template, 'para', telefone);

  const url = `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
  const corpo = {
    messaging_product: 'whatsapp',
    to: telefone,
    type: 'template',
    template: {
      name: template,
      language: { code: 'pt_BR' },
      components: [
        {
          type: 'body',
          parameters: parametros.map((t) => ({ type: 'text', text: String(t) }))
        }
      ]
    }
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(corpo)
  });

  const resposta = await r.json();
  if (!r.ok) throw new Error(`WhatsApp ${r.status}: ${JSON.stringify(resposta)}`);
  return resposta;
}

/* ------------------------------ handler -------------------------------- */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Use POST' });
  }

  let corpoBruto;
  try {
    corpoBruto = await lerCorpo(req);
  } catch (e) {
    return res.status(400).json({ erro: 'Corpo ilegível' });
  }

  // Validação da origem: por chave na URL e/ou por assinatura HMAC
  const segredoUrl = process.env.WEBHOOK_SECRET;
  const chaveRecebida = new URL(req.url, 'http://x').searchParams.get('k');
  const assinatura = req.headers['x-linkedstore-hmac-sha256'];

  const passouPelaChave = segredoUrl && chaveRecebida === segredoUrl;
  const passouPeloHmac = assinaturaValida(corpoBruto, assinatura);

  if (!passouPelaChave && !passouPeloHmac) {
    console.warn('[arcanju] origem não verificada — requisição ignorada');
    return res.status(401).json({ erro: 'Não autorizado' });
  }

  let evento;
  try {
    evento = JSON.parse(corpoBruto);
  } catch (e) {
    return res.status(400).json({ erro: 'JSON inválido' });
  }

  console.log('[arcanju] evento recebido:', JSON.stringify(evento));

  // Responde rápido: a Nuvemshop espera retorno em poucos segundos
  res.status(200).json({ ok: true });

  try {
    await processar(evento);
  } catch (e) {
    console.error('[arcanju] FALHA:', e && e.message ? e.message : e);
    if (e && e.stack) console.error('[arcanju] stack:', e.stack);
  }
}

async function processar(evento) {
  const tipo = evento.event;
  if (tipo !== 'order/paid' && tipo !== 'order/fulfilled') {
    console.log('[arcanju] evento ignorado (não é paid nem fulfilled):', tipo);
    return;
  }

  console.log('[arcanju] buscando pedido', evento.id);
  const pedido = await buscarPedido(evento.id);
  console.log('[arcanju] pedido', pedido.number,
    '| telefone bruto:', pedido.contact_phone,
    '| customer.phone:', pedido.customer && pedido.customer.phone);

  const telefone = normalizarTelefone(
    pedido.contact_phone ||
    (pedido.customer && pedido.customer.phone) ||
    (pedido.shipping_address && pedido.shipping_address.phone)
  );

  if (!telefone) {
    console.warn('[arcanju] pedido', pedido.number, 'SEM TELEFONE VÁLIDO — nada enviado');
    return;
  }
  console.log('[arcanju] telefone normalizado:', telefone);

  const nome = primeiroNome(
    pedido.contact_name || (pedido.customer && pedido.customer.name)
  );
  const email = pedido.contact_email || (pedido.customer && pedido.customer.email) || '—';
  const numero = String(pedido.number || evento.id);

  if (tipo === 'order/paid') {
    await enviarTemplate(telefone, process.env.TEMPLATE_CONFIRMACAO, [
      nome,      // {{1}} primeiro nome
      numero,    // {{2}} número do pedido
      email      // {{3}} e-mail da compra
    ]);
    console.log('[arcanju] confirmação enviada — pedido', numero);
    return;
  }

  // order/fulfilled — pedido marcado como enviado
  // O template usa 4 variáveis: a {{4}} recebe o link de rastreio completo
  const linkRastreio =
    pedido.shipping_tracking_url ||
    (pedido.shipping_tracking_number
      ? `https://www.linkcorreios.com.br/?id=${pedido.shipping_tracking_number}`
      : 'https://suporte.usearcanju.com.br/');

  await enviarTemplate(telefone, process.env.TEMPLATE_ENVIO, [
    nome,          // {{1}} primeiro nome
    numero,        // {{2}} número do pedido
    email,         // {{3}} e-mail da compra
    linkRastreio   // {{4}} link de rastreio
  ]);
  console.log('[arcanju] aviso de envio — pedido', numero);
}
