// functions/api/audit/process-next.js
// Processa UM item pendente por chamada.
// Salva o resultado completo da IA em ai_result_json (rastreabilidade)
// e os campos individuais nas colunas editáveis.

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
      throw new Error('Arquivo sem thumbnail no Drive — pode ser HEIC não convertido ou arquivo corrompido');
    }

    const imageBase64 = await fetchThumbnailAsBase64(env, item.thumbnail_link, item.drive_file_id);

    // Análise completa com Claude Sonnet (se key disponível)
    let ai = null;
    let aiUsed = false;
    let aiError = null;
    if (env.ANTHROPIC_API_KEY) {
      try {
        ai = await analyzePhotoWithAnthropic(env, { imageBase64 });
        aiUsed = true;
      } catch (aiErr) {
        ai = null;
        aiError = aiErr.message; // Guarda erro real para o log
      }
    }

    // Busca candidatos Shopify: usa descrição+santo da IA (muito mais precisa que nome de arquivo)
    const candidatesRows = await env.DB.prepare(
      `SELECT product_id, title, product_type FROM shopify_products_cache`
    ).all();
    const queryText = [ai?.santo, ai?.descricao, item.file_name].filter(Boolean).join(' ');
    const candidates = topCandidates(queryText, candidatesRows.results || [], 3);

    const necessita = ai
      ? (ai.necessita_revisao !== false || (ai.confianca || 0) < 0.8)
      : true;

    // ai_result_json: guarda resultado BRUTO completo + candidatos calculados
    const aiResultJson = JSON.stringify({
      ai: ai || null,
      candidates: candidates.map(c => ({
        product_id: c.product_id,
        title: c.title,
        score: Math.round((c.score || 0) * 100) / 100,
      })),
    });

    // Helper: garante número ou null para colunas REAL (evita erro string/blob)
    const num = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
      return Number.isNaN(n) ? null : n;
    };

    await env.DB.prepare(
      `UPDATE audit_records SET
        status                  = 'PRONTO_PARA_REVISAO',
        produto_identificado    = ?,
        categoria               = ?,
        santo_devocao           = ?,
        material                = ?,
        cor                     = ?,
        altura_valor            = ?,
        altura_fonte            = ?,
        altura_confianca        = ?,
        preco_valor             = ?,
        preco_fonte             = ?,
        titulo_recomendado      = ?,
        descricao_recomendada   = ?,
        confianca_correspondencia = ?,
        ai_result_json          = ?,
        necessita_revisao       = ?,
        updated_at              = datetime('now')
       WHERE id = ?`
    ).bind(
      ai?.descricao         || null,
      ai?.categoria         || null,
      ai?.santo             || null,
      ai?.material          || null,
      ai?.cor               || null,
      num(ai?.altura_cm),
      ai?.altura_cm != null ? 'AUDITORIA' : null,
      num(ai?.confianca),
      num(ai?.preco_sugerido_brl),
      ai ? `[${ai.preco_fonte || 'ESTIMATIVA'}] ${ai.preco_referencia || ''}`.trim() : null,
      ai?.titulo_shopify    || null,
      ai?.descricao_shopify || null,
      num(ai?.confianca),
      aiResultJson,
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
      confianca: ai?.confianca ?? null,
      alertas: ai?.alertas || [],
      ai_used: aiUsed,
      ai_error: aiError,
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
