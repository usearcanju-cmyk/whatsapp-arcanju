/* Página para conferir se as mensagens chegaram no WhatsApp das clientes.
   Abrir: https://whatsapp-arcanju.vercel.app/api/envios?k=SUA_ADMIN_KEY   */

import { listarEnvios } from './_registro.js';

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hora = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const SELO = {
  enviada: ['✓ Enviada', '#8A7867', 'Saiu do nosso número; ainda não chegou no celular dela (celular desligado ou sem internet).'],
  entregue: ['✓✓ Entregue', '#2F6B3B', 'Chegou no WhatsApp dela.'],
  lida: ['✓✓ Lida', '#1D6FD1', 'Ela abriu a mensagem.'],
  falhou: ['✕ Falhou', '#A3271F', 'Não foi entregue.']
};

export default async function handler(req, res) {
  const chave = process.env.ADMIN_KEY || process.env.WEBHOOK_SECRET;
  const k = new URL(req.url, 'http://x').searchParams.get('k');
  if (!chave || k !== chave) return res.status(401).send('Não autorizado');

  const envios = await listarEnvios(200);
  const linhas = envios.map((e) => {
    const [rot, cor, dica] = SELO[e.status] || [e.status, '#555', ''];
    const quando = e.lidaEm || e.entregueEm || e.enviadoEm;
    return `<tr>
      <td>${hora(e.enviadoEm)}</td>
      <td><strong>${esc(e.tipo)}</strong>${e.pedido ? `<br><small>pedido #${esc(e.pedido)}</small>` : ''}</td>
      <td>${esc(e.nome)}<br><small>${esc(e.telefone)}</small></td>
      <td><span title="${esc(dica)}" style="color:${cor};font-weight:600">${rot}</span>
        <br><small>${e.status === 'falhou' ? esc(e.erro || '') : hora(quando)}</small></td>
    </tr>`;
  }).join('');

  const cont = (s) => envios.filter((e) => e.status === s).length;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Envios do WhatsApp — Use Arcanju</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;background:#F3ECE2;color:#2B211A;margin:0;padding:20px}
  h1{font-family:Georgia,serif;color:#6B1A22;font-weight:normal;margin:0 0 6px}
  .resumo{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
  .resumo div{background:#fff;border:1px solid #E6D8C6;border-radius:10px;padding:10px 14px;font-size:14px}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #E6D8C6}
  td,th{padding:10px 12px;border-bottom:1px solid #F0E6D8;font-size:14px;text-align:left;vertical-align:top}
  th{background:#F8F1E7;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8A7867}
  small{color:#8A7867}
  p.ajuda{font-size:13px;color:#8A7867;max-width:720px}
</style></head><body>
<h1>Envios do WhatsApp</h1>
<p class="ajuda">✓ Enviada = saiu do nosso número · ✓✓ Entregue = chegou no celular dela · ✓✓ Lida = ela abriu
(só aparece se ela deixa a confirmação de leitura ligada) · ✕ Falhou = não chegou (passe o mouse para ver o motivo).
Registra as mensagens enviadas a partir de 25/11/2026.</p>
<div class="resumo"><div>Total: <strong>${envios.length}</strong></div><div>Entregues: <strong>${cont('entregue')}</strong></div>
<div>Lidas: <strong>${cont('lida')}</strong></div><div>Só enviadas: <strong>${cont('enviada')}</strong></div>
<div>Falharam: <strong>${cont('falhou')}</strong></div></div>
<table><thead><tr><th>Quando</th><th>Mensagem</th><th>Cliente</th><th>Situação</th></tr></thead>
<tbody>${linhas || '<tr><td colspan="4">Nenhum envio registrado ainda.</td></tr>'}</tbody></table>
</body></html>`);
}
