// functions/api/audit/generate-image.js
// POST /api/audit/generate-image  { item_id }
// Gera a foto profissional (estilo Joppa) automaticamente a partir da foto
// original do Drive, usando Gemini (GEMINI_API_KEY) ou OpenAI (OPENAI_API_KEY).
// Salva o resultado em imagem_editada_base64 — o usuário só compara e aprova.

import { jsonResponse, corsPreflight, requireAuth, fetchThumbnailAsBase64 } from './_shared.js';

const PROMPT = `Keep the product in this photo EXACTLY as it is — do not redraw, restructure or reinterpret it. Same exact beads (same count, colors, sizes and order), same chain, same medals, same crucifix, same pendant, same layout and proportions. Treat the product as a fixed object that must be copied pixel-faithfully.

Only replace the background and lighting: place the untouched product on a light warm-white marble surface with a few blurred eucalyptus branches at the far edges, soft natural side daylight, cream and ivory tones, House of Joppa style.

Remove any plastic packaging, price tag, sticker, ruler and clutter — show only the clean product.

Show the COMPLETE product with margin around all edges — never crop any part. Keep the original photo orientation and the product's real proportions.

Result must be a realistic photograph, not AI art: natural grain, true textures, real soft shadows. No CGI, no glow, no smoothing.`;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!requireAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  if (!env.GEMINI_API_KEY && !env.OPENAI_API_KEY) {
    return jsonResponse({ error: 'Configure GEMINI_API_KEY (recomendado) ou OPENAI_API_KEY no Cloudflare para gerar imagens.' }, 400);
  }

  const body = await request.json().catch(() => ({}));
  const itemId = body.item_id;
  if (!itemId) return jsonResponse({ error: 'missing item_id' }, 400);

  const item = await env.DB.prepare(`SELECT * FROM audit_records WHERE id = ?`).bind(itemId).first();
  if (!item) return jsonResponse({ error: 'item não encontrado' }, 404);
  if (!item.thumbnail_link && !item.drive_file_id) return jsonResponse({ error: 'item sem foto original' }, 400);

  try {
    // Foto original em ALTA resolução (1600px) — input de qualidade é o que
    // define a fidelidade do resultado. Antes era 768px, por isso saía artificial.
    const originalB64 = await fetchThumbnailAsBase64(env, item.thumbnail_link, item.drive_file_id, 1600);

    let generatedB64 = null;
    let provider = null;

    // OpenAI (gpt-image-1) é o mesmo motor do ChatGPT — resultado muito melhor.
    // Prioriza OpenAI; usa Gemini só se não houver chave OpenAI.
    if (env.OPENAI_API_KEY) {
      provider = 'openai';
      generatedB64 = await generateWithOpenAI(env, originalB64);
    } else {
      provider = 'gemini';
      generatedB64 = await generateWithGemini(env, originalB64);
    }

    if (!generatedB64) throw new Error('IA não retornou imagem');

    // Comprime a imagem gerada para caber no D1 (limite ~2MB por valor).
    // A OpenAI retorna PNG grande (1-4MB) — reduzimos via redimensionamento
    // simples de qualidade não é possível sem canvas no worker, então
    // guardamos como está mas validamos o tamanho com margem segura.
    let dataUrl = `data:image/png;base64,${generatedB64}`;

    // Se a imagem for grande demais, o frontend vai comprimir no próximo passo.
    // Aqui salvamos direto; se exceder 1.8MB avisamos para regenerar menor.
    if (dataUrl.length > 1_800_000) {
      // Retorna a imagem para o frontend comprimir e reenviar
      return jsonResponse({
        ok: true,
        provider,
        needs_compression: true,
        image_base64: dataUrl,
        msg: 'Foto gerada — comprimindo…',
      });
    }

    await env.DB.prepare(
      `UPDATE audit_records SET imagem_editada_base64 = ?, imagem_enviada = 1, updated_at = datetime('now') WHERE id = ?`
    ).bind(dataUrl, itemId).run();

    return jsonResponse({ ok: true, provider, msg: 'Foto gerada — compare com a original nas abas.' });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ── Gemini (Nano Banana — gemini-2.5-flash-image) ─────────────────────────────
async function generateWithGemini(env, imageB64) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${(env.GEMINI_API_KEY || '').replace(/[\s\r\n]+/g, '')}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: 'image/jpeg', data: imageB64 } },
            { text: PROMPT },
          ],
        }],
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini: ${data.error?.message || res.status}`);
  const parts = data.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    if (p.inline_data?.data) return p.inline_data.data;
    if (p.inlineData?.data) return p.inlineData.data;
  }
  throw new Error('Gemini não retornou imagem (pode ter recusado o conteúdo)');
}

// ── OpenAI (gpt-image-1 edits) ─────────────────────────────────────────────────
async function generateWithOpenAI(env, imageB64) {
  // Converte base64 → bytes para multipart
  const binary = atob(imageB64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'original.jpg');
  form.append('prompt', PROMPT);
  form.append('size', 'auto');
  form.append('quality', 'high');
  form.append('input_fidelity', 'high');

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${(env.OPENAI_API_KEY || '').replace(/[\s\r\n]+/g, '')}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI: ${data.error?.message || res.status}`);
  return data.data?.[0]?.b64_json || null;
}
