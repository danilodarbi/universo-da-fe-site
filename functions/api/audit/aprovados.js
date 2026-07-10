// functions/api/audit/aprovados.js
// GET /api/audit/aprovados?q=busca
// Lista todos os produtos aprovados com dados e foto, para visualização no admin.

import { jsonResponse, corsPreflight, requireAuth } from './_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  if (!requireAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = await env.DB.prepare(
      `SELECT id, file_name, drive_file_id, produto_identificado, titulo_recomendado,
              categoria, santo_devocao, material, cor, altura_valor, preco_valor,
              descricao_recomendada, imagem_editada_base64, shopify_product_id, updated_at
       FROM audit_records
       WHERE status = 'APROVADO'
         AND (produto_identificado LIKE ? OR titulo_recomendado LIKE ? OR santo_devocao LIKE ? OR categoria LIKE ?)
       ORDER BY updated_at DESC LIMIT 200`
    ).bind(like, like, like, like).all();
  } else {
    rows = await env.DB.prepare(
      `SELECT id, file_name, drive_file_id, produto_identificado, titulo_recomendado,
              categoria, santo_devocao, material, cor, altura_valor, preco_valor,
              descricao_recomendada, imagem_editada_base64, shopify_product_id, updated_at
       FROM audit_records
       WHERE status = 'APROVADO'
       ORDER BY updated_at DESC LIMIT 200`
    ).all();
  }

  const total = await env.DB.prepare(`SELECT COUNT(*) as n FROM audit_records WHERE status = 'APROVADO'`).first();

  // Não devolve o base64 inteiro na lista (pesado) — só um flag de que tem foto
  const items = (rows.results || []).map(r => ({
    ...r,
    tem_foto: !!r.imagem_editada_base64,
    imagem_editada_base64: undefined,
  }));

  return jsonResponse({ total: total?.n ?? 0, items });
}
