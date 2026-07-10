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
  const fonte = url.searchParams.get('fonte') || 'todos'; // todos | site | shopify
  const categoria = url.searchParams.get('categoria') || '';

  const like = q ? `%${q}%` : null;

  // 1. Produtos aprovados no site (auditoria)
  let siteItems = [];
  if (fonte === 'todos' || fonte === 'site') {
    let sql = `SELECT id, file_name, drive_file_id, produto_identificado, titulo_recomendado,
              categoria, santo_devocao, material, cor, altura_valor, preco_valor,
              descricao_recomendada, imagem_editada_base64, shopify_product_id, updated_at
       FROM audit_records WHERE status = 'APROVADO'`;
    const binds = [];
    if (categoria) { sql += ` AND categoria = ?`; binds.push(categoria); }
    if (like) { sql += ` AND (produto_identificado LIKE ? OR titulo_recomendado LIKE ? OR santo_devocao LIKE ? OR categoria LIKE ?)`; binds.push(like, like, like, like); }
    sql += ` ORDER BY updated_at DESC LIMIT 300`;
    const rows = await env.DB.prepare(sql).bind(...binds).all();
    siteItems = (rows.results || []).map(r => ({
      origem: 'site',
      id: 'site-' + r.id,
      audit_id: r.id,
      titulo: r.titulo_recomendado || r.produto_identificado || 'Produto',
      categoria: r.categoria,
      santo_devocao: r.santo_devocao,
      material: r.material,
      altura_valor: r.altura_valor,
      preco_valor: r.preco_valor,
      descricao: r.descricao_recomendada,
      tem_foto: !!r.imagem_editada_base64,
      drive_file_id: r.drive_file_id,
      shopify_product_id: r.shopify_product_id,
    }));
  }

  // 2. Produtos que já existem na loja Shopify (cache)
  let shopifyItems = [];
  if (fonte === 'todos' || fonte === 'shopify') {
    let sql = `SELECT product_id, title, product_type, status, image_url, price FROM shopify_products_cache WHERE 1=1`;
    const binds = [];
    if (like) { sql += ` AND title LIKE ?`; binds.push(like); }
    sql += ` ORDER BY title ASC LIMIT 300`;
    let rows;
    try { rows = await env.DB.prepare(sql).bind(...binds).all(); }
    catch { rows = { results: [] }; }
    shopifyItems = (rows.results || []).map(r => ({
      origem: 'shopify',
      id: 'shop-' + r.product_id,
      titulo: r.title,
      categoria: r.product_type || null,
      santo_devocao: null,
      material: null,
      altura_valor: null,
      preco_valor: r.price != null ? r.price : null,
      descricao: null,
      tem_foto: !!r.image_url,
      image_url: r.image_url || null,
      shopify_product_id: r.product_id,
      shopify_status: r.status,
    }));
  }

  const items = [...siteItems, ...shopifyItems];

  // Lista de categorias distintas (para os filtros)
  const cats = await env.DB.prepare(
    `SELECT DISTINCT categoria FROM audit_records WHERE status='APROVADO' AND categoria IS NOT NULL ORDER BY categoria`
  ).all().catch(() => ({ results: [] }));

  return jsonResponse({
    total: items.length,
    total_site: siteItems.length,
    total_shopify: shopifyItems.length,
    categorias: (cats.results || []).map(c => c.categoria),
    items,
  });
}
