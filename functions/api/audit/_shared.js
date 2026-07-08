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
  // Conversão SEM spread operator — loop byte a byte nunca estoura o call stack,
  // mesmo em imagens grandes (o spread ...array tem limite de argumentos)
  const uint8 = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i]);
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

// Baixa a imagem do Drive como base64 JPEG para enviar à IA.
// Estratégia robusta para HEIC e outros formatos:
// 1. Tenta o thumbnailLink SEM header de auth (o link já vem assinado)
// 2. Se falhar, usa o endpoint de thumbnail da API Drive com auth (converte p/ JPEG)
export async function fetchThumbnailAsBase64(env, thumbnailLink, driveFileId) {
  let buf = null;

  // Tentativa 1: thumbnailLink direto em alta resolução (já vem assinado, NÃO usar Bearer)
  if (thumbnailLink) {
    try {
      const url = thumbnailLink.replace(/=s\d+$/, '=s768');
      const res = await fetch(url);
      if (res.ok) buf = await res.arrayBuffer();
    } catch { /* tenta próxima */ }
  }

  // Tentativa 2: endpoint da Drive API com token (gera JPEG mesmo de HEIC)
  if (!buf && driveFileId) {
    const token = await getDriveAccessToken(env);
    const apiUrl = `https://www.googleapis.com/drive/v3/files/${driveFileId}?fields=thumbnailLink`;
    const metaRes = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (metaRes.ok) {
      const meta = await metaRes.json();
      if (meta.thumbnailLink) {
        const url = meta.thumbnailLink.replace(/=s\d+$/, '=s768');
        const res = await fetch(url);
        if (res.ok) buf = await res.arrayBuffer();
      }
    }
  }

  if (!buf) throw new Error('Não foi possível obter thumbnail (arquivo HEIC pode não ter preview gerado no Drive ainda)');

  const b64 = base64url(buf).replace(/-/g, '+').replace(/_/g, '/');
  return b64 + '='.repeat((4 - b64.length % 4) % 4);
}

// ---- Anthropic Claude Vision ----

export async function analyzePhotoWithAnthropic(env, { imageBase64 }) {
  if (!env.ANTHROPIC_API_KEY) return null;

  const prompt = `Você é o maior especialista em iconografia católica e artigos religiosos do Brasil. Trabalha catalogando produtos para a loja "Universo da Fé" (Guarapari/ES). Sua análise precisa ser CIRÚRGICA e HONESTA.

════════ METODOLOGIA DE ANÁLISE (siga na ordem) ════════

ETAPA 1 — EXAME VISUAL SISTEMÁTICO
Antes de concluir qualquer coisa, examine mentalmente a imagem em regiões, como se estivesse dando zoom:
a) ZOOM no objeto inteiro: qual o formato geral? (estátua vertical, contas em fio, tecido retangular, moldura plana)
b) ZOOM no rosto/figura central: expressão, postura, o que segura nas mãos, o que veste
c) ZOOM nos detalhes pequenos: gravações em medalhas, texto em etiquetas, cor exata das contas, tipo de crucifixo
d) ZOOM no entorno: há embalagem? etiqueta com nome/preço? outros produtos juntos? referência de tamanho (mão, prateleira)?

ETAPA 2 — CLASSIFICAÇÃO DO TIPO
Conte os elementos para não confundir:
• TERÇO = 59 contas no total (5 dezenas de 10 + 6 contas maiores "Pai-Nosso" + crucifixo + medalha central). É um círculo fechado que pende do crucifixo.
• DEZENA = apenas 10 contas + crucifixo + 1 medalha. Muito menor, cabe na palma.
• ESCAPULARIO = DOIS retângulos (de tecido, feltro, plastificado ou metal) unidos por DOIS cordões/correntes. Cada retângulo tem uma imagem. NÃO tem contas.
• IMAGEM_DEVOCIONAL = estátua tridimensional de um santo.
• QUADRO = imagem 2D plana em moldura, tela, madeira ou papel.
• MEDALHA avulsa, CHAVEIRO, PULSEIRA, KIT.

ATENÇÃO ESCAPULÁRIO METÁLICO: se vê duas plaquetas de metal retangulares/ovais ligadas por corrente, com imagens gravadas — é ESCAPULARIO, categoria ESCAPULARIO. As gravações costumam ser: Sagrado Coração de Jesus (um lado) + Nossa Senhora do Carmo (outro lado) = "Escapulário do Carmo". Ou Nossa Senhora Aparecida. Examine a gravação COM ATENÇÃO antes de dizer "não identificado".

ETAPA 3 — IDENTIFICAÇÃO DO SANTO POR ICONOGRAFIA
Use esta base. Procure os ATRIBUTOS antes de nomear:

IMAGENS/ESTÁTUAS:
• São Bento → hábito PRETO, segura cruz/báculo, livro "CSPB" (Cruz de São Bento), às vezes cálice com serpente e corvo. Medalha de São Bento tem a cruz com letras CSPB/CSSML/NDSMD.
• São Francisco de Assis → hábito MARROM com corda de 3 nós, pássaros/lobo, estigmas nas mãos, tonsura
• Santo Antônio → hábito MARROM, segura MENINO JESUS + livro + lírio branco. (Menino Jesus = Santo Antônio, não São Francisco)
• São José → túnica, MENINO JESUS + lírio ou ferramentas de carpinteiro, barba
• Nossa Senhora Aparecida → PEQUENA, figura ESCURA/NEGRA, coroa e manto dourado/azul sobre vestido, mãos juntas. Frequentemente sobre nuvem com anjos.
• Nossa Senhora de Fátima → manto BRANCO com fios dourados, coroa, mãos em prece, às vezes com pastorinhos
• Nossa Senhora das Graças / Milagrosa → manto branco/azul, braços ABERTOS para baixo com raios saindo das mãos, pisa serpente
• Imaculada Conceição → vestido branco, manto azul, pisa lua/serpente, mãos juntas, olhar para cima
• Nossa Senhora de Lourdes → branca com faixa AZUL na cintura, rosas amarelas nos pés, mãos em prece
• Nossa Senhora Desatadora dos Nós → segura fita comprida com nós, anjos
• Nossa Senhora do Carmo → manto marrom carmelita, segura escapulário e Menino Jesus
• Sagrado Coração de Jesus → coração VISÍVEL no peito com chamas/espinhos, mão apontando ou abençoando
• Imaculado Coração de Maria → coração no peito com rosas e espada
• Divino Espírito Santo → POMBA branca com raios (não é figura humana)
• São Jorge → SOLDADO em armadura sobre CAVALO, lança matando DRAGÃO
• Santa Rita → hábito preto agostiniano, ferida/espinho na TESTA, crucifixo e rosas
• Santa Teresinha → hábito carmelita marrom, segura CRUCIFIXO com ROSAS
• Padre Pio → hábito marrom, barba branca, LUVAS marrons (estigmas), óculos às vezes
• São Judas Tadeu → veste verde/marrom, medalhão com rosto de Cristo no peito, chama na cabeça, bastão
• São Miguel Arcanjo → guerreiro alado com espada/lança vencendo demônio
• Nossa Senhora Rainha / Medianeira → coroa, cetro, manto real
• Menino Jesus de Praga → criança coroada com veste real e globo

ESCAPULÁRIOS E MEDALHAS — leia a gravação:
• "Escapulário do Carmo" = Nossa Senhora do Carmo + Sagrado Coração
• Medalha de São Bento = cruz central com iniciais CSPB
• Cores de terço por devoção: preto→São Bento; azul→N.Sra; branco→Fátima; vermelho→Sagrado Coração; verde→N.Sra das Graças/São Judas; marrom/madeira→Carmo ou Francisco

Se após examinar os atributos você ainda não tem certeza: dê o NOME MAIS PROVÁVEL com confianca adequada (0.5-0.7) e liste a dúvida em alertas — NÃO desista com "não identificado" se há pistas. Só use "Não identificado" se realmente não há atributo legível.

ETAPA 4 — MATERIAL: resina (mais comum, plástico duro pintado), madeira, gesso, metal/zamac, aço inox (escapulários/correntes), tecido/feltro (escapulários), acrílico, papel (quadros)

ETAPA 5 — TAMANHO: só estime se houver referência visual (mão≈18cm, palma≈9cm, dedos, prateleira≈32cm, embalagem). Sem referência → altura_cm null.

ETAPA 6 — PREÇO (PRIORIDADE: LER A ETIQUETA)
⚠ MUITAS FOTOS TÊM O PREÇO ESCRITO NUMA ETIQUETA, ADESIVO OU PLACA. Procure com atenção:
- Etiqueta de preço colada no produto ou na embalagem
- Adesivo redondo/retangular com número
- Placa de papel ao lado do produto
- Texto escrito "R$ XX" ou "XX,00" em qualquer lugar da foto
Se ENCONTRAR o preço escrito: use EXATAMENTE esse valor em preco_sugerido_brl, marque preco_fonte="ETIQUETA" e em preco_referencia escreva "Preço lido da etiqueta na foto: R$ XX". Este é o preço REAL da loja, sempre prefira ele sobre estimativa.
Se NÃO houver preço visível na foto: estime pela tabela abaixo e marque preco_fonte="ESTIMATIVA".

Tabela de estimativa (mercado ES 2025), usar SÓ quando não há etiqueta:
Imagem resina: 10cm R$25-40 | 15cm R$40-60 | 20cm R$55-85 | 25cm R$80-120 | 30cm R$100-150 | 40cm R$150-230 | 50cm+ R$230-400
Imagem madeira: +40% | metal: R$45-200
Terço plástico R$18-30 | madeira R$35-60 | pedra R$50-100 | metal R$45-90
Dezena R$12-25 | Escapulário tecido R$15-28 | Escapulário metal/aço R$30-70
Quadro peq R$35-65 | médio R$55-100 | grande R$90-200 | Chaveiro R$12-25 | Pulseira R$18-45

════════ RETORNE SOMENTE ESTE JSON (sem texto fora, sem markdown) ════════
{
  "descricao": "frase completa e precisa: tipo + santo + material + tamanho + detalhe distintivo",
  "categoria": "IMAGEM_DEVOCIONAL|TERCO|DEZENA|ESCAPULARIO|QUADRO|CHAVEIRO|PULSEIRA|KIT_DEVOCIONAL|OUTRO",
  "santo": "nome mais provável baseado na iconografia — só 'Não identificado' se não houver NENHUM atributo legível",
  "material": "resina|madeira|metal|aço inox|tecido|acrílico|papel|gesso|zamac|misto|null",
  "altura_cm": número ou null,
  "cor": "cores e acabamento específicos",
  "preco_sugerido_brl": número ou null,
  "preco_fonte": "ETIQUETA|ESTIMATIVA",
  "preco_referencia": "se ETIQUETA: 'Preço lido da etiqueta: R$ XX'. Se ESTIMATIVA: tabela usada + justificativa",
  "titulo_shopify": "máx 60 chars: [Santo] – [Tipo] [Detalhe|Tamanho|Material]",
  "descricao_shopify": "2-3 frases devocionais respeitosas, sem emojis, max 300 chars",
  "qualidade_foto": "BOA|REGULAR|RUIM",
  "produto_embalado": true/false,
  "multiplos_produtos": true/false,
  "confianca": 0.0,
  "necessita_revisao": true/false,
  "atributos_observados": ["liste os atributos visuais concretos que você viu e usou para identificar, ex: habito preto, cruz CSPB, medalha redonda"],
  "alertas": []
}

REGRAS:
• Examine os atributos ANTES de nomear o santo. Cite o que viu em "atributos_observados".
• confianca: 0.85+ certeza total | 0.65-0.84 provável | 0.4-0.64 incerto mas com pista | <0.4 sem pista
• necessita_revisao=false SOMENTE se confianca>=0.80 E santo identificado E categoria certa
• alertas: liste dúvidas específicas e acionáveis (ex: "verificar gravação da medalha com lupa", "confirmar se é Carmo ou Aparecida")
• Prefira arriscar o nome mais provável com confianca média a desistir com "não identificado"
• NUNCA invente atributo que não vê`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1536,
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
