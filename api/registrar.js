/* ==========================================================================
   Use Arcanju — Registro dos webhooks da Nuvemshop
   ARQUIVO TEMPORÁRIO: use uma vez e apague do repositório depois.

   Como usar, no navegador:
     .../api/registrar?k=SUA_WEBHOOK_SECRET            → lista os webhooks
     .../api/registrar?k=SUA_WEBHOOK_SECRET&acao=criar → cria os dois
     .../api/registrar?k=SUA_WEBHOOK_SECRET&acao=limpar&id=123 → apaga um
   ========================================================================== */

const EVENTOS = ['order/paid', 'order/fulfilled'];

function cabecalhos() {
  return {
    'Authentication': `bearer ${process.env.NUVEMSHOP_ACCESS_TOKEN}`,
    'User-Agent': 'Use Arcanju (contato@usearcanju.com.br)',
    'Content-Type': 'application/json'
  };
}

function base() {
  return `https://api.tiendanube.com/v1/${process.env.NUVEMSHOP_STORE_ID}/webhooks`;
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const chave = url.searchParams.get('k');
  const acao = url.searchParams.get('acao') || 'listar';

  if (!process.env.WEBHOOK_SECRET || chave !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ erro: 'Chave inválida' });
  }

  const destino =
    `https://${req.headers.host}/api/webhook?k=${process.env.WEBHOOK_SECRET}`;

  try {
    if (acao === 'criar') {
      const resultados = [];
      for (const evento of EVENTOS) {
        const r = await fetch(base(), {
          method: 'POST',
          headers: cabecalhos(),
          body: JSON.stringify({ event: evento, url: destino })
        });
        resultados.push({ evento, status: r.status, resposta: await r.json() });
      }
      return res.status(200).json({ acao: 'criar', destino, resultados });
    }

    if (acao === 'limpar') {
      const id = url.searchParams.get('id');
      if (!id) return res.status(400).json({ erro: 'Informe &id=' });
      const r = await fetch(`${base()}/${id}`, {
        method: 'DELETE',
        headers: cabecalhos()
      });
      return res.status(200).json({ acao: 'limpar', id, status: r.status });
    }

    // listar
    const r = await fetch(base(), { headers: cabecalhos() });
    const lista = await r.json();
    return res.status(200).json({
      acao: 'listar',
      destinoEsperado: destino,
      total: Array.isArray(lista) ? lista.length : 0,
      webhooks: lista
    });
  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
}
