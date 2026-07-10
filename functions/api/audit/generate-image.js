// functions/api/audit/generate-image.js
// POST /api/audit/generate-image  { item_id }
// Gera a foto profissional (estilo Joppa) automaticamente a partir da foto
// original do Drive, usando Gemini (GEMINI_API_KEY) ou OpenAI (OPENAI_API_KEY).
// Salva o resultado em imagem_editada_base64 — o usuário só compara e aprova.

import { jsonResponse, corsPreflight, requireAuth, fetchThumbnailAsBase64 } from './_shared.js';

const PROMPT = `Recreate this exact product photo as a premium e-commerce image. Study the product carefully and copy it with total fidelity.

THE PRODUCT MUST BE IDENTICAL TO THE ORIGINAL — copy it exactly:
Same figure/saint, same face and expression, same exact colors, same gold/silver/blue/pearl details, same crown, same halo, same base, same engravings, same bead count and bead colors, same crucifix, same proportions and same relative sizes between parts. Do NOT redraw, redesign, beautify, restyle or reinterpret any part. Treat every detail of the product as fixed and untouchable — reproduce it faithfully like a photograph of the same object.

SQUARE FRAMING — FIT THE WHOLE PRODUCT, NEVER CROP:
The image is square. Fit the COMPLETE product inside the square with comfortable empty margin on all four sides (at least 12%). Every part must be fully visible — top of crown/halo down to the base, and both sides. For tall items (statues, rosaries), scale them down so they fit entirely in the square without touching or exiting any edge. Center the product as the hero. Keep its real proportions — a small delicate item stays small and delicate.

CLEAN: remove plastic packaging, price tags, stickers, labels, rulers, hands and any clutter. Show only the clean product.

BACKGROUND (House of Joppa style):
Light warm-white marble or cream travertine surface with soft natural veining. A few blurred green eucalyptus or olive branches softly out of focus at the far edges (never covering the product). Bright, airy, luminous, cream and ivory tones. Soft natural window daylight from one side with gentle soft shadows.

PHOTOREALISM: real professional product photograph, full-frame camera, soft daylight. Natural textures (resin, gold leaf, pearls, enamel, metal), realistic soft shadows and reflections. No CGI, no digital-art glow, no oversaturation, no plastic smoothing. Must look like a genuine photo.

Output one square photorealistic image of the complete, uncropped, faithful product beautifully staged.`;

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
  form.append('size', '1024x1024'); // tamanho fixo mais barato (auto pode escolher 1536 = mais caro)
  form.append('quality', 'low'); // low ~R$0,10/img — a maioria sai boa; as que erram voce refaz
  // input_fidelity removido: dobrava o custo dos tokens de entrada. Input 1600px ja garante fidelidade.

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${(env.OPENAI_API_KEY || '').replace(/[\s\r\n]+/g, '')}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI: ${data.error?.message || res.status}`);
  return data.data?.[0]?.b64_json || null;
}
