/**
 * /api/debug — Inspects env vars and tests OAuth without exposing secrets
 * Returns only key names and lengths, never values of secrets.
 */
export async function onRequest(context) {
  const { env } = context;
  const allKeys = Object.keys(env || {});

  const status = {
    SHOPIFY_SHOP_DOMAIN: !!env.SHOPIFY_SHOP_DOMAIN || !!env.SHOPIFY_STORE,
    SHOPIFY_SHOP_DOMAIN_value: env.SHOPIFY_SHOP_DOMAIN || env.SHOPIFY_STORE || null,
    SHOPIFY_CLIENT_ID: !!env.SHOPIFY_CLIENT_ID,
    SHOPIFY_CLIENT_ID_length: env.SHOPIFY_CLIENT_ID ? env.SHOPIFY_CLIENT_ID.length : 0,
    SHOPIFY_CLIENT_SECRET: !!env.SHOPIFY_CLIENT_SECRET,
    SHOPIFY_CLIENT_SECRET_length: env.SHOPIFY_CLIENT_SECRET ? env.SHOPIFY_CLIENT_SECRET.length : 0,
    SHOPIFY_API_VERSION: env.SHOPIFY_API_VERSION || '(default 2025-07)',
    SHOPIFY_ADMIN_TOKEN_present: !!env.SHOPIFY_ADMIN_TOKEN,
    OPENAI_API_KEY: !!env.OPENAI_API_KEY,
    ADMIN_PASSWORD: !!env.ADMIN_PASSWORD,
    ADMIN_PASSWORD_length: env.ADMIN_PASSWORD ? env.ADMIN_PASSWORD.length : 0,
  };

  // Live OAuth probe
  let oauth = { tried: false };
  if (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET) {
    oauth.tried = true;
    const shop = env.SHOPIFY_SHOP_DOMAIN || env.SHOPIFY_STORE;
    try {
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.SHOPIFY_CLIENT_ID,
        client_secret: env.SHOPIFY_CLIENT_SECRET,
      });
      const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const txt = await r.text();
      oauth.status = r.status;
      oauth.ok = r.ok;
      if (r.ok) {
        try {
          const j = JSON.parse(txt);
          oauth.token_received = !!j.access_token;
          oauth.expires_in = j.expires_in;
          oauth.scope = j.scope;
        } catch { oauth.parse_error = true; }
      } else {
        oauth.body_preview = txt.slice(0, 200);
      }
    } catch (e) {
      oauth.error = e.message;
    }
  }

  return new Response(JSON.stringify({ allKeys, status, oauth }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}
