/**
 * /api/shopify — Proxy to Shopify Admin API
 * Keeps token server-side, handles CORS.
 *
 * Required env vars in Cloudflare Pages:
 *   SHOPIFY_STORE   = sthtec-5u.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN = shpat_xxx
 *   ADMIN_PASSWORD  = admin2901
 */

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const pwd = request.headers.get('X-Admin-Password');
  if (pwd !== env.ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid json' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const { query, variables } = body;
  if (!query) {
    return new Response(JSON.stringify({ error: 'missing query' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const shopifyRes = await fetch(
      `https://${env.SHOPIFY_STORE}/admin/api/2025-07/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN,
        },
        body: JSON.stringify({ query, variables: variables || {} }),
      }
    );

    const data = await shopifyRes.json();
    return new Response(JSON.stringify(data), {
      status: shopifyRes.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
