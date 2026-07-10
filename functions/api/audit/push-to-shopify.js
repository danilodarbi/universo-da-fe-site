// functions/api/audit/push-to-shopify.js
// POST /api/audit/push-to-shopify  { item_id }
// Envia um produto aprovado para a loja Shopify:
// - Se já tem shopify_product_id: atualiza título/descrição e anexa a imagem
// - Se não tem: cria um novo produto (draft) com título, descrição, preço e imagem

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
  const itemId = body.item_id;
  if (!itemId) return jsonResponse({ error: 'missing item_id' }, 400);

  const item = await env.DB.prepare(`SELECT * FROM audit_records WHERE id = ?`).bind(itemId).first();
  if (!item) return jsonResponse({ error: 'item não encontrado' }, 404);

  try {
    const { token, shop } = await shopifyToken(env);

    const titulo = item.titulo_recomendado || item.produto_identificado || 'Produto devocional';
    const descricao = item.descricao_recomendada || item.produto_identificado || '';
    const preco = item.preco_valor != null ? String(item.preco_valor) : null;

    let productId = item.shopify_product_id;
    let created = false;

    // 1. Cria o produto se ainda não existe
    if (!productId) {
      const createRes = await gql(env, token, shop, `
        mutation productCreate($input: ProductInput!) {
          productCreate(input: $input) {
            product { id }
            userErrors { field message }
          }
        }`, {
        input: {
          title: titulo,
          descriptionHtml: descricao,
          status: 'DRAFT', // entra como rascunho para você revisar antes de publicar
        },
      });
      const errs = createRes?.data?.productCreate?.userErrors;
      if (errs?.length) throw new Error('criar: ' + errs[0].message);
      productId = createRes?.data?.productCreate?.product?.id;
      if (!productId) throw new Error('Shopify não retornou ID do produto');
      created = true;

      // Salva o novo ID no D1
      await env.DB.prepare(`UPDATE audit_records SET shopify_product_id = ? WHERE id = ?`)
        .bind(productId, itemId).run().catch(() => {});
    } else {
      // Atualiza título e descrição do produto existente
      const pid = productId.startsWith('gid://') ? productId : `gid://shopify/Product/${productId}`;
      await gql(env, token, shop, `
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) { product { id } userErrors { field message } }
        }`, {
        input: { id: pid, title: titulo, descriptionHtml: descricao },
      });
      productId = pid;
    }

    // 2. Anexa a imagem editada (se houver) via staged upload
    let imageAttached = false;
    if (item.imagem_editada_base64) {
      try {
        const b64 = item.imagem_editada_base64.replace(/^data:image\/\w+;base64,/, '');
        const mime = item.imagem_editada_base64.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
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
          input: [{ filename: `produto-${itemId}.jpg`, mimeType: mime, httpMethod: 'POST', resource: 'IMAGE', fileSize: String(bytes.length) }],
        });
        const target = staged?.data?.stagedUploadsCreate?.stagedTargets?.[0];
        if (target) {
          const fd = new FormData();
          for (const p of target.parameters) fd.append(p.name, p.value);
          fd.append('file', new Blob([bytes], { type: mime }), `produto-${itemId}.jpg`);
          const up = await fetch(target.url, { method: 'POST', body: fd });
          if (up.ok) {
            const pid = productId.startsWith('gid://') ? productId : `gid://shopify/Product/${productId}`;
            await gql(env, token, shop, `
              mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
                productCreateMedia(productId: $productId, media: $media) {
                  media { status } mediaUserErrors { message }
                }
              }`, {
              productId: pid,
              media: [{ originalSource: target.resourceUrl, mediaContentType: 'IMAGE', alt: titulo }],
            });
            imageAttached = true;
          }
        }
      } catch { /* imagem falhou mas produto foi criado — não bloqueia */ }
    }

    // 3. Define o preço (na primeira variante) se houver
    if (preco) {
      try {
        const pid = productId.startsWith('gid://') ? productId : `gid://shopify/Product/${productId}`;
        const varsRes = await gql(env, token, shop, `
          query($id: ID!) { product(id: $id) { variants(first: 1) { nodes { id } } } }`, { id: pid });
        const variantId = varsRes?.data?.product?.variants?.nodes?.[0]?.id;
        if (variantId) {
          await gql(env, token, shop, `
            mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                userErrors { message }
              }
            }`, { productId: pid, variants: [{ id: variantId, price: preco }] });
        }
      } catch { /* preço falhou — não bloqueia */ }
    }

    // Marca como enviado
    await env.DB.prepare(`UPDATE audit_records SET enviado_shopify = 1, updated_at = datetime('now') WHERE id = ?`)
      .bind(itemId).run().catch(() => {});

    return jsonResponse({
      ok: true,
      created,
      product_id: productId,
      image_attached: imageAttached,
      admin_url: `https://${shop}/admin/products/${String(productId).replace('gid://shopify/Product/', '')}`,
      msg: created ? 'Produto criado na loja (rascunho).' : 'Produto atualizado na loja.',
    });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
