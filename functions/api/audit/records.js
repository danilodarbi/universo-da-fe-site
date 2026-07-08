// functions/api/audit/records.js
// GET /api/audit/records                  → contagens por status
// GET /api/audit/records?status=REPROVADO → itens desse status (paginado)
// GET /api/audit/records?status=REPROVADO&limit=20&offset=0

import { jsonResponse, corsPreflight, requireAuth } from './_shared.js';

const VALID_STATUS = new Set([
  'PENDENTE','ANALISANDO','PRONTO_PARA_REVISAO','APROVADO',
  'REPROVADO','PRECISA_DE_NOVA_FOTO','PRECISA_DE_AJUSTE','ERRO',
]);

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  if (!requireAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const itemId = url.searchParams.get('item_id');

  // Busca um único item por id (para refresh de card em qualquer aba)
  if (itemId) {
    const item = await env.DB.prepare(`SELECT * FROM audit_records WHERE id = ?`).bind(itemId).first();
    return jsonResponse({ item: item || null });
  }

  const limit  = Math.min(Number(url.searchParams.get('limit')  || 24), 50);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  // Sem status: retorna contagens globais por status
  if (!status) {
    const rows = await env.DB.prepare(
      `SELECT status, COUNT(*) as n FROM audit_records GROUP BY status`
    ).all();
    const counts = {};
    for (const r of (rows.results || [])) counts[r.status] = r.n;
    const total = await env.DB.prepare(`SELECT COUNT(*) as n FROM audit_records`).first();
    return jsonResponse({ counts, total: total?.n ?? 0 });
  }

  if (!VALID_STATUS.has(status)) return jsonResponse({ error: 'status inválido' }, 400);

  const items = await env.DB.prepare(
    `SELECT * FROM audit_records WHERE status = ? ORDER BY sort_key ASC LIMIT ? OFFSET ?`
  ).bind(status, limit, offset).all();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM audit_records WHERE status = ?`
  ).bind(status).first();

  return jsonResponse({
    status,
    total: total?.n ?? 0,
    offset,
    limit,
    items: items.results || [],
  });
}
