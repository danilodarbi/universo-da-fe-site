// functions/api/audit/process-next.js
// POST /api/audit/process-next  { batch_id }
// Processa UM produto pendente do lote por chamada (mantém a Function dentro
// dos limites de execução do Cloudflare Pages). A UI chama este endpoint em
// loop, uma vez por item, até o lote esgotar. Cada chamada salva o resultado
// imediatamente, então interromper no meio é seguro.

import {
  jsonResponse,
  corsPreflight,
  requireAuth,
  topCandidates,
  fetchThumbnailAsBase64,
  analyzePhotoWithOpenAI,
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
    // nada mais a processar — verifica se o lote já pode ser fechado
    // (ERRO conta como "resolvido para fins de lote" — fica visível na revisão
    // com botão para tentar de novo manualmente, não trava o lote)
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM audit_records WHERE batch_id = ? AND status = 'PENDENTE'`
    )
      .bind(batchId)
      .first();
    if (remaining.n === 0) {
      await env.DB.prepare(`UPDATE batches SET status = 'CONCLUIDO', updated_at = datetime('now') WHERE id = ?`)
        .bind(batchId)
        .run();
    }
    return jsonResponse({ done: true });
  }

  await env.DB.prepare(`UPDATE audit_records SET status = 'ANALISANDO', updated_at = datetime('now') WHERE id = ?`)
    .bind(item.id)
    .run();

  try {
    if (!item.thumbnail_link) {
      throw new Error('Sem thumbnail do Drive — rode sync-drive novamente ou verifique o arquivo');
    }

    const candidatesRows = await env.DB.prepare(
      `SELECT product_id, title, product_type FROM shopify_products_cache`
    ).all();
    const candidates = topCandidates(item.file_name, candidatesRows.results || [], 3);

    const imageBase64 = await fetchThumbnailAsBase64(env, item.thumbnail_link);
    const ai = await analyzePhotoWithOpenAI(env, { record: item, candidates, imageBase64 });

    const necessitaRevisao =
      ai.necessita_revisao === true ||
      !ai.produto_identificado ||
      (ai.confianca_correspondencia || 0) < 0.6 ||
      (ai.conflitos && ai.conflitos.length > 0);

    await env.DB.prepare(
      `UPDATE audit_records SET
        status = ?,
        ai_result_json = ?,
        produto_identificado = ?, categoria = ?, santo_devocao = ?, material = ?, cor = ?,
        altura_valor = ?, altura_fonte = ?, altura_confianca = ?,
        peso_valor = ?, peso_fonte = ?, peso_confianca = ?,
        preco_valor = ?, preco_fonte = ?,
        titulo_recomendado = ?, descricao_recomendada = ?,
        shopify_product_id = ?, status_correspondencia = ?, confianca_correspondencia = ?,
        evidencias_json = ?, conflitos_json = ?, informacoes_ausentes_json = ?,
        necessita_revisao = ?,
        updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(
        'PRONTO_PARA_REVISAO',
        JSON.stringify(ai),
        ai.produto_identificado || null,
        ai.categoria || null,
        ai.santo_devocao || null,
        ai.material || null,
        ai.cor || null,
        ai.altura?.valor ?? null,
        ai.altura?.fonte || null,
        ai.altura?.confianca ?? null,
        ai.peso?.valor ?? null,
        ai.peso?.fonte || null,
        ai.peso?.confianca ?? null,
        ai.preco?.valor ?? null,
        ai.preco?.fonte || null,
        ai.titulo_recomendado || null,
        ai.descricao_recomendada || null,
        ai.shopify_product_id || null,
        ai.status_correspondencia || null,
        ai.confianca_correspondencia ?? null,
        JSON.stringify(ai.evidencias || []),
        JSON.stringify(ai.conflitos || []),
        JSON.stringify(ai.informacoes_ausentes || []),
        necessitaRevisao ? 1 : 0,
        item.id
      )
      .run();

    await env.DB.prepare(`UPDATE batches SET processed_items = processed_items + 1, updated_at = datetime('now') WHERE id = ?`)
      .bind(batchId)
      .run();

    return jsonResponse({ done: false, item_id: item.id, status: 'PRONTO_PARA_REVISAO' });
  } catch (e) {
    await env.DB.prepare(
      `UPDATE audit_records SET status = 'ERRO', ai_error = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(e.message, item.id)
      .run();
    await env.DB.prepare(`UPDATE batches SET error_items = error_items + 1, updated_at = datetime('now') WHERE id = ?`)
      .bind(batchId)
      .run();
    // não interrompe o lote — a UI chama process-next de novo e o item seguinte é pego
    return jsonResponse({ done: false, item_id: item.id, status: 'ERRO', error: e.message });
  }
}
