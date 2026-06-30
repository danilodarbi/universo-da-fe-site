// functions/api/audit/sync-drive.js
// POST /api/audit/sync-drive
// Lista as duas pastas do Drive e faz upsert em audit_records.
// Não sobrescreve status/decisões já existentes — só insere registros novos
// e atualiza metadados (thumbnail, nome) de registros já conhecidos.

import { jsonResponse, corsPreflight, requireAuth, driveListFolder } from './_shared.js';

const FOLDERS = [
  '1fzzaoZF-hGXdDtcp2DDWtnLUWKIFSLxI', // Pasta 1 — resina
  '1xJGzqUFk67eSohxRKvMkhPv3VGG6B6xt', // Pasta 2 — joias/acessórios
];

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!requireAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  let inserted = 0;
  let updated = 0;
  const errors = [];

  for (const folderId of FOLDERS) {
    let pageToken = undefined;
    do {
      try {
        const page = await driveListFolder(env, folderId, pageToken);
        for (const f of page.files || []) {
          if (!f.mimeType?.startsWith('image/')) continue; // ignora HEIC sem thumbnail, pastas, etc — Drive já filtra a maioria
          const sortKey = `${f.createdTime || ''}_${f.name}`;

          const existing = await env.DB.prepare(
            'SELECT id FROM audit_records WHERE drive_file_id = ?'
          )
            .bind(f.id)
            .first();

          if (existing) {
            await env.DB.prepare(
              `UPDATE audit_records SET file_name = ?, thumbnail_link = ?, file_size = ?, updated_at = datetime('now') WHERE drive_file_id = ?`
            )
              .bind(f.name, f.thumbnailLink || null, f.size ? Number(f.size) : null, f.id)
              .run();
            updated++;
          } else {
            await env.DB.prepare(
              `INSERT INTO audit_records
                (drive_file_id, drive_folder_id, file_name, mime_type, thumbnail_link, file_size, created_time, sort_key, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE')`
            )
              .bind(
                f.id,
                folderId,
                f.name,
                f.mimeType,
                f.thumbnailLink || null,
                f.size ? Number(f.size) : null,
                f.createdTime || null,
                sortKey
              )
              .run();
            inserted++;
          }
        }
        pageToken = page.nextPageToken;
      } catch (e) {
        errors.push(`Pasta ${folderId}: ${e.message}`);
        pageToken = undefined;
      }
    } while (pageToken);
  }

  return jsonResponse({ inserted, updated, errors });
}
