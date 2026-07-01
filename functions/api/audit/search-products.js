// functions/api/audit/search-products.js
// GET /api/audit/search-products?q=sao+bento
// Busca produtos no shopify_products_cache por similaridade de texto.
// Usado pelo modal de edição na tela de auditoria.

import { jsonResponse, corsPreflight, requireAuth, normalizeTitle, topCandidates } from './_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  if (!requireAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (!q || q.length < 2) {
    // Sem query: retorna primeiros 20 produtos ordenados por título
    const rows = await env.DB.prepare(
      `SELECT product_id, title, product_type, status FROM shopify_products_cache ORDER BY title ASC LIMIT 20`
    ).all();
    return jsonResponse({ products: rows.results || [] });
  }

  const rows = await env.DB.prepare(
    `SELECT product_id, title, product_type, status FROM shopify_products_cache`
  ).all();

  const matches = topCandidates(q, rows.results || [], 10);

  // Se topCandidates retornar vazio (sem tokens comuns), faz LIKE simples
  if (matches.length === 0) {
    const norm = normalizeTitle(q);
    const words = norm.split(' ').filter(w => w.length > 2);
    const likeClause = words.map(() => `title_normalized LIKE ?`).join(' OR ');
    if (words.length > 0) {
      const likeRes = await env.DB.prepare(
        `SELECT product_id, title, product_type, status FROM shopify_products_cache
         WHERE ${likeClause} LIMIT 10`
      ).bind(...words.map(w => `%${w}%`)).all();
      return jsonResponse({ products: likeRes.results || [] });
    }
  }

  return jsonResponse({
    products: matches.map(m => ({
      product_id: m.product_id,
      title: m.title,
      product_type: m.product_type,
      status: m.status,
      score: Math.round((m.score || 0) * 100),
    })),
  });
}
