// functions/api/audit/process-next.js
// POST /api/audit/process-next  { batch_id }
//
// Processa UM item pendente do lote por chamada.
// Sem análise automática por IA — valida acesso ao Drive e prepara o item
// para revisão manual na tela de auditoria.
//
// Fluxo:
//   1. Pega o próximo item PENDENTE do lote
//   2. Verifica que o thumbnail do Drive está acessível
//   3. Grava status PRONTO_PARA_REVISAO + necessita_revisao = 1
//   4. O revisor humano faz a correspondência produto↔foto na tela de revisão

import {
  jsonResponse,
  corsPreflight,
  requireAuth,
  topCandidates,
  fetchThumbnailAsBase64,
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
  )
    .bind(batchId)
    .first();

  if (!item) {
    // Verifica se o lote pode ser fechado
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM audit_records WHERE batch_id = ? AND status = 'PENDENTE'`
    )
      .bind(batchId)
      .first();
    if (remaining.n === 0) {
      await env.DB.prepare(
        `UPDATE batches SET status = 'CONCLUIDO', updated_at = datetime('now') WHERE id = ?`
      )
        .bind(batchId)
        .run();
    }
    return jsonResponse({ done: true });
  }

  await env.DB.prepare(
    `UPDATE audit_records SET status = 'ANALISANDO', updated_at = datetime('now') WHERE id = ?`
  )
    .bind(item.id)
    .run();

  try {
    if (!item.thumbnail_link) {
      throw new Error('Sem thumbnail do Drive — rode sync-drive primeiro ou verifique o arquivo');
    }

    // Verifica acesso ao Drive baixando o thumbnail (confirma autenticação e arquivo)
    await fetchThumbnailAsBase64(env, item.thumbnail_link);

    // Busca candidatos Shopify por similaridade de nome de arquivo (base para revisão manual)
    const candidatesRows = await env.DB.prepare(
      `SELECT product_id, title, product_type FROM shopify_products_cache`
    ).all();
    const candidates = topCandidates(item.file_name, candidatesRows.results || [], 3);

    const candidatesJson = JSON.stringify(
      candidates.map(c => ({
        product_id: c.product_id,
        title: c.title,
        score: Math.round((c.score || 0) * 100) / 100,
      }))
    );

    // Grava pronto para revisão manual — sem IA, revisor decide tudo
    await env.DB.prepare(
      `UPDATE audit_records SET
        status = 'PRONTO_PARA_REVISAO',
        ai_result_json = ?,
        necessita_revisao = 1,
        updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(candidatesJson, item.id)
      .run();

    await env.DB.prepare(
      `UPDATE batches SET processed_items = processed_items + 1, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(batchId)
      .run();

    return jsonResponse({
      done: false,
      item_id: item.id,
      status: 'PRONTO_PARA_REVISAO',
      candidates: candidates.length,
    });
  } catch (e) {
    await env.DB.prepare(
      `UPDATE audit_records SET status = 'ERRO', ai_error = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(e.message, item.id)
      .run();
    await env.DB.prepare(
      `UPDATE batches SET error_items = error_items + 1, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(batchId)
      .run();
    return jsonResponse({ done: false, item_id: item.id, status: 'ERRO', error: e.message });
  }
}
