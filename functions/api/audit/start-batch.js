// functions/api/audit/start-batch.js
// POST /api/audit/start-batch
// Cria um lote com os próximos 10 registros elegíveis (PENDENTE), respeitando
// a ordem do Drive. Se já existir um lote EM_ANDAMENTO, retorna ele em vez de
// criar outro (permite "continuar lote interrompido" sem duplicar trabalho).

import { jsonResponse, corsPreflight, requireAuth } from './_shared.js';

const BATCH_SIZE = 15;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!requireAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  const openBatch = await env.DB.prepare(
    `SELECT id FROM batches WHERE status = 'EM_ANDAMENTO' ORDER BY id DESC LIMIT 1`
  ).first();

  if (openBatch) {
    return jsonResponse({ batch_id: openBatch.id, resumed: true });
  }

  const elegiveis = await env.DB.prepare(
    `SELECT id FROM audit_records WHERE status = 'PENDENTE' ORDER BY sort_key ASC LIMIT ?`
  )
    .bind(BATCH_SIZE)
    .all();

  const rows = elegiveis.results || [];
  if (rows.length === 0) {
    return jsonResponse({ error: 'sem_registros_pendentes' }, 404);
  }

  const batch = await env.DB.prepare(
    `INSERT INTO batches (status, total_items, processed_items, error_items) VALUES ('EM_ANDAMENTO', ?, 0, 0)`
  )
    .bind(rows.length)
    .run();
  const batchId = batch.meta.last_row_id;

  for (const r of rows) {
    await env.DB.prepare(`UPDATE audit_records SET batch_id = ? WHERE id = ?`)
      .bind(batchId, r.id)
      .run();
  }

  return jsonResponse({ batch_id: batchId, resumed: false, total: rows.length });
}
