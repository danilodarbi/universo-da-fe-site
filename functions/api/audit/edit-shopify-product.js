// functions/api/audit/edit-shopify-product.js
// POST /api/audit/edit-shopify-product
// { product_id, title?, description?, price?, image_base64? }
// Edita um produto que já existe na loja Shopify: título, descrição,
// preço e/ou troca a imagem principal.

import { jsonResponse, corsPreflight, requireAuth } from './_shared.js';

async function shopifyToken(env) {
  const shop = env.SHOPIFY_SHOP_DOMAIN || env.SHOPIFY_STORE;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: (env.SHOPIFY_CLIENT_ID || '').replace(/[\s\r\n]+/g, ''),
    client_secret: (env.SHOPIFY_CLIENT_SECRET || '').replace(/[\s\r\n]+/g, ''),
  });
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Falha ao obter token Shopify');
  return { token: d.access_token, shop };
}

async function gql(env, token, shop, query, variables) {
  const apiVersion = env.SHOPIFY_API_VERSION || '2025-07';
  const r = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!requireAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  const body = await request.json().catch(() => ({}));
  let { product_id, title, description, price, image_base64, replace_image } = body;
  if (!product_id) return jsonResponse({ error: 'missing product_id' }, 400);

  const pid = String(product_id).startsWith('gid://') ? product_id : `gid://shopify/Product/${product_id}`;

  try {
    const { token, shop } = await shopifyToken(env);
    const done = [];

    // 1. Atualiza título/descrição
    if (title || description) {
      const input = { id: pid };
      if (title) input.title = title;
      if (description != null) input.descriptionHtml = description;
      const r = await gql(env, token, shop, `
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) { product { id } userErrors { message } }
        }`, { input });
      const errs = r?.data?.productUpdate?.userErrors;
      if (errs?.length) throw new Error('título/descrição: ' + errs[0].message);
      done.push('dados');
    }

    // 2. Atualiza preço (primeira variante)
    if (price != null && price !== '') {
      const varsRes = await gql(env, token, shop, `
        query($id: ID!) { product(id: $id) { variants(first: 1) { nodes { id } } } }`, { id: pid });
      const variantId = varsRes?.data?.product?.variants?.nodes?.[0]?.id;
      if (variantId) {
        const r = await gql(env, token, shop, `
          mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } }
          }`, { productId: pid, variants: [{ id: variantId, price: String(price) }] });
        const errs = r?.data?.productVariantsBulkUpdate?.userErrors;
        if (errs?.length) throw new Error('preço: ' + errs[0].message);
        done.push('preço');
      }
    }

    // 3. Troca/adiciona imagem
    if (image_base64) {
      // Se replace_image, remove as mídias atuais primeiro
      if (replace_image) {
        const media = await gql(env, token, shop, `
          query($id: ID!) { product(id: $id) { media(first: 20) { nodes { id } } } }`, { id: pid });
        const ids = (media?.data?.product?.media?.nodes || []).map(m => m.id);
        if (ids.length) {
          await gql(env, token, shop, `
            mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
              productDeleteMedia(productId: $productId, mediaIds: $mediaIds) { deletedMediaIds userErrors { message } }
            }`, { productId: pid, mediaIds: ids });
        }
      }

      const b64 = image_base64.replace(/^data:image\/\w+;base64,/, '');
      const mime = image_base64.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      const staged = await gql(env, token, shop, `
        mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { message }
          }
        }`, {
        input: [{ filename: `produto-${Date.now()}.jpg`, mimeType: mime, httpMethod: 'POST', resource: 'IMAGE', fileSize: String(bytes.length) }],
      });
      const target = staged?.data?.stagedUploadsCreate?.stagedTargets?.[0];
      if (target) {
        const fd = new FormData();
        for (const p of target.parameters) fd.append(p.name, p.value);
        fd.append('file', new Blob([bytes], { type: mime }), `produto.jpg`);
        const up = await fetch(target.url, { method: 'POST', body: fd });
        if (up.ok) {
          const r = await gql(env, token, shop, `
            mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
              productCreateMedia(productId: $productId, media: $media) { media { status } mediaUserErrors { message } }
            }`, { productId: pid, media: [{ originalSource: target.resourceUrl, mediaContentType: 'IMAGE' }] });
          const errs = r?.data?.productCreateMedia?.mediaUserErrors;
          if (errs?.length) throw new Error('imagem: ' + errs[0].message);
          done.push('imagem');
        }
      }
    }

    // Atualiza o cache local
    if (title || price != null) {
      await env.DB.prepare(
        `UPDATE shopify_products_cache SET title = COALESCE(?, title), price = COALESCE(?, price), updated_at = datetime('now') WHERE product_id = ?`
      ).bind(title || null, (price != null && price !== '') ? Number(price) : null, pid).run().catch(() => {});
    }

    return jsonResponse({ ok: true, atualizado: done, msg: `Atualizado na loja: ${done.join(', ') || 'nada'}` });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
