// functions/api/audit/generate-image.js
// POST /api/audit/generate-image  { item_id }
// Gera a foto profissional (estilo Joppa) automaticamente a partir da foto
// original do Drive, usando Gemini (GEMINI_API_KEY) ou OpenAI (OPENAI_API_KEY).
// Salva o resultado em imagem_editada_base64 — o usuário só compara e aprova.

import { jsonResponse, corsPreflight, requireAuth, fetchThumbnailAsBase64 } from './_shared.js';

const PROMPT = `Professional product photography edit. The attached photo shows a real Catholic devotional product sold by a store. Recreate it as a premium e-commerce photo in the style of the brand "House of Joppa": bright, airy, serene, editorial.

THE PRODUCT IS SACRED — REPRODUCE IT EXACTLY:
Reproduce the product with complete fidelity: same saint/figure, same face and expression, same colors, same metal tone (silver stays silver, gold stays gold), same bead count and bead color and bead size, same crucifix design, same medal engravings, same cord/chain type, same proportions. Zero creative liberty on the product itself.

FRAMING — SHOW THE ENTIRE PRODUCT, NEVER CROP IT:
The COMPLETE product must be visible inside the frame, from end to end — the full chain/cord, every bead, the whole crucifix, the entire statue from base to top. Leave a comfortable margin of empty background around all sides of the product (at least 10% of the frame on every side). Do NOT zoom in so much that any part gets cut off. Do NOT let the crucifix, medal, cord ends or statue base touch or exit the frame edges.

SCALE AND PROPORTIONS — KEEP THEM REAL:
Preserve the true real-world size relationships: bead diameter vs crucifix length vs medal size vs chain thickness must match the reference photo exactly. Do not enlarge the crucifix, do not shrink the beads, do not stretch or compress the product. A small delicate item must still look small and delicate; a large statue must look substantial. The product occupies a natural, realistic amount of the frame — centered, with breathing room.

CLEAN THE PRODUCT (remove everything that is not the product):
- Remove plastic bags, shrink wrap, blisters, backing cards and packaging completely
- Remove price tags, stickers, barcodes, handwritten labels
- Remove pins, clips, hands, boxes and any clutter
- Show the bare product alone, professionally unwrapped and styled

SCENE (House of Joppa signature look):
- Surface: light warm-white marble or creamy travertine stone with subtle natural veining
- Props: a few sprigs of eucalyptus or olive branches at the far edges of the frame, softly out of focus — they never touch or cover the product
- Palette: warm white, cream, ivory, soft beige — bright and luminous
- Light: soft natural window daylight from one side, delicate elongated shadows, gentle highlights on metal and beads
- Composition: flat lay (top-down) for rosaries/chaplets/scapulars/bracelets laid out fully extended and untangled; standing at slight angle for statues; generous negative space; product centered as the hero

PHOTOREALISM (critical — must NOT look AI-generated):
Looks like a photo from a professional product photographer with a full-frame camera and 50mm macro lens. Fine natural film grain, true material textures (pearl sheen, metal patina, wood grain), physically-accurate soft shadows and reflections, slight natural imperfections preserved. No digital-art smoothness, no HDR glow, no oversaturation, no plastic look, no painterly strokes, no CGI feel.

OUTPUT: one square high-resolution photorealistic image of the exact same product, complete and uncropped, cleaned and beautifully staged.`;

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
  form.append('size', '1024x1024');
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
