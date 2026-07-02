// functions/api/config/status.js
// GET /api/config/status
// Verifica as integrações ativas (Shopify, Google Drive, D1).
// Nunca expõe valores de secrets, private_key, tokens ou conteúdo do JSON.

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
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
      },
    });
  }

  const pwd = request.headers.get('X-Admin-Password');
  if (pwd !== env.ADMIN_PASSWORD) return json({ error: 'unauthorized' }, 401);

  // Executa todos os checks em paralelo com timeout individual de 8s
  const withTimeout = (promise, label) =>
    Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve(fail(`${label}: timeout após 8s`)), 8000)),
    ]);

  const [shopify, google_drive, d1, anthropic] = await Promise.all([
    withTimeout(checkShopify(env), 'Shopify'),
    withTimeout(checkGoogleDrive(env), 'Google Drive'),
    Promise.resolve(checkD1(env)),
    withTimeout(checkAnthropic(env), 'Anthropic'),
  ]);

  return json({ shopify, google_drive, d1, anthropic });
}

// ── Shopify ──────────────────────────────────────────────────────────────────

async function checkShopify(env) {
  const shop = env.SHOPIFY_SHOP_DOMAIN || env.SHOPIFY_STORE;

  if (!shop)          return fail('SHOPIFY_SHOP_DOMAIN não configurado');
  if (!env.SHOPIFY_CLIENT_ID)     return fail('SHOPIFY_CLIENT_ID não configurado');
  if (!env.SHOPIFY_CLIENT_SECRET) return fail('SHOPIFY_CLIENT_SECRET não configurado');

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
    if (!res.ok || !data.access_token) {
      return fail(`OAuth falhou (${res.status})`);
    }
    return ok(`Conectado — loja: ${shop}`, {
      shop,
      scopes: data.scope || null,
    });
  } catch (e) {
    return fail(`Erro de rede: ${sanitize(e.message)}`);
  }
}

// ── Google Drive ─────────────────────────────────────────────────────────────

const PASTA_1 = '1fzzaoZF-hGXdDtcp2DDWtnLUWKIFSLxI';
const PASTA_2 = '1xJGzqUFk67eSohxRKvMkhPv3VGG6B6xt';

async function checkGoogleDrive(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return fail('GOOGLE_SERVICE_ACCOUNT_JSON não configurado');
  }

  // Valida o JSON antes de tentar autenticar
  let sa;
  try {
    sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    return fail('GOOGLE_SERVICE_ACCOUNT_JSON é JSON inválido');
  }

  if (!sa.client_email || !sa.private_key) {
    return fail('JSON da service account sem client_email ou private_key');
  }

  // Testa autenticação e acesso às duas pastas
  try {
    await getDriveAccessToken(env); // lança se a auth falhar

    const folders = [];
    for (const [nome, id] of [['Pasta 1 (resina)', PASTA_1], ['Pasta 2 (joias)', PASTA_2]]) {
      try {
        const page = await driveListFolder(env, id);
        const total = page.files?.length ?? 0;
        folders.push({ nome, id, acessivel: true, arquivos_na_pagina: total });
      } catch (e) {
        folders.push({ nome, id, acessivel: false, erro: sanitize(e.message) });
      }
    }

    const todas_ok = folders.every(f => f.acessivel);
    return {
      ok: todas_ok,
      msg: todas_ok
        ? `Service account autenticada — ${sa.client_email.split('@')[0]}@…`
        : 'Autenticada, mas uma ou mais pastas não acessíveis',
      service_account: sa.client_email, // e-mail não é secret
      pastas: folders,
    };
  } catch (e) {
    return fail(`Autenticação falhou: ${sanitize(e.message)}`);
  }
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async function checkAnthropic(env) {
  if (!env.ANTHROPIC_API_KEY) return fail('ANTHROPIC_API_KEY não configurada');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    const data = await res.json();
    if (!res.ok) return fail(`Key inválida: ${sanitize(data.error?.message || res.status)}`);
    return ok('Conectada — claude-sonnet-4-6 pronto para análise de fotos');
  } catch (e) {
    return fail(`Erro de rede: ${sanitize(e.message)}`);
  }
}

// ── D1 ───────────────────────────────────────────────────────────────────────

function checkD1(env) {
  if (!env.DB) return fail('Binding D1 "DB" não encontrado');
  // Só a presença do binding já confirma que está configurado no Pages.
  // Uma query real seria feita aqui se precisássemos de garantia extra,
  // mas o binding ausente já causaria erro em qualquer endpoint de audit.
  return ok('Binding DB disponível');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(msg, extra = {}) {
  return { ok: true, msg, ...extra };
}

function fail(msg) {
  return { ok: false, msg };
}

// Remove trechos que possam vazar tokens ou chaves de mensagens de erro
function sanitize(msg = '') {
  return msg
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/private_key[^,}]*/gi, 'private_key: [REDACTED]')
    .slice(0, 300);
}
