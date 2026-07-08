// functions/api/audit/generate-image.js
// POST /api/audit/generate-image  { item_id }
// Gera a foto profissional (estilo Joppa) automaticamente a partir da foto
// original do Drive, usando Gemini (GEMINI_API_KEY) ou OpenAI (OPENAI_API_KEY).
// Salva o resultado em imagem_editada_base64 — o usuário só compara e aprova.

import { jsonResponse, corsPreflight, requireAuth, fetchThumbnailAsBase64 } from './_shared.js';

const PROMPT = `Edit the attached photo. This is a real product photograph of a Catholic devotional item (a saint statue, rosary, scapular, medal or similar). Turn it into a clean professional e-commerce image. Follow every rule with zero deviation.

ABSOLUTE RULE — THE PRODUCT ITSELF MUST STAY 100% IDENTICAL:
Keep the devotional item exactly as in the original — the same saint or religious figure, the same face, expression, pose, colors, paint details, material, texture, proportions and shape. Do NOT repaint, redesign, beautify, restyle or "improve" the product. Do NOT swap the saint. Do NOT change gold to silver or alter any color of the product. The product is untouchable.

REMOVE THESE THINGS (very important):
1. PLASTIC PACKAGING: if the product is inside a plastic bag, shrink wrap, blister, or any transparent/clear packaging, REMOVE the packaging completely and show the bare product clean, as if unwrapped. No plastic wrinkles, no reflections from plastic, no bag.
2. PRICE TAGS AND STICKERS: remove any price tag, price sticker, adhesive label, barcode, handwritten price, or paper tag attached to or near the product. The final image must have NO price and NO labels visible.
3. CLUTTER: remove any other product, hand, box, shelf clutter or distracting object. Show ONLY this single product.

WHAT TO CHANGE — BACKGROUND AND LIGHT:
Place the clean unwrapped product on a light warm-white marble or travertine surface, with soft eucalyptus or olive branches blurred in the background. Neutral cream, beige and ivory tones. Natural soft daylight from the side, gentle diffused shadows. Generous clean negative space around the product.

REALISM — MUST LOOK LIKE A REAL PHOTO, NOT AI:
Authentic photograph, professional camera, 50mm lens. Natural grain, true textures, realistic soft shadows, accurate reflections on the product surface. Keep the product's real imperfections. No digital-art look, no plastic-smooth skin, no glow, no CGI. Shallow depth of field with the product in sharp focus and the background softly blurred.

FORMAT: square, high resolution, editorial product photography, calm and reverent mood for a Catholic goods store. Output one single photorealistic image of the clean product on the new background.`;

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
    // Foto original em boa resolução
    const originalB64 = await fetchThumbnailAsBase64(env, item.thumbnail_link, item.drive_file_id);

    let generatedB64 = null;
    let provider = null;

    if (env.GEMINI_API_KEY) {
      provider = 'gemini';
      generatedB64 = await generateWithGemini(env, originalB64);
    } else {
      provider = 'openai';
      generatedB64 = await generateWithOpenAI(env, originalB64);
    }

    if (!generatedB64) throw new Error('IA não retornou imagem');

    const dataUrl = `data:image/png;base64,${generatedB64}`;

    // Verifica tamanho — se >1.5MB, é grande demais pro D1; nesse caso guarda aviso
    if (dataUrl.length > 1_500_000) {
      // Ainda salva mas em JPEG seria menor — por segurança, corta se absurdo
      if (dataUrl.length > 1_900_000) {
        throw new Error('Imagem gerada muito grande — tente novamente');
      }
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
  form.append('size', '1024x1024');
  form.append('quality', 'medium');

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${(env.OPENAI_API_KEY || '').replace(/[\s\r\n]+/g, '')}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI: ${data.error?.message || res.status}`);
  return data.data?.[0]?.b64_json || null;
}
