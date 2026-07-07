// functions/api/audit/thumb.js
// GET /api/audit/thumb?id=DRIVE_FILE_ID
// Proxy que busca o thumbnail JPEG do Google Drive (converte HEIC automaticamente)
// e serve para o navegador. Resolve HEIC não renderizar nativamente no browser.

import { getDriveAccessToken } from './_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Admin-Password',
    }});
  }

  const url = new URL(request.url);
  const fileId = url.searchParams.get('id');
  const size = url.searchParams.get('s') || '512';
  if (!fileId) return new Response('missing id', { status: 400 });

  // Auth leve: aceita senha via query (imagens não mandam header)
  const pwd = url.searchParams.get('pwd') || request.headers.get('X-Admin-Password');
  if (pwd !== env.ADMIN_PASSWORD) return new Response('unauthorized', { status: 401 });

  try {
    const token = await getDriveAccessToken(env);
    // Pega o thumbnailLink atualizado da API (Drive gera JPEG mesmo de HEIC)
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!metaRes.ok) return new Response('drive meta error', { status: 502 });
    const meta = await metaRes.json();
    if (!meta.thumbnailLink) return new Response('sem thumbnail', { status: 404 });

    const imgRes = await fetch(meta.thumbnailLink.replace(/=s\d+$/, '=s' + size));
    if (!imgRes.ok) return new Response('thumbnail fetch error', { status: 502 });

    const buf = await imgRes.arrayBuffer();
    return new Response(buf, {
      headers: {
        'Content-Type': imgRes.headers.get('Content-Type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response('erro: ' + e.message, { status: 500 });
  }
}
