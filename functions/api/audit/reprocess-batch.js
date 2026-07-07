// functions/api/audit/reprocess-batch.js
// POST /api/audit/reprocess-batch  { batch_id? }
// Reseta itens PRONTO_PARA_REVISAO e ERRO de volta para PENDENTE,
// removendo o batch_id para que sejam re-processados no próximo lote.
// Útil quando os itens foram processados sem ANTHROPIC_API_KEY.

import { jsonResponse, corsPreflight, requireAuth } from './_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!requireAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  const body = await request.json().catch(() => ({}));

  // Modo especial: resetar TODOS os itens com ERRO (qualquer lote) de volta para fila
  if (body.mode === 'errors') {
    const result = await env.DB.prepare(
      `UPDATE audit_records
       SET status = 'PENDENTE', batch_id = NULL, ai_result_json = NULL, ai_error = NULL, updated_at = datetime('now')
       WHERE status = 'ERRO'`
    ).run();
    return jsonResponse({ ok: true, reset: result.meta?.changes ?? 0, msg: `${result.meta?.changes ?? 0} erro(s) resetados para a fila.` });
  }

  // Usa batch_id fornecido ou pega o último lote EM_ANDAMENTO
  let batchId = body.batch_id;
  if (!batchId) {
    const batch = await env.DB.prepare(
      `SELECT id FROM batches WHERE status IN ('EM_ANDAMENTO','CONCLUIDO') ORDER BY id DESC LIMIT 1`
    ).first();
    if (!batch) return jsonResponse({ error: 'nenhum lote encontrado' }, 404);
    batchId = batch.id;
  }

  // Reseta itens sem análise (produto_identificado NULL) OU com erro, de volta para PENDENTE
  const result = await env.DB.prepare(
    `UPDATE audit_records
     SET status = 'PENDENTE',
         batch_id = NULL,
         ai_result_json = NULL,
         ai_error = NULL,
         updated_at = datetime('now')
     WHERE batch_id = ?
       AND status IN ('PRONTO_PARA_REVISAO', 'ERRO', 'ANALISANDO')
       AND produto_identificado IS NULL`
  ).bind(batchId).run();

  const resetCount = result.meta?.changes ?? 0;

  // Marca o lote como concluído para que start-batch crie um novo
  if (resetCount > 0) {
    await env.DB.prepare(
      `UPDATE batches SET status = 'CONCLUIDO', updated_at = datetime('now') WHERE id = ?`
    ).bind(batchId).run();
  }

  return jsonResponse({
    ok: true,
    batch_id: batchId,
    reset: resetCount,
    msg: resetCount > 0
      ? `${resetCount} item(s) resetados para PENDENTE — adicione ANTHROPIC_API_KEY e processe novamente.`
      : 'Nenhum item sem análise encontrado neste lote.',
  });
}
