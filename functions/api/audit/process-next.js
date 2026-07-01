// functions/api/audit/process-next.js
// POST /api/audit/process-next  { batch_id }
//
// Processa UM item pendente do lote por chamada.
// Se ANTHROPIC_API_KEY estiver configurado: analisa a foto com Claude Haiku
// e gera descrição do produto. A descrição também é usada para re-buscar
// candidatos Shopify por similaridade textual (muito melhor que nome de arquivo).
// Sem a key: prepara para revisão manual com candidatos por nome de arquivo.

import {
  jsonResponse,
  corsPreflight,
  requireAuth,
  topCandidates,
  fetchThumbnailAsBase64,
  analyzePhotoWithAnthropic,
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
      throw new Error('Sem thumbnail do Drive — rode sync-drive primeiro ou verifique o arquivo');
    }

    const imageBase64 = await fetchThumbnailAsBase64(env, item.thumbnail_link);

    // Análise de visão com Claude Haiku (se key disponível)
    let descricao = null;
    let aiUsed = false;
    if (env.ANTHROPIC_API_KEY) {
      try {
        descricao = await analyzePhotoWithAnthropic(env, { imageBase64 });
        aiUsed = true;
      } catch (aiErr) {
        // não bloqueia o fluxo — só anota o erro
        descricao = null;
      }
    }

    // Busca candidatos: usa descrição AI (muito mais precisa) ou nome do arquivo
    const candidatesRows = await env.DB.prepare(
      `SELECT product_id, title, product_type FROM shopify_products_cache`
    ).all();
    const queryText = descricao || item.file_name;
    const candidates = topCandidates(queryText, candidatesRows.results || [], 3);

    const candidatesJson = JSON.stringify(
      candidates.map(c => ({
        product_id: c.product_id,
        title: c.title,
        score: Math.round((c.score || 0) * 100) / 100,
      }))
    );

    await env.DB.prepare(
      `UPDATE audit_records SET
        status = 'PRONTO_PARA_REVISAO',
        produto_identificado = ?,
        ai_result_json = ?,
        necessita_revisao = 1,
        updated_at = datetime('now')
       WHERE id = ?`
    ).bind(descricao || null, candidatesJson, item.id).run();

    await env.DB.prepare(
      `UPDATE batches SET processed_items = processed_items + 1, updated_at = datetime('now') WHERE id = ?`
    ).bind(batchId).run();

    return jsonResponse({
      done: false,
      item_id: item.id,
      status: 'PRONTO_PARA_REVISAO',
      descricao,
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
