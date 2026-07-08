// functions/api/audit/review-action.js
// POST /api/audit/review-action
// { item_id, action, fields?, note? }
// action ∈ APROVAR | CORRIGIR | REPROVAR | PULAR | SOLICITAR_NOVA_FOTO | VINCULAR_OUTRO_PRODUTO
//
// Esta fase NÃO toca a Shopify — só grava a decisão. O envio real (fase 2)
// vai ler os registros com status = APROVADO.

import { jsonResponse, corsPreflight, requireAuth } from './_shared.js';

const VALID_ACTIONS = new Set([
  'APROVAR',
  'CORRIGIR',
  'REPROVAR',
  'PULAR',
  'SOLICITAR_NOVA_FOTO',
  'VINCULAR_OUTRO_PRODUTO',
]);

// Campos editáveis que a tela de revisão pode sobrescrever em CORRIGIR/VINCULAR_OUTRO_PRODUTO
const EDITABLE = [
  'produto_identificado', 'categoria', 'santo_devocao', 'material', 'cor',
  'altura_valor', 'altura_fonte', 'altura_confianca',
  'peso_valor', 'peso_fonte', 'peso_confianca',
  'preco_valor', 'preco_fonte',
  'titulo_recomendado', 'descricao_recomendada',
  'shopify_product_id', 'status_correspondencia', 'confianca_correspondencia',
];

const HARD_BLOCKS_ON_APROVAR = (item) => {
  const conflitos = safeParse(item.conflitos_json);
  if (conflitos.length > 0) return 'conflito não resolvido';
  // Permite aprovação se produto foi vinculado manualmente (shopify_product_id) mesmo sem descrição IA
  if (!item.produto_identificado && !item.shopify_product_id) return 'produto não identificado — vincule um produto Shopify ou use Editar';
  if ((item.confianca_correspondencia ?? 0) < 0.6) return 'confiança de correspondência baixa — vincule um produto Shopify';
  return null;
};

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!requireAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  const body = await request.json().catch(() => ({}));
  const { item_id, action, fields, note } = body;

  if (!item_id || !VALID_ACTIONS.has(action)) {
    return jsonResponse({ error: 'invalid_request' }, 400);
  }

  const item = await env.DB.prepare(`SELECT * FROM audit_records WHERE id = ?`).bind(item_id).first();
  if (!item) return jsonResponse({ error: 'not_found' }, 404);

  // aplica edições de campo, se vierem (CORRIGIR / VINCULAR_OUTRO_PRODUTO)
  if (fields && typeof fields === 'object') {
    const sets = [];
    const vals = [];
    for (const key of EDITABLE) {
      if (key in fields) {
        sets.push(`${key} = ?`);
        vals.push(fields[key]);
      }
    }
    if (sets.length) {
      vals.push(item_id);
      await env.DB.prepare(`UPDATE audit_records SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .bind(...vals)
        .run();
    }
  }

  const refreshed = await env.DB.prepare(`SELECT * FROM audit_records WHERE id = ?`).bind(item_id).first();

  let newStatus;
  switch (action) {
    case 'APROVAR': {
      const blockReason = HARD_BLOCKS_ON_APROVAR(refreshed);
      if (blockReason) {
        return jsonResponse({ error: 'aprovacao_bloqueada', reason: blockReason }, 422);
      }
      newStatus = 'APROVADO';
      break;
    }
    case 'CORRIGIR':
      newStatus = refreshed.status; // mantém o status atual — só atualiza os campos, item não muda de aba
      break;
    case 'REPROVAR':
      newStatus = 'REPROVADO';
      break;
    case 'PULAR':
      newStatus = refreshed.status; // mantém como está, só avança a fila na UI
      break;
    case 'SOLICITAR_NOVA_FOTO':
      newStatus = 'PRECISA_DE_NOVA_FOTO';
      break;
    case 'VINCULAR_OUTRO_PRODUTO':
      newStatus = 'PRONTO_PARA_REVISAO'; // volta pra fila de revisão com o novo vínculo já gravado
      break;
  }

  await env.DB.prepare(
    `UPDATE audit_records SET status = ?, reviewer_note = ?, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  )
    .bind(newStatus, note || refreshed.reviewer_note, item_id)
    .run();

  return jsonResponse({ ok: true, item_id, status: newStatus });
}

function safeParse(s) {
  try {
    return JSON.parse(s || '[]');
  } catch {
    return [];
  }
}
