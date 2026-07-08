// functions/api/audit/get-image.js
// GET /api/audit/get-image?id=ITEM_ID&pwd=SENHA
// Retorna a imagem editada salva no D1 (base64) como imagem visualizável.

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const pwd = url.searchParams.get('pwd') || request.headers.get('X-Admin-Password');
  if (pwd !== env.ADMIN_PASSWORD) return new Response('unauthorized', { status: 401 });
  if (!id) return new Response('missing id', { status: 400 });

  const row = await env.DB.prepare(
    `SELECT imagem_editada_base64 FROM audit_records WHERE id = ?`
  ).bind(id).first();

  if (!row?.imagem_editada_base64) return new Response('sem imagem salva', { status: 404 });

  const b64 = row.imagem_editada_base64;
  const mime = b64.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
  const clean = b64.replace(/^data:image\/\w+;base64,/, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new Response(bytes, {
    headers: { 'Content-Type': mime, 'Cache-Control': 'no-cache' },
  });
}
