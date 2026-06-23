/**
 * /api/debug — Shows which env vars are visible to Pages Functions
 * Returns only KEY NAMES (not values) for security
 */
export async function onRequest(context) {
  const { env } = context;
  const keys = Object.keys(env || {});
  const status = {
    SHOPIFY_STORE: !!env.SHOPIFY_STORE,
    SHOPIFY_ADMIN_TOKEN: !!env.SHOPIFY_ADMIN_TOKEN,
    OPENAI_API_KEY: !!env.OPENAI_API_KEY,
    ADMIN_PASSWORD: !!env.ADMIN_PASSWORD,
    SHOPIFY_STORE_value: env.SHOPIFY_STORE || null,
    ADMIN_PASSWORD_length: env.ADMIN_PASSWORD ? env.ADMIN_PASSWORD.length : 0,
  };
  return new Response(JSON.stringify({ allKeys: keys, status }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}
