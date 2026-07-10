// functions/api/audit/sync-shopify-cache.js
// POST /api/audit/sync-shopify-cache
// Espelha título/tipo/imagem dos produtos Shopify para shopify_products_cache,
// para que o matching de candidatos não precise chamar a Admin API a cada item do lote.

import { jsonResponse, corsPreflight, requireAuth, normalizeTitle } from './_shared.js';

async function getShopifyToken(env) {
  const shop = env.SHOPIFY_SHOP_DOMAIN || env.SHOPIFY_STORE;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.SHOPIFY_CLIENT_ID,
    client_secret: env.SHOPIFY_CLIENT_SECRET,
  });
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OAuth falhou: ${JSON.stringify(data)}`);
  return data.access_token;
}

const QUERY = `
query Products($cursor: String) {
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        title
        status
        productType
        featuredImage { url }
        priceRangeV2 { minVariantPrice { amount } }
      }
    }
  }
}`;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!requireAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  const shop = env.SHOPIFY_SHOP_DOMAIN || env.SHOPIFY_STORE;
  const apiVersion = env.SHOPIFY_API_VERSION || '2025-07';
  const token = await getShopifyToken(env);

  let cursor = null;
  let hasNext = true;
  let count = 0;

  while (hasNext) {
    const res = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: QUERY, variables: { cursor } }),
    });
    const data = await res.json();
    if (!res.ok || data.errors) {
      return jsonResponse({ error: 'shopify_error', detail: data.errors || data }, 500);
    }
    const conn = data.data.products;
    for (const { node } of conn.edges) {
      await env.DB.prepare(
        `INSERT INTO shopify_products_cache (product_id, title, title_normalized, status, product_type, image_url, price, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(product_id) DO UPDATE SET
           title = excluded.title, title_normalized = excluded.title_normalized,
           status = excluded.status, product_type = excluded.product_type,
           image_url = excluded.image_url, price = excluded.price, updated_at = datetime('now')`
      )
        .bind(node.id, node.title, normalizeTitle(node.title), node.status, node.productType, node.featuredImage?.url || null, node.priceRangeV2?.minVariantPrice?.amount ? Number(node.priceRangeV2.minVariantPrice.amount) : null)
        .run();
      count++;
    }
    hasNext = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
  }

  return jsonResponse({ synced: count });
}
