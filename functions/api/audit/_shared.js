// functions/api/audit/_shared.js
// Helpers compartilhados pelos endpoints de auditoria.

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export function corsPreflight() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
    },
  });
}

export function requireAuth(request, env) {
  const pwd = request.headers.get('X-Admin-Password');
  return pwd === env.ADMIN_PASSWORD;
}

export function normalizeTitle(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Similaridade simples por sobreposição de tokens (Jaccard) — suficiente para
// ranquear candidatos sem depender de libs externas no runtime do Worker.
export function tokenSimilarity(a, b) {
  const ta = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = new Set([...ta, ...tb]).size;
  return intersection / union;
}

export function topCandidates(queryText, products, limit = 3) {
  return products
    .map((p) => ({ ...p, score: tokenSimilarity(queryText, p.title) }))
    .filter((p) => p.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---- Google Drive: autenticação via Service Account (JWT Bearer, RS256) ----

function base64url(bytes) {
  let str = typeof bytes === 'string'
    ? btoa(unescape(encodeURIComponent(bytes)))
    : btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function signJwt(serviceAccount, scope) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: serviceAccount.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const encHeader = base64url(JSON.stringify(header));
  const encClaim = base64url(JSON.stringify(claimSet));
  const signingInput = `${encHeader}.${encClaim}`;

  const keyData = pemToArrayBuffer(serviceAccount.private_key);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64url(signature)}`;
}

export async function getDriveAccessToken(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não configurado');
  }
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const jwt = await signJwt(sa, 'https://www.googleapis.com/auth/drive.readonly');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Drive auth falhou: ${JSON.stringify(data)}`);
  return data.access_token;
}

export async function driveListFolder(env, folderId, pageToken) {
  const token = await getDriveAccessToken(env);
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'nextPageToken, files(id, name, mimeType, thumbnailLink, size, createdTime)',
    pageSize: '100',
    orderBy: 'createdTime',
  });
  if (pageToken) params.set('pageToken', pageToken);

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Drive list falhou: ${JSON.stringify(data)}`);
  return data; // { files: [...], nextPageToken? }
}

// Baixa o thumbnail JPEG que o próprio Google já gera (evita decodificar HEIC).
// thumbnailLink vem em baixa resolução por padrão; trocamos =sXXX por algo maior.
export async function fetchThumbnailAsBase64(env, thumbnailLink) {
  const token = await getDriveAccessToken(env);
  const url = thumbnailLink.replace(/=s\d+$/, '=s800');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Falha ao baixar thumbnail: ${res.status}`);
  const buf = await res.arrayBuffer();
  const b64 = base64url(buf).replace(/-/g, '+').replace(/_/g, '/');
  // Adiciona padding = necessário para Anthropic/OpenAI
  return b64 + '='.repeat((4 - b64.length % 4) % 4);
}

// ---- Anthropic Claude Vision ----

export async function analyzePhotoWithAnthropic(env, { imageBase64 }) {
  if (!env.ANTHROPIC_API_KEY) return null;

  const prompt = `Você é um especialista em artigos religiosos católicos brasileiros. Analise esta foto de produto para catalogação na loja "Universo da Fé".

Retorne SOMENTE um JSON válido, sem texto fora do JSON, neste formato exato:
{
  "descricao": "frase curta e objetiva descrevendo o produto",
  "categoria": "IMAGEM_DEVOCIONAL|TERCO|ESCAPULARIO|QUADRO|CHAVEIRO|PULSEIRA|DEZENA|KIT_DEVOCIONAL|OUTRO",
  "santo": "nome exato do santo ou devoção representada, ou null",
  "material": "resina|madeira|metal|tecido|acrílico|papel|misto|null",
  "altura_cm": número estimado em cm ou null,
  "cor": "descrição da cor principal e acabamento",
  "preco_sugerido_brl": número inteiro ou null,
  "preco_referencia": "justificativa do preço (ex: imagem resina 20cm mercado brasileiro ~R$50-70)",
  "titulo_shopify": "título no padrão: [Tipo] [Santo/Devoção] – [Detalhe | Tamanho | Material]",
  "descricao_shopify": "2-3 frases devocionais, tom respeitoso, max 320 chars",
  "confianca": 0.0,
  "necessita_revisao": true
}

REGRAS OBRIGATÓRIAS:
- altura_cm: estime comparando com objetos visíveis (mãos, prateleira, embalagem). Se impossível, null.
- preco_sugerido_brl: use referências do mercado brasileiro:
  Imagem resina 10-15cm → R$30-50 | 20cm → R$50-80 | 30cm → R$80-130 | 40cm+ → R$130-250
  Terço simples → R$20-35 | Terço madeira/pedra → R$35-70
  Escapulário simples → R$15-25 | Escapulário bordado/metálico → R$25-60
  Quadro/gravura → R$40-90 | Chaveiro → R$12-25 | Pulseira → R$15-35 | Dezena → R$10-20
- titulo_shopify: ex: "Imagem de São Bento – 20 cm | Resina" ou "Terço de Nossa Senhora Aparecida – Contas Azuis | Madeira"
- descricao_shopify: sem emojis, sem exclamações, sem clichês de venda
- confianca: 0.9 se tem certeza total, 0.7 se provavelmente, 0.4 se incerto
- necessita_revisao: false só se confianca >= 0.8 E todos os campos principais preenchidos
- NUNCA invente atributos não visíveis. Use null se não souber.
- Responda APENAS o JSON, sem markdown, sem explicações.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic: ${data.error?.message || res.status}`);
  const raw = data.content?.[0]?.text?.trim() || '{}';
  try {
    return JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
  } catch {
    // fallback: retorna só a descrição se JSON quebrar
    return { descricao: raw.slice(0, 300), confianca: 0.3, necessita_revisao: true };
  }
}

// ---- OpenAI ----

const RESPONSE_SCHEMA_HINT = `Responda SOMENTE com um JSON válido, sem texto fora do JSON, no formato exato:
{
  "audit_record_id": "",
  "produto_identificado": "",
  "categoria": "",
  "santo_devocao": "",
  "material": "",
  "cor": "",
  "altura": {"valor": null, "fonte": "AUDITORIA|REGUA|ETIQUETA|NAO_CONFIRMADO", "confianca": 0},
  "peso": {"valor": null, "fonte": "AUDITORIA|BALANCA|NAO_CONFIRMADO", "confianca": 0},
  "preco": {"valor": null, "fonte": "AUDITORIA|SHOPIFY|REFERENCIA_INTERNA|PENDENTE"},
  "titulo_recomendado": "",
  "descricao_recomendada": "",
  "shopify_product_id": "",
  "status_correspondencia": "",
  "confianca_correspondencia": 0,
  "evidencias": [],
  "conflitos": [],
  "informacoes_ausentes": [],
  "necessita_revisao": true
}
Regras: valores ausentes ficam null. NUNCA estime peso. NUNCA invente preço. NUNCA escreva texto fora do JSON.`;

export async function analyzePhotoWithOpenAI(env, { record, candidates, imageBase64 }) {
  const userText = `Registro da auditoria:
- ID: ${record.id}
- Arquivo: ${record.file_name}
- Pasta: ${record.drive_folder_id}

Candidatos Shopify semelhantes (até 3, por similaridade textual):
${candidates.map((c) => `- ${c.product_id} | "${c.title}" | tipo: ${c.product_type || 'n/d'}`).join('\n') || '(nenhum candidato encontrado)'}

${RESPONSE_SCHEMA_HINT}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0.2,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Você identifica produtos religiosos católicos (terços, escapulários, imagens de santos, joias devocionais) a partir de uma foto, para auditoria de catálogo. Seja conservador: se não tiver certeza, marque necessita_revisao=true e explique em conflitos/informacoes_ausentes.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          ],
        },
      ],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Erro OpenAI');
  const raw = data.choices[0]?.message?.content || '{}';
  return JSON.parse(raw);
}
