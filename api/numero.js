/* ==========================================================================
   Use Arcanju — Diagnóstico e registro do número na Cloud API do WhatsApp
   ARQUIVO DE MANUTENÇÃO: protegido pela variável ADMIN_KEY (na Vercel).

   Como usar, no navegador:
     .../api/numero?k=SUA_ADMIN_KEY                        → status do número
     .../api/numero?k=SUA_ADMIN_KEY&acao=pin&pin=123456       → define um PIN novo
     .../api/numero?k=SUA_ADMIN_KEY&acao=saude                → diagnóstico completo (por que não envia)
     .../api/numero?k=SUA_ADMIN_KEY&acao=pedircodigo          → pede código por SMS
     .../api/numero?k=SUA_ADMIN_KEY&acao=verificarcodigo&codigo=123456 → confirma o SMS
     Em qualquer ação, &id=PHONE_NUMBER_ID testa outro ID sem mexer na Vercel.
     .../api/numero?k=SUA_ADMIN_KEY&acao=registrar&pin=123456 → registra de novo
     .../api/numero?k=SUA_ADMIN_KEY&acao=teste&para=5537999999999 → envia o
        template de confirmação de teste para o número informado

   O "pin" é o PIN de 6 dígitos da verificação em duas etapas do número
   (WhatsApp Manager → Números de telefone → seu número → Verificação em duas etapas).
   ========================================================================== */

const VERSAO = 'v21.0';

async function graph(caminho, opcoes) {
  const r = await fetch(`https://graph.facebook.com/${VERSAO}/${caminho}`, Object.assign({
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, opcoes || {}));
  const corpo = await r.json().catch(() => ({}));
  return { status: r.status, corpo };
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const chave = process.env.ADMIN_KEY || process.env.WEBHOOK_SECRET;
  if (!chave || url.searchParams.get('k') !== chave) {
    return res.status(401).json({ erro: 'Chave inválida' });
  }
  // &id= permite testar outro Phone Number ID sem mexer na Vercel
  const idUrl = (url.searchParams.get('id') || '').replace(/\D/g, '');
  const phoneId = idUrl || process.env.WHATSAPP_PHONE_ID;
  if (!phoneId || !process.env.WHATSAPP_TOKEN) {
    return res.status(500).json({ erro: 'WHATSAPP_PHONE_ID ou WHATSAPP_TOKEN não configurado na Vercel' });
  }

  const acao = url.searchParams.get('acao') || 'status';

  try {
    if (acao === 'registrar') {
      const pin = (url.searchParams.get('pin') || '').trim();
      if (!/^\d{6}$/.test(pin)) return res.status(400).json({ erro: 'Informe &pin= com 6 dígitos' });
      const r = await graph(`${phoneId}/register`, {
        method: 'POST',
        body: JSON.stringify({ messaging_product: 'whatsapp', pin })
      });
      return res.status(200).json({ acao: 'registrar', ok: r.corpo && r.corpo.success === true, resposta: r });
    }

    if (acao === 'saude') {
      // Pergunta para a Meta POR QUE o número não pode enviar
      const waba = (url.searchParams.get('waba') || '2005404373440744').replace(/\D/g, '');
      const numero = await graph(`${phoneId}?fields=health_status,status,platform_type,name_status,new_name_status,code_verification_status,account_mode,throughput,is_official_business_account`);
      const conta = await graph(`${waba}?fields=name,account_review_status,business_verification_status,health_status,ownership_type,primary_business_location`);
      return res.status(200).json({ acao: 'saude', phoneId, waba, numero, conta });
    }

    if (acao === 'pedircodigo') {
      // Envia um código por SMS para o número do WhatsApp (só se a Meta exigir verificação)
      const r = await graph(`${phoneId}/request_code`, {
        method: 'POST',
        body: JSON.stringify({ code_method: (url.searchParams.get('metodo') || 'SMS').toUpperCase() === 'VOICE' ? 'VOICE' : 'SMS', language: 'pt_BR' })
      });
      return res.status(200).json({ acao: 'pedircodigo', phoneId, ok: r.corpo && r.corpo.success === true, resposta: r });
    }

    if (acao === 'verificarcodigo') {
      const codigo = (url.searchParams.get('codigo') || '').replace(/\D/g, '');
      if (!codigo) return res.status(400).json({ erro: 'Informe &codigo= que chegou por SMS' });
      const r = await graph(`${phoneId}/verify_code`, {
        method: 'POST',
        body: JSON.stringify({ code: codigo })
      });
      return res.status(200).json({ acao: 'verificarcodigo', phoneId, ok: r.corpo && r.corpo.success === true, resposta: r });
    }

    if (acao === 'pin') {
      // Define (ou troca) o PIN da verificação em duas etapas do número
      const pin = (url.searchParams.get('pin') || '').trim();
      if (!/^\d{6}$/.test(pin)) return res.status(400).json({ erro: 'Informe &pin= com 6 dígitos' });
      const r = await graph(`${phoneId}`, {
        method: 'POST',
        body: JSON.stringify({ pin })
      });
      return res.status(200).json({ acao: 'pin', ok: r.corpo && r.corpo.success === true, resposta: r });
    }

    if (acao === 'teste') {
      const para = (url.searchParams.get('para') || '').replace(/\D/g, '');
      if (!para) return res.status(400).json({ erro: 'Informe &para=55DDNUMERO' });
      const r = await graph(`${phoneId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: para,
          type: 'template',
          template: {
            name: process.env.TEMPLATE_CONFIRMACAO,
            language: { code: 'pt_BR' },
            components: [{ type: 'body', parameters: [
              { type: 'text', text: 'Mateus' },
              { type: 'text', text: 'TESTE' },
              { type: 'text', text: 'teste@usearcanju.com.br' }
            ] }]
          }
        })
      });
      return res.status(200).json({ acao: 'teste', ok: r.status === 200, resposta: r });
    }

    // status
    const r = await graph(`${phoneId}?fields=display_phone_number,verified_name,status,platform_type,quality_rating,code_verification_status,name_status,messaging_limit_tier`);
    return res.status(200).json({
      acao: 'status',
      phoneId_usado: phoneId,
      phoneId_da_vercel: process.env.WHATSAPP_PHONE_ID,
      leitura: {
        'platform_type = CLOUD_API': 'número registrado e pronto para enviar',
        'platform_type = NOT_APPLICABLE': 'número NÃO registrado → use acao=registrar',
        'status = CONNECTED': 'conectado'
      },
      numero: r
    });
  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
}
