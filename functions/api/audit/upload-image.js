// functions/api/audit/upload-image.js
// POST /api/audit/upload-image
// Body: { item_id, product_id, image_base64, filename }
// Recebe imagem colada (base64), sobe para o Shopify e anexa ao produto.
// Fluxo Shopify: stagedUploadsCreate → PUT no bucket → productCreateMedia

import { jsonResponse, corsPreflight, requireAuth } from './_shared.js';

async function shopifyGraphQL(env, query, variables) {
  const shop = env.SHOPIFY_SHOP_DOMAIN || env.SHOPIFY_STORE;
  const apiVersion = env.SHOPIFY_API_VERSION || '2025-07';

  // Reusa o proxy de token do shopify.js via OAuth
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.SHOPIFY_CLIENT_ID,
    client_secret: env.SHOPIFY_CLIENT_SECRET,
  });
  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;
  if (!token) throw new Error('Falha ao obter token Shopify');

  const res = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

function base64ToBytes(b64) {
  const clean = b64.replace(/^data:image\/\w+;base64,/, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!requireAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  const body = await request.json().catch(() => ({}));
  const { item_id, product_id, image_base64, filename } = body;

  if (!image_base64) return jsonResponse({ error: 'sem imagem' }, 400);
  if (!product_id)   return jsonResponse({ error: 'sem product_id — vincule um produto antes' }, 400);

  try {
    const bytes = base64ToBytes(image_base64);
    const fname = filename || `produto-${Date.now()}.png`;
    const mime = image_base64.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';

    // 1. stagedUploadsCreate — pede uma URL de upload temporária
    const stagedQuery = `
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }`;
    const stagedRes = await shopifyGraphQL(env, stagedQuery, {
      input: [{
        filename: fname,
        mimeType: mime,
        httpMethod: 'POST',
        resource: 'IMAGE',
        fileSize: String(bytes.length),
      }],
    });

    const target = stagedRes?.data?.stagedUploadsCreate?.stagedTargets?.[0];
    const stagedErrors = stagedRes?.data?.stagedUploadsCreate?.userErrors;
    if (stagedErrors?.length) throw new Error('staged: ' + stagedErrors[0].message);
    if (!target) throw new Error('Sem target de upload — ' + JSON.stringify(stagedRes?.errors || stagedRes).slice(0, 200));

    // 2. POST do arquivo para o bucket temporário
    const formData = new FormData();
    for (const p of target.parameters) formData.append(p.name, p.value);
    formData.append('file', new Blob([bytes], { type: mime }), fname);

    const uploadRes = await fetch(target.url, { method: 'POST', body: formData });
    if (!uploadRes.ok) {
      const t = await uploadRes.text();
      throw new Error(`upload bucket falhou (${uploadRes.status}): ${t.slice(0, 150)}`);
    }

    // 3. productCreateMedia — anexa a imagem ao produto
    const productGid = product_id.startsWith('gid://') ? product_id : `gid://shopify/Product/${product_id}`;
    const mediaQuery = `
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { alt mediaContentType status }
          mediaUserErrors { field message }
        }
      }`;
    const mediaRes = await shopifyGraphQL(env, mediaQuery, {
      productId: productGid,
      media: [{
        originalSource: target.resourceUrl,
        alt: fname,
        mediaContentType: 'IMAGE',
      }],
    });

    const mediaErrors = mediaRes?.data?.productCreateMedia?.mediaUserErrors;
    if (mediaErrors?.length) throw new Error('media: ' + mediaErrors[0].message);

    // Marca o item como imagem enviada, se item_id vier
    if (item_id) {
      await env.DB.prepare(
        `UPDATE audit_records SET imagem_enviada = 1, updated_at = datetime('now') WHERE id = ?`
      ).bind(item_id).run().catch(() => {});
    }

    return jsonResponse({ ok: true, msg: 'Imagem anexada ao produto no Shopify.' });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
