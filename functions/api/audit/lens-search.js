// functions/api/audit/lens-search.js
// POST /api/audit/lens-search  { image_base64 }
// Recebe uma foto, usa a IA (Claude) para identificar o tipo/santo do produto
// e devolve um termo de busca para filtrar o catálogo (estilo Google Lens).

import { jsonResponse, corsPreflight, requireAuth } from './_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!requireAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  if (!env.ANTHROPIC_API_KEY) return jsonResponse({ error: 'ANTHROPIC_API_KEY não configurada' }, 400);

  const body = await request.json().catch(() => ({}));
  let imageB64 = body.image_base64;
  if (!imageB64) return jsonResponse({ error: 'sem imagem' }, 400);

  // Remove prefixo data: se vier
  const mimeMatch = imageB64.match(/^data:(image\/\w+);base64,/);
  const mediaType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  imageB64 = imageB64.replace(/^data:image\/\w+;base64,/, '');

  const prompt = `Olhe esta foto de um produto religioso católico. Responda APENAS com o nome do santo/devoção principal e o tipo de produto, em 2 a 4 palavras, para usar como busca. Exemplos de resposta: "Nossa Senhora Aparecida", "São Bento terço", "escapulário Carmo", "São Miguel imagem". Não escreva mais nada além dessas poucas palavras.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': (env.ANTHROPIC_API_KEY || '').replace(/[\s\r\n]+/g, ''),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 40,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageB64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'erro na IA');
    let termo = (data.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '').slice(0, 60);
    // Pega só a palavra-chave mais forte (santo) para busca ampla
    return jsonResponse({ ok: true, termo });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
