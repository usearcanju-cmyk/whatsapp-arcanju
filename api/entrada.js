/* ==========================================================================
   Use Arcanju — Mensagens recebidas no WhatsApp (webhook da Meta)
   Endpoint: /api/entrada

   O WhatsApp da Arcanju não é atendido por pessoas. Quando uma cliente responde:
     - "SAIR" / "PARAR" / "CANCELAR"  → para de receber lembretes e recebe a confirmação
     - qualquer outra mensagem       → resposta automática com o portal de suporte
       (no máximo 1 resposta automática a cada 12h por cliente, para não virar spam)

   Variáveis de ambiente (Vercel):
     META_VERIFY_TOKEN   → palavra secreta que você também coloca no painel da Meta
     WHATSAPP_TOKEN, WHATSAPP_PHONE_ID,
     UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
   ========================================================================== */

import { registrarStatus } from './_registro.js';

const SUPORTE = 'https://suporte.usearcanju.com.br/';
const LOJA = 'https://usearcanju.com.br/';

async function redis(comando) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando)
  });
  const j = await r.json();
  return j.result;
}

async function responderTexto(para, texto) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto, preview_url: false } })
  });
  if (!r.ok) console.error('[entrada] falha ao responder:', r.status, (await r.text()).slice(0, 300));
}

const PEDIU_SAIR = /^\s*(sair|parar|pare|cancelar|stop|descadastrar|n[aã]o quero)\b/i;

export default async function handler(req, res) {
  // 1) Verificação do webhook (a Meta chama uma vez, quando você salva a URL no painel)
  if (req.method === 'GET') {
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('hub.mode') === 'subscribe' &&
        u.searchParams.get('hub.verify_token') === process.env.META_VERIFY_TOKEN) {
      return res.status(200).send(u.searchParams.get('hub.challenge'));
    }
    return res.status(403).send('Token de verificação inválido');
  }
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const corpo = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const mudancas = ((corpo && corpo.entry) || []).flatMap((e) => e.changes || []);

    for (const m of mudancas) {
      // Avisos de entrega das mensagens que NÓS enviamos (enviada / entregue / lida / falhou)
      for (const st of (m.value && m.value.statuses) || []) await registrarStatus(st);

      const mensagens = (m.value && m.value.messages) || [];
      for (const msg of mensagens) {
        const de = msg.from;                                   // ex: 5537999999999
        const texto = (msg.text && msg.text.body) || (msg.button && msg.button.text) || '';
        console.log('[entrada] mensagem de', de, ':', texto.slice(0, 80));

        if (PEDIU_SAIR.test(texto)) {
          await redis(['SET', `optout:${de}`, String(Date.now())]);   // sem prazo: vale para sempre
          await responderTexto(de,
            'Pronto! Você não vai mais receber lembretes da Use Arcanju por aqui. 🙏\n\n' +
            'Os avisos do seu pedido (confirmação e rastreio) continuam chegando normalmente.');
          continue;
        }

        // resposta automática, no máximo 1 a cada 12h por pessoa
        const novo = await redis(['SET', `autoresp:${de}`, '1', 'EX', String(12 * 3600), 'NX']);
        if (novo === null && process.env.UPSTASH_REDIS_REST_URL) continue;

        await responderTexto(de,
          'Oi! Que bom falar com você 🙏\n\n' +
          'Este número envia apenas avisos automáticos e não é monitorado.\n\n' +
          `📦 Dúvidas sobre pedido, troca ou tamanho: ${SUPORTE}\n` +
          `🛍️ Ver a loja: ${LOJA}\n\n` +
          'Para não receber mais lembretes, responda SAIR.');
      }
    }
  } catch (e) {
    console.error('[entrada] erro:', e && e.message);
  }
  // sempre 200, senão a Meta fica reenviando
  return res.status(200).json({ ok: true });
}
