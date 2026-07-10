// functions/api/audit/generate-image.js
// POST /api/audit/generate-image  { item_id }
// Gera a foto profissional (estilo Joppa) automaticamente a partir da foto
// original do Drive, usando Gemini (GEMINI_API_KEY) ou OpenAI (OPENAI_API_KEY).
// Salva o resultado em imagem_editada_base64 — o usuário só compara e aprova.

import { jsonResponse, corsPreflight, requireAuth, fetchThumbnailAsBase64 } from './_shared.js';

const PROMPT = `You are editing a real product photo for a premium Catholic store catalog (House of Joppa aesthetic). Your ONLY job is to replace the background and lighting. The product must remain a perfect, unaltered copy of the original.

═══ RULE #1 — THE PRODUCT IS FROZEN, COPY IT EXACTLY ═══
Reproduce the product pixel-faithfully, as if it were cut out from the original photo and placed on a new background:
• Same saint/figure, same face, same expression, same pose — do not redraw the face
• Same exact colors on every part (do not shift gold, silver, blue, white, red, pearl tones)
• Same crown, halo, base, hands, mantle, engravings and ornaments
• Same bead count, bead colors, bead sizes, crucifix and medals (for rosaries)
• ANY TEXT, LETTERS, WORDS or ENGRAVED INSCRIPTIONS must stay EXACTLY the same — do not change, translate, invent or blur letters. If the base says "N. SRA. APARECIDA", it must still say exactly that.
• Same proportions and same relative sizes between all parts
Do NOT beautify, restyle, smooth, "improve", modernize or reinterpret ANYTHING about the product. Treat it as a fixed, sacred object.

═══ RULE #2 — SHOW THE COMPLETE PRODUCT, NEVER CROP ═══
The frame is square. Fit the ENTIRE product inside with generous margin (15%) on all four sides. Everything visible: top of crown/halo to bottom of base, full width. For tall items, scale down so nothing touches or exits the edges. Center the product.

═══ RULE #3 — CLEAN ═══
Remove plastic packaging, price tags, stickers, labels, rulers, hands, backing cards and any clutter. Only the clean product remains.

═══ RULE #4 — BACKGROUND (House of Joppa signature) ═══
Place the product on a light warm-white marble or cream travertine surface with subtle natural veining. Add a few soft, blurred green eucalyptus or olive branches at the far edges of the frame (out of focus, never covering the product). Bright, airy, luminous scene in cream, ivory and warm-white tones. Soft natural window daylight from one side, gentle diffused shadows, delicate light on the product.

═══ RULE #5 — REAL PHOTO, NOT AI ═══
Full-frame camera look, 50mm lens, professional product photography. Natural material textures (resin, gold leaf, pearls, enamel, painted details), physically-accurate soft shadows and reflections. No CGI, no digital-art glow, no oversaturation, no plastic smoothing, no painterly look. It must look like a genuine photograph.

Output one square, photorealistic image: the exact same product, complete and uncropped, on the beautiful clean background.`;

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
  form.append('quality', 'medium'); // medium + fidelity = ~R$0,30, mantém produto e texto fiéis
  form.append('input_fidelity', 'high'); // ESSENCIAL para não mudar o produto/gravações/texto

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${(env.OPENAI_API_KEY || '').replace(/[\s\r\n]+/g, '')}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI: ${data.error?.message || res.status}`);
  return data.data?.[0]?.b64_json || null;
}
