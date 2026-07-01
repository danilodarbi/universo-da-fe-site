// functions/api/audit/process-next.js
// POST /api/audit/process-next  { batch_id }
//
// Processa UM item por chamada. Com ANTHROPIC_API_KEY: retorna briefing
// completo (categoria, santo, material, altura, preço, título e descrição
// Shopify). Sem a key: prepara para revisão manual.

import {
  jsonResponse, corsPreflight, requireAuth,
  topCandidates, fetchThumbnailAsBase64, analyzePhotoWithAnthropic,
} from './_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!requireAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  const body = await request.json().catch(() => ({}));
  const batchId = body.batch_id;
  if (!batchId) return jsonResponse({ error: 'missing batch_id' }, 400);

  const item = await env.DB.prepare(
    `SELECT * FROM audit_records WHERE batch_id = ? AND status = 'PENDENTE' ORDER BY sort_key ASC LIMIT 1`
  ).bind(batchId).first();

  if (!item) {
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM audit_records WHERE batch_id = ? AND status = 'PENDENTE'`
    ).bind(batchId).first();
    if (remaining.n === 0) {
      await env.DB.prepare(
        `UPDATE batches SET status = 'CONCLUIDO', updated_at = datetime('now') WHERE id = ?`
      ).bind(batchId).run();
    }
    return jsonResponse({ done: true });
  }

  await env.DB.prepare(
    `UPDATE audit_records SET status = 'ANALISANDO', updated_at = datetime('now') WHERE id = ?`
  ).bind(item.id).run();

  try {
    if (!item.thumbnail_link) {
      throw new Error('Sem thumbnail — rode sync-drive primeiro');
    }

    const imageBase64 = await fetchThumbnailAsBase64(env, item.thumbnail_link);

    // Análise completa com Claude Haiku
    let ai = null;
    let aiUsed = false;
    if (env.ANTHROPIC_API_KEY) {
      try {
        ai = await analyzePhotoWithAnthropic(env, { imageBase64 });
        aiUsed = true;
      } catch (aiErr) {
        // Não bloqueia o fluxo
        ai = null;
      }
    }

    // Busca candidatos Shopify usando a descrição AI (muito mais precisa que nome de arquivo)
    const candidatesRows = await env.DB.prepare(
      `SELECT product_id, title, product_type FROM shopify_products_cache`
    ).all();
    const queryText = ai?.descricao || ai?.santo || item.file_name;
    const candidates = topCandidates(queryText, candidatesRows.results || [], 3);
    const candidatesJson = JSON.stringify(
      candidates.map(c => ({ product_id: c.product_id, title: c.title, score: Math.round((c.score||0)*100)/100 }))
    );

    // Determina necessidade de revisão
    const necessita = ai
      ? (ai.necessita_revisao !== false || (ai.confianca || 0) < 0.8)
      : true;

    // Salva todos os campos do briefing no banco
    await env.DB.prepare(
      `UPDATE audit_records SET
        status = 'PRONTO_PARA_REVISAO',
        produto_identificado = ?,
        categoria           = ?,
        santo_devocao       = ?,
        material            = ?,
        cor                 = ?,
        altura_valor        = ?,
        altura_fonte        = ?,
        altura_confianca    = ?,
        preco_valor         = ?,
        preco_fonte         = ?,
        titulo_recomendado  = ?,
        descricao_recomendada = ?,
        confianca_correspondencia = ?,
        ai_result_json      = ?,
        necessita_revisao   = ?,
        updated_at          = datetime('now')
       WHERE id = ?`
    ).bind(
      ai?.descricao         || null,
      ai?.categoria         || null,
      ai?.santo             || null,
      ai?.material          || null,
      ai?.cor               || null,
      ai?.altura_cm         ?? null,
      ai?.altura_cm != null ? 'AUDITORIA' : null,
      ai?.confianca         ?? null,
      ai?.preco_sugerido_brl ?? null,
      ai?.preco_referencia  || null,
      ai?.titulo_shopify    || null,
      ai?.descricao_shopify || null,
      ai?.confianca         ?? null,
      candidatesJson,
      necessita ? 1 : 0,
      item.id
    ).run();

    await env.DB.prepare(
      `UPDATE batches SET processed_items = processed_items + 1, updated_at = datetime('now') WHERE id = ?`
    ).bind(batchId).run();

    return jsonResponse({
      done: false,
      item_id: item.id,
      status: 'PRONTO_PARA_REVISAO',
      descricao: ai?.descricao || null,
      ai_used: aiUsed,
      candidates: candidates.length,
    });

  } catch (e) {
    await env.DB.prepare(
      `UPDATE audit_records SET status = 'ERRO', ai_error = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(e.message, item.id).run();
    await env.DB.prepare(
      `UPDATE batches SET error_items = error_items + 1, updated_at = datetime('now') WHERE id = ?`
    ).bind(batchId).run();
    return jsonResponse({ done: false, item_id: item.id, status: 'ERRO', error: e.message });
  }
}
