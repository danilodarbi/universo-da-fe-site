// functions/api/config/status.js
// GET /api/config/status
// Verifica presença e formato das integrações. Rápido — sem chamadas externas.
// POST /api/config/status  { test: "shopify"|"google"|"anthropic" }
// Testa uma integração específica com chamada real (pode demorar).

import { getDriveAccessToken, driveListFolder } from '../audit/_shared.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
    }});
  }

  const pwd = request.headers.get('X-Admin-Password');
  if (pwd !== env.ADMIN_PASSWORD) return json({ error: 'unauthorized' }, 401);

  // POST → testa integração específica com chamada real
  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    switch (body.test) {
      case 'shopify':   return json({ result: await testShopify(env) });
      case 'google':    return json({ result: await testGoogle(env) });
      case 'anthropic': return json({ result: await testAnthropic(env) });
      default: return json({ error: 'test inválido' }, 400);
    }
  }

  // GET → verificação instantânea de presença/formato (sem rede)
  return json({
    shopify:    quickCheckShopify(env),
    google_drive: quickCheckGoogle(env),
    d1:         quickCheckD1(env),
    anthropic:  quickCheckAnthropic(env),
  });
}

// ── Quick checks (instantâneo, sem rede) ──────────────────────────────────────

function quickCheckShopify(env) {
  const shop = env.SHOPIFY_SHOP_DOMAIN || env.SHOPIFY_STORE;
  if (!shop)                  return fail('SHOPIFY_SHOP_DOMAIN não configurado');
  if (!env.SHOPIFY_CLIENT_ID) return fail('SHOPIFY_CLIENT_ID não configurado');
  if (!env.SHOPIFY_CLIENT_SECRET) return fail('SHOPIFY_CLIENT_SECRET não configurado');
  return ok(`Variáveis presentes — loja: ${shop}`, { shop, quick: true });
}

function quickCheckGoogle(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) return fail('GOOGLE_SERVICE_ACCOUNT_JSON não configurado');
  let sa;
  try { sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON); } catch { return fail('JSON inválido'); }
  if (!sa.client_email || !sa.private_key) return fail('JSON sem client_email ou private_key');
  return ok(`Service account: ${sa.client_email}`, { service_account: sa.client_email, quick: true });
}

function quickCheckD1(env) {
  if (!env.DB) return fail('Binding D1 "DB" não encontrado');
  return ok('Binding DB disponível');
}

function quickCheckAnthropic(env) {
  if (!env.ANTHROPIC_API_KEY) return fail('ANTHROPIC_API_KEY não configurada');
  const key = env.ANTHROPIC_API_KEY;
  if (!key.startsWith('sk-ant-')) return fail('Formato inválido (deve começar com sk-ant-)');
  return ok(`Key configurada (${key.slice(0, 12)}…) — clique Testar para validar`, { quick: true });
}

// ── Full tests (com chamada real, via POST) ────────────────────────────────────

async function testShopify(env) {
  const shop = env.SHOPIFY_SHOP_DOMAIN || env.SHOPIFY_STORE;
  if (!shop || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET)
    return fail('Variáveis não configuradas');
  try {
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
    if (!res.ok || !data.access_token) return fail(`OAuth falhou (${res.status})`);
    return ok(`Conectado — loja: ${shop}`, { shop, scopes: data.scope || null });
  } catch (e) { return fail(`Erro: ${sanitize(e.message)}`); }
}

const PASTA_1 = '1fzzaoZF-hGXdDtcp2DDWtnLUWKIFSLxI';
const PASTA_2 = '1xJGzqUFk67eSohxRKvMkhPv3VGG6B6xt';

async function testGoogle(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) return fail('Não configurado');
  let sa;
  try { sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON); } catch { return fail('JSON inválido'); }
  try {
    await getDriveAccessToken(env);
    const folders = [];
    for (const [nome, id] of [['Pasta 1 (resina)', PASTA_1], ['Pasta 2 (joias)', PASTA_2]]) {
      try {
        const page = await driveListFolder(env, id);
        folders.push({ nome, id, acessivel: true, arquivos: page.files?.length ?? 0 });
      } catch (e) {
        folders.push({ nome, id, acessivel: false, erro: sanitize(e.message) });
      }
    }
    const ok_ = folders.every(f => f.acessivel);
    return { ok: ok_, msg: ok_ ? `Autenticada — ${sa.client_email.split('@')[0]}@…` : 'Auth OK mas pasta(s) inacessível(is)', service_account: sa.client_email, pastas: folders };
  } catch (e) { return fail(`Auth falhou: ${sanitize(e.message)}`); }
}

async function testAnthropic(env) {
  if (!env.ANTHROPIC_API_KEY) return fail('Não configurada');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': (env.ANTHROPIC_API_KEY || '').replace(/[\s\r\n]+/g, ''), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 5, messages: [{ role: 'user', content: 'oi' }] }),
    });
    const data = await res.json();
    if (!res.ok) return fail(`Key inválida: ${sanitize(data.error?.message || res.status)}`);
    return ok('Key válida — claude-sonnet-4-6 pronto');
  } catch (e) { return fail(`Erro: ${sanitize(e.message)}`); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function ok(msg, extra = {}) { return { ok: true, msg, ...extra }; }
function fail(msg)            { return { ok: false, msg }; }
function sanitize(msg = '')   { return String(msg).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 200); }
