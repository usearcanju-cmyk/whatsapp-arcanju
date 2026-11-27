/* Registro de cada mensagem enviada + o que o WhatsApp diz que aconteceu com ela
   (enviada → entregue → lida, ou falhou). Arquivo com "_" não vira rota na Vercel. */

async function redis(comando) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando)
  });
  const j = await r.json().catch(() => ({}));
  return j.result;
}

const NOMES = () => ({
  [process.env.TEMPLATE_CONFIRMACAO]: 'Pedido confirmado',
  [process.env.TEMPLATE_ENVIO]: 'Pedido enviado',
  [process.env.TEMPLATE_ATRASO]: 'Pedido atrasado',
  [process.env.TEMPLATE_CARRINHO_1]: 'Carrinho (lembrete)',
  [process.env.TEMPLATE_CARRINHO_2]: 'Carrinho (cupom)',
  [process.env.TEMPLATE_CAMPANHA]: 'Campanha (' + (process.env.CAMPANHA_ID || 'massa') + ')'
});

const ORDEM = { enviada: 1, entregue: 2, lida: 3 };
const TRADUZ = { sent: 'enviada', delivered: 'entregue', read: 'lida', failed: 'falhou' };
const DIAS_90 = String(90 * 86400);

/* Chamado logo depois que a Meta aceita o envio. Nunca derruba o envio se der erro. */
export async function registrarEnvio(respostaMeta, template, telefone, parametros) {
  try {
    const id = respostaMeta && respostaMeta.messages && respostaMeta.messages[0] && respostaMeta.messages[0].id;
    if (!id) return;
    const tel = String(telefone || '');
    const p = parametros || [];
    const ehPedido = [process.env.TEMPLATE_CONFIRMACAO, process.env.TEMPLATE_ENVIO, process.env.TEMPLATE_ATRASO].includes(template);
    const reg = {
      id,
      tipo: NOMES()[template] || template,
      pedido: ehPedido ? String(p[1] || '') : '',
      nome: String(p[0] || ''),
      telefone: tel.length > 4 ? '•••' + tel.slice(-4) : tel,
      enviadoEm: new Date().toISOString(),
      status: 'enviada',
      historico: [{ status: 'aceita pela Meta', em: new Date().toISOString() }]
    };
    await redis(['SET', `wa:msg:${id}`, JSON.stringify(reg), 'EX', DIAS_90]);
    await redis(['LPUSH', 'wa:envios', id]);
    await redis(['LTRIM', 'wa:envios', '0', '499']);
  } catch (e) {
    console.error('[registro] falha ao registrar envio:', e && e.message);
  }
}

/* Chamado pelo webhook da Meta (/api/entrada) para cada "status" recebido */
export async function registrarStatus(st) {
  try {
    const bruto = await redis(['GET', `wa:msg:${st.id}`]);
    if (!bruto) return; // mensagem enviada antes de existir o registro
    const reg = JSON.parse(bruto);
    const novo = TRADUZ[st.status] || st.status;
    const em = st.timestamp ? new Date(Number(st.timestamp) * 1000).toISOString() : new Date().toISOString();
    reg.historico = [...(reg.historico || []), { status: novo, em }];
    if (novo === 'falhou') {
      reg.status = 'falhou';
      const e = (st.errors || [])[0] || {};
      reg.erro = [e.code, e.title, e.error_data && e.error_data.details].filter(Boolean).join(' · ');
    } else if (reg.status !== 'falhou' && (ORDEM[novo] || 0) > (ORDEM[reg.status] || 0)) {
      reg.status = novo;
      reg[novo + 'Em'] = em;
    }
    await redis(['SET', `wa:msg:${st.id}`, JSON.stringify(reg), 'EX', DIAS_90]);
  } catch (e) {
    console.error('[registro] falha ao registrar status:', e && e.message);
  }
}

export async function listarEnvios(limite = 150) {
  const ids = (await redis(['LRANGE', 'wa:envios', '0', String(limite - 1)])) || [];
  if (!ids.length) return [];
  const vals = (await redis(['MGET', ...ids.map((i) => `wa:msg:${i}`)])) || [];
  return vals.map((v) => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
}
