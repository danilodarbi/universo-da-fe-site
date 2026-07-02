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
  if (typeof bytes === 'string') {
    return btoa(unescape(encodeURIComponent(bytes)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // Conversão em chunks para evitar "Maximum call stack size exceeded"
  // em imagens grandes (spread de Uint8Array enorme estoura o call stack)
  const uint8 = new Uint8Array(bytes);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < uint8.length; i += CHUNK) {
    binary += String.fromCharCode(...uint8.slice(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
  const url = thumbnailLink.replace(/=s\d+$/, '=s400');
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

  const prompt = `Você é o melhor catalogador de artigos religiosos católicos brasileiros do país, com 25 anos de experiência e conhecimento profundo de iconografia sacra, mercado varejista ES/Brasil e fotografia de produto. Analisa fotos para a loja "Universo da Fé" (Guarapari/ES).

═══ PASSO 1 — QUALIDADE DA FOTO ═══
Avalie antes de tudo:
- A foto está nítida ou borrada?
- A iluminação é adequada ou há sombras/escuridão?
- O produto está em embalagem (caixa/saco plástico) ou exposto?
- Há múltiplos produtos no enquadramento?
Se a foto for ruim demais para identificação: confianca < 0.3 e alerta obrigatório.

═══ PASSO 2 — TIPO DO PRODUTO ═══
Identifique com precisão:
• IMAGEM_DEVOCIONAL: estátua/imagem de santo em resina, madeira, gesso, metal
• TERCO: rosário completo com 59 contas (5 grupos de 10 + separadores + crucifixo)
• DEZENA: apenas 10 contas + crucifixo + medalha (menor que terço)
• ESCAPULARIO: dois pedaços de tecido/metal unidos por cordão/corrente
• QUADRO: imagem impressa ou pintada em suporte plano (tela, madeira, papel, acrílico)
• CHAVEIRO: argola metálica + elemento devocional
• PULSEIRA: aro ou elástico com contas/medalhas devocionais
• KIT_DEVOCIONAL: conjunto de 2+ itens diferentes embalados juntos
• OUTRO: vela, incenso, água benta, terço de parede, medalha avulsa, etc.

═══ PASSO 3 — IDENTIFICAÇÃO DO SANTO ═══
Use a iconografia. Seja conservador: se não tiver certeza, escreva o que VÊ.

IMAGENS/ESTÁTUAS — atributos visuais específicos:
• São Bento: HÁBITO PRETO beneditino, cálice com serpente na mão, corvo ao lado, medalha redonda com cruz
• São Francisco de Assis: HÁBITO MARROM, animais ao redor (pombas, lobo), mãos com estigmas, pomba no ombro
• Nossa Senhora Aparecida: figura PEQUENA e NEGRA (cerâmica queimada), coroa dourada, manto azul/dourado — ATENÇÃO: bem menor que outras imagens
• Nossa Senhora das Graças / Medianeira: braços abertos para BAIXO, raios de luz saindo das mãos, globo terrestre
• Nossa Senhora de Fátima: manto BRANCO com borda dourada, mãos unidas em oração, expressão de doçura
• Nossa Senhora do Carmo: manto MARROM/OURO, escapulário marrom na mão, às vezes Menino Jesus no braço
• Nossa Senhora Aparecida grande: mesma figura negra mas em versão maior para altar
• Imaculada Conceição: veste BRANCA, manto AZUL, mãos unidas, lua crescente embaixo dos pés, rosas
• Nossa Senhora de Lourdes: BRANCA, cinto AZUL, gruta ao fundo, expressão contemplativa
• Nossa Senhora Desatadora dos Nós: fita com nós sendo desatada, pomba, manto branco/azul
• Nossa Senhora do Perpétuo Socorro: ícone PLANO (não estátua), Menino Jesus nos braços de Maria com anjos segurando instrumentos da Paixão
• Nossa Senhora da Penha: imagem no alto de uma ROCHA/pedra, coroa, manto
• Sagrado Coração de Jesus: CORAÇÃO exposto no peito com chamas e coroa de espinhos, dedo apontando para o coração
• Jesus Misericordioso: figura de Jesus com RAIOS vermelho e branco saindo do coração, mão direita levantada
• Divino Espírito Santo: POMBA BRANCA com asas abertas, halo dourado, línguas de fogo
• Santo Antônio: HÁBITO MARROM franciscano, Menino Jesus NOS BRAÇOS, livro na outra mão — DIFERENÇA de São Francisco: Santo Antônio tem o Menino Jesus
• São José: homem com BARBA, cetro com LÍRIO BRANCO, Menino Jesus ao lado/no braço
• Padre Pio: HÁBITO MARROM capuchinho, BARBA, LUVAS/MITTENS nas mãos cobrindo estigmas
• São Jorge: ARMADURA metálica, cavalo branco, LANÇA ou espada, DRAGÃO embaixo do cavalo
• Santa Rita: ESPINHO na TESTA, rosas ao redor, hábito agostiniano ESCURO
• São Sebastião: corpo AMARRADO em árvore ou coluna, FLECHAS cravadas no corpo
• Santa Luzia: OLHOS em bandeja ou prato, palma do martírio, hábito vermelho
• São João Batista: PELE DE ANIMAL (cordeiro/camelo), cajado com CRUZ no topo, cordeiro ao lado
• São Miguel Arcanjo: ASAS, ARMADURA, lança apontada para DEMÔNIO embaixo dos pés
• Anjo da Guarda: ASAS, geralmente guiando criança, veste branca ou colorida
• São Cristóvão: GIGANTE com CRIANÇA nos ombros atravessando rio, bastão de árvore
• Santa Teresinha: hábito carmelita MARROM/BEGE, rosas, crucifixo com rosas
• São Roque: ferida exposta na PERNA, CAO ao lado, trajes de PEREGRINO

TERÇOS E ESCAPULÁRIOS — observe:
• Cor das contas (azul=NS Aparecida, branca=NS Fátima, verde=NS Perpetuo Socorro, preta=São Bento, marrom=NS Carmo, vermelha=Sagrado Coração)
• Material das contas: plástico, madeira, pedra (olho de tigre, madrepérola, hematita, turmalina)
• Cor e material do crucifixo: dourado, prateado, madeira
• Tipo de cordão/corrente: fio nylon, corrente metálica, fio de seda, cordão de couro

SE O SANTO NÃO ESTIVER NA LISTA ACIMA: descreva o que você vê (cor do hábito, objetos nas mãos, atributos) e marque confianca < 0.5.

═══ PASSO 4 — ESTIMATIVA DE TAMANHO ═══
Use APENAS referências visuais presentes na foto. Nunca estime sem referência.
• Mãos de adulto visíveis: palma ≈ 9-10cm, largura ≈ 8cm, comprimento total ≈ 18cm
• Se a imagem cabe na palma da mão = ~10-15cm
• Se a imagem tem a altura de um adulto segurando = ~20-30cm
• Caixa de papelão para imagem de 20cm tem ~22cm de altura
• Caixa de papelão para imagem de 30cm tem ~33cm de altura
• Prateleira padrão tem ~30-35cm de altura
• Se SEM referência: altura_cm = null e alerta obrigatório

═══ PASSO 5 — PRECIFICAÇÃO ═══
Referências mercado ES (Guarapari/Grande Vitória) 2025:
Imagem resina: 10cm→R$25-40 | 15cm→R$40-60 | 20cm→R$55-85 | 25cm→R$80-120 | 30cm→R$100-150 | 40cm→R$150-230 | 50cm+→R$230-400
Imagem madeira: +35-50% sobre resina equivalente
Imagem metal/zamac: R$45-200 dependendo tamanho
Terço plástico/acrílico: R$18-30 | Terço madeira: R$35-60 | Terço pedra semipreciosa: R$50-100 | Terço metal: R$45-90
Dezena: R$12-25 | Escapulário simples (tecido): R$15-28 | Escapulário metal/bordado: R$28-65
Quadro pequeno (<A4): R$35-65 | Médio (A4): R$55-100 | Grande: R$90-200
Chaveiro: R$12-25 | Pulseira: R$18-45 | Kit devocional: R$45-100

RETORNE SOMENTE este JSON válido, sem texto antes ou depois, sem markdown:
{
  "descricao": "frase completa: [tipo] de [santo/devoção] em [material], [tamanho se conhecido], [cor/detalhe principal]",
  "categoria": "IMAGEM_DEVOCIONAL|TERCO|DEZENA|ESCAPULARIO|QUADRO|CHAVEIRO|PULSEIRA|KIT_DEVOCIONAL|OUTRO",
  "santo": "nome completo e preciso, ex: Nossa Senhora de Fátima — ou 'Não identificado: [descreva o que vê]'",
  "material": "resina|madeira|metal|tecido|acrílico|papel|gesso|zamac|misto|null",
  "altura_cm": número inteiro ou null,
  "cor": "cores dominantes e tipo de acabamento, ex: branco com detalhes dourados, base oval bege",
  "preco_sugerido_brl": número inteiro ou null,
  "preco_referencia": "tabela usada + justificativa, ex: imagem resina 20cm mercado ES 2025 ≈ R$55-85, sugerindo R$65 pelo acabamento médio",
  "titulo_shopify": "máx 60 chars — padrão: [Santo] – [Tipo] [Detalhe | Tamanho]",
  "descricao_shopify": "2-3 frases devocionais, tom respeitoso e acolhedor, sem emojis, sem exclamações, max 300 chars",
  "qualidade_foto": "BOA|REGULAR|RUIM",
  "produto_embalado": true,
  "multiplos_produtos": false,
  "confianca": 0.0,
  "necessita_revisao": true,
  "alertas": []
}

REGRAS FINAIS:
• confianca 0.85-1.0: certeza total — santo claro, material visível, categoria óbvia
• confianca 0.65-0.84: provável — alguma dúvida em um campo
• confianca 0.40-0.64: incerto — santo duvidoso, foto parcial, estimativa de tamanho sem referência
• confianca 0.00-0.39: muito incerto — foto ruim, produto irreconhecível
• necessita_revisao = false SOMENTE SE confianca >= 0.80 E santo identificado (não "Não identificado") E categoria definida
• alertas[]: SEMPRE preencha quando: santo incerto, tamanho sem referência, foto com problema, embalagem tampando, múltiplos produtos, confusão possível entre dois santos
• NUNCA invente. Se não vê, escreve null ou "Não identificado"
• titulo_shopify: ex "São Bento – Imagem Resina 20 cm" ou "Nossa Senhora Aparecida – Imagem Resina" ou "Terço de São Bento – Contas Pretas | Madeira"`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      temperature: 0,
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
  // Extrai JSON da resposta mesmo se vier com blocos de código markdown
  const text = data.content?.[0]?.text || '{}';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const raw = (start >= 0 && end > start) ? text.slice(start, end + 1) : '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return { descricao: text.slice(0, 300), confianca: 0.2, necessita_revisao: true, alertas: ['Resposta da IA não era JSON válido — revisar manualmente'] };
  }
}

  const prompt = `Você é um catalogador especialista em artigos religiosos católicos brasileiros com 20 anos de experiência. Analisa fotos para a loja "Universo da Fé".

EXECUTE ESTE RACIOCÍNIO antes de responder:
1. Tipo de produto: é uma imagem/estátua, terço, escapulário, quadro, chaveiro, pulseira, dezena (10 contas) ou kit?
2. Santo ou devoção — use a iconografia:
   - São Bento: hábito beneditino PRETO, cálice com serpente, corvo, medalha redonda
   - São Francisco de Assis: hábito MARROM, animais ao redor, estigmas, pomba
   - Nossa Senhora Aparecida: figura PEQUENA e NEGRA (cerâmica), coroa dourada, manto azul/dourado
   - Nossa Senhora das Graças: braços abertos para baixo, raios de luz nas mãos
   - Nossa Senhora de Fátima: manto branco com borda dourada, expressão suave
   - Nossa Senhora do Carmo: manto marrom/ouro, escapulário na mão
   - Sagrado Coração de Jesus: coração exposto no peito com chamas e coroa de espinhos
   - Divino Espírito Santo: pomba branca com asas abertas e halo
   - Santo Antônio: hábito franciscano MARROM, Menino Jesus nos braços, livro
   - Padre Pio: hábito capuchinho, barba, luvas (mittens) nas mãos
   - São Jorge: ARMADURA, cavalo branco, lança ou espada, dragão
   - Santa Rita: espinho na testa, rosas, hábito agostiniano escuro
   - Jesus Misericordioso: figura de Jesus com raios vermelho e branco do coração
   - São Miguel: armadura, asas, lança apontada para demônio embaixo
   - SE INCERTO: anote "Não identificado com certeza" e descreva os atributos visíveis
3. Material: resina=plástico duro pintado; madeira=textura fibrosa/veios; metal=superfície brilhante/refletiva; tecido=terços/escapulários/pulseiras
4. Tamanho: use APENAS referências visíveis na foto (mãos ≈ 18cm, palma ≈ 10cm, caixa de fósforo ≈ 5cm). Se não houver referência, coloque NULL.
5. Condição da foto: borrada, escura, ângulo obscuro, produto em embalagem, múltiplos produtos?

RETORNE SOMENTE JSON válido, sem texto fora do JSON, sem markdown, sem comentários:
{
  "descricao": "1-2 frases: tipo + santo + material + tamanho. Ex: Imagem de Nossa Senhora Aparecida em resina, aproximadamente 20 cm, acabamento dourado e azul.",
  "categoria": "IMAGEM_DEVOCIONAL|TERCO|ESCAPULARIO|QUADRO|CHAVEIRO|PULSEIRA|DEZENA|KIT_DEVOCIONAL|OUTRO",
  "santo": "nome completo exato, ou 'Não identificado' se incerto",
  "material": "resina|madeira|metal|tecido|acrílico|papel|misto|null",
  "altura_cm": número inteiro ou null,
  "cor": "cores dominantes e tipo de acabamento. Ex: branco com detalhes dourados, base azul",
  "preco_sugerido_brl": número inteiro ou null,
  "preco_referencia": "justificativa com a tabela usada. Ex: imagem resina 20cm, mercado ES 2025 ≈ R$55-85, sugerindo R$65",
  "titulo_shopify": "máx 60 chars: [Santo] – [Tipo] [Material/Tamanho]. Ex: Nossa Senhora Aparecida – Imagem Resina 20 cm",
  "descricao_shopify": "2-3 frases devocionais, tom respeitoso, sem emojis, sem exclamações, max 320 chars",
  "confianca": 0.0,
  "necessita_revisao": true,
  "alertas": []
}

TABELA DE PREÇOS referência (mercado ES/Brasil 2025):
Imagem resina: 10cm→R$25-40 | 15cm→R$40-60 | 20cm→R$55-85 | 25cm→R$80-120 | 30cm→R$100-150 | 40cm→R$150-230 | 50cm+→R$220-400
Imagem madeira: +35% sobre resina | Imagem metal: R$45-180 dependendo do tamanho
Terço plástico/acrílico: R$18-28 | Terço madeira/pedra semipreciosa: R$35-70 | Terço metal: R$45-90
Dezena (10 contas apenas): R$12-22 | Escapulário simples: R$15-28 | Escapulário bordado/metal: R$28-60
Quadro pequeno (<A4): R$35-60 | Médio (A4): R$55-100 | Grande: R$90-200
Chaveiro: R$12-25 | Pulseira devocional: R$18-40 | Kit devocional: R$45-100

REGRAS DE CONFIANÇA (seja conservador):
- 0.85-1.0: certeza total — santo identificado com clareza, material óbvio, tamanho com referência
- 0.65-0.84: provável — santo identificado mas ângulo dificulta, tamanho estimado sem referência clara
- 0.40-0.64: incerto — santo duvidoso, foto parcial, múltiplas possibilidades
- 0.00-0.39: muito incerto — foto ruim, produto não identificável, embalagem tampando

necessita_revisao=false SOMENTE SE: confianca >= 0.80 E santo != 'Não identificado' E categoria definida E preco_sugerido_brl definido.

alertas: liste QUALQUER ponto de incerteza — ex: "Santo pode ser São Francisco ou Santo Antônio — verificar se há animais ou Menino Jesus", "Tamanho estimado sem referência visual clara", "Foto com iluminação baixa, cor pode diferir do real", "Possível kit com mais de um produto".`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      temperature: 0,
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
  const raw = (data.content?.[0]?.text || '{}').trim().replace(/^```json\s*|\s*```$/g, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    return { descricao: raw.slice(0, 300), confianca: 0.2, necessita_revisao: true, alertas: ['JSON da IA malformado — revisar manualmente'] };
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
