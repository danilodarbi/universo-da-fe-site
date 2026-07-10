// functions/api/audit/generate-image.js
// POST /api/audit/generate-image  { item_id }
// Gera a foto profissional (estilo Joppa) automaticamente a partir da foto
// original do Drive, usando Gemini (GEMINI_API_KEY) ou OpenAI (OPENAI_API_KEY).
// Salva o resultado em imagem_editada_base64 — o usuário só compara e aprova.

import { jsonResponse, corsPreflight, requireAuth, fetchThumbnailAsBase64 } from './_shared.js';

const PROMPT = `Reproduce the exact product from this photo as a premium e-commerce product photograph. The product itself must stay 100% identical — same figure, same face, same colors, same gold/blue/pearl details, same crown, same base, same engravings, same proportions and same size. Copy it faithfully like a photograph, do NOT redraw, redesign or reinterpret any part of it.

BACKGROUND AND STYLE (match this exact look):
Place the product on a light cream travertine or warm-white marble surface with soft natural texture. In the background, softly blurred out of focus, add a few delicate green eucalyptus or olive branches on one side. Bright, airy, luminous scene with warm cream and ivory tones. Soft natural window daylight coming from the side, casting gentle soft shadows and delicate light patterns. Elegant, serene, reverent, high-end catholic boutique aesthetic (House of Joppa style).

FRAMING (very important — never crop):
Show the COMPLETE product fully inside the frame with comfortable empty space around every side. The entire product from top to bottom and side to side must be visible — crown, halo, base, hands, everything. Never cut off any part. Center the product as the clear hero. Keep the product's real proportions and real size feeling (a small statue looks small and delicate, a large one looks substantial).

CLEAN: remove any plastic packaging, price tag, sticker, label or clutter. Show only the clean product.

PHOTOREALISM: real professional product photograph, full-frame camera, soft studio daylight. Natural textures (resin, gold leaf, pearls, enamel), realistic soft shadows and gentle reflections. No CGI, no digital-art glow, no oversaturation, no plastic smoothing. It must look like a genuine photo.

Output one high-resolution photorealistic image of the complete uncropped product, beautifully staged.`;

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
  form.append('quality', 'medium'); // medium ~R$0,25/img (high era ~R$1). Input 1600px compensa.
  form.append('input_fidelity', 'high'); // fidelidade alta mantem o produto fiel mesmo em medium

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${(env.OPENAI_API_KEY || '').replace(/[\s\r\n]+/g, '')}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI: ${data.error?.message || res.status}`);
  return data.data?.[0]?.b64_json || null;
}
