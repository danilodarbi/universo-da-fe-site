// functions/api/audit/batch-status.js
// GET /api/audit/batch-status?batch_id=123
// Retorna o lote e todos os seus itens com o estado atual — usado pela tela
// de revisão e para retomar um lote interrompido (a UI só precisa pedir isso
// de novo, não precisa guardar nada localmente).

import { jsonResponse, corsPreflight, requireAuth } from './_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  if (!requireAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const batchId = url.searchParams.get('batch_id');

  let batch;
  if (batchId) {
    batch = await env.DB.prepare(`SELECT * FROM batches WHERE id = ?`).bind(batchId).first();
  } else {
    batch = await env.DB.prepare(
      `SELECT * FROM batches WHERE status = 'EM_ANDAMENTO' ORDER BY id DESC LIMIT 1`
    ).first();
  }

  if (!batch) return jsonResponse({ error: 'not_found' }, 404);

  const items = await env.DB.prepare(
    `SELECT * FROM audit_records WHERE batch_id = ? ORDER BY sort_key ASC`
  )
    .bind(batch.id)
    .all();

  const parsed = (items.results || []).map((r) => ({
    ...r,
    evidencias: safeParse(r.evidencias_json),
    conflitos: safeParse(r.conflitos_json),
    informacoes_ausentes: safeParse(r.informacoes_ausentes_json),
  }));

  return jsonResponse({ batch, items: parsed });
}

function safeParse(s) {
  try {
    return JSON.parse(s || '[]');
  } catch {
    return [];
  }
}
