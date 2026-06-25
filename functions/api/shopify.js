/**
 * /api/shopify — Proxy to Shopify Admin GraphQL API
 *
 * Auth flow: OAuth Client Credentials Grant (new Dev Dashboard apps)
 *   - Exchanges CLIENT_ID + CLIENT_SECRET for an access_token
 *   - Caches token in module-level globalThis until expiration
 *
 * Required env vars:
 *   SHOPIFY_SHOP_DOMAIN    = sthtec-5u.myshopify.com
 *   SHOPIFY_CLIENT_ID      = (Secret)
 *   SHOPIFY_CLIENT_SECRET  = (Secret)
 *   SHOPIFY_API_VERSION    = 2026-04 (optional)
 *   ADMIN_PASSWORD         = admin2901
 *
 * Backward-compat: SHOPIFY_ADMIN_TOKEN (legacy) still works if present.
 */

const TOKEN_CACHE = { value: null, expiresAt: 0 };

async function getAccessToken(env) {
  if (env.SHOPIFY_ADMIN_TOKEN && !env.SHOPIFY_CLIENT_ID) {
    return env.SHOPIFY_ADMIN_TOKEN;
  }

  const now = Date.now();
  if (TOKEN_CACHE.value && TOKEN_CACHE.expiresAt > now + 60_000) {
    return TOKEN_CACHE.value;
  }

  const shop = env.SHOPIFY_SHOP_DOMAIN || env.SHOPIFY_STORE;
  if (!shop) throw new Error('SHOPIFY_SHOP_DOMAIN not configured');
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    throw new Error('SHOPIFY_CLIENT_ID/SECRET not configured');
  }

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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth response missing access_token');

  const ttlMs = (data.expires_in || 3600) * 1000;
  TOKEN_CACHE.value = data.access_token;
  TOKEN_CACHE.expiresAt = now + ttlMs;
  return data.access_token;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const pwd = request.headers.get('X-Admin-Password');
  if (!env.ADMIN_PASSWORD || pwd !== env.ADMIN_PASSWORD) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const { query, variables } = body || {};
  if (!query) return json({ error: 'missing query' }, 400);

  let token;
  try {
    token = await getAccessToken(env);
  } catch (e) {
    return json({ error: 'auth: ' + e.message }, 500);
  }

  const shop = env.SHOPIFY_SHOP_DOMAIN || env.SHOPIFY_STORE;
  const apiVersion = env.SHOPIFY_API_VERSION || '2025-07';

  try {
    const shopifyRes = await fetch(
      `https://${shop}/admin/api/${apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query, variables: variables || {} }),
      }
    );

    if (shopifyRes.status === 401 || shopifyRes.status === 403) {
      TOKEN_CACHE.value = null;
      TOKEN_CACHE.expiresAt = 0;
    }

    const data = await shopifyRes.json();
    return new Response(JSON.stringify(data), {
      status: shopifyRes.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
