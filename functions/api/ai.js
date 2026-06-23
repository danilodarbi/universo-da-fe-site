/**
 * /api/ai — Proxy to OpenAI Chat Completions
 * Required env vars:
 *   OPENAI_API_KEY  = sk-...
 *   ADMIN_PASSWORD  = admin2901
 */

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const pwd = request.headers.get('X-Admin-Password');
  if (pwd !== env.ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid json' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const { mode, title, description, productType } = body;

  const SYSTEM_PROMPT = `Você é um copywriter especializado em artigos católicos para a loja "Universo da Fé".

REGRAS DE TOM:
- Devocional, respeitoso, acolhedor
- Sem exageros emocionais ou apelações comerciais
- Foco em fé, devoção, beleza, tradição
- Português brasileiro, formal mas próximo
- Evite: "incrível", "imperdível", "super", "demais", clichês de e-commerce
- Use: "delicado", "artesanal", "devocional", "consagrado", "sagrado"

PADRÃO DE TÍTULO:
- Formato: [Tipo] [Nome do Santo/Devoção] – [Material/Tamanho/Detalhe]
- Exemplos: "Terço de Madeira de Oliveira – Crucifixo Bronze", "Imagem de Santo Antônio – 15 cm | Resina"
- Sem emojis. Sem caps lock. Sem exclamações.

PADRÃO DE DESCRIÇÃO:
- 2 a 4 frases
- Primeira frase: o que é o produto + santo/devoção
- Segunda frase: material e detalhes de fabricação
- Terceira frase (opcional): contexto de uso (oratório, presente, devoção pessoal)
- Sem listas com bullets. Texto corrido.
- Máximo 350 caracteres.`;

  let userPrompt;
  if (mode === 'rewrite_title') {
    userPrompt = `Reescreva este título no padrão da loja:\n\nTítulo atual: "${title}"\nTipo do produto: ${productType || 'não informado'}\n\nRetorne APENAS o título novo, sem aspas, sem explicações.`;
  } else if (mode === 'rewrite_description') {
    userPrompt = `Reescreva esta descrição no tom devocional da loja:\n\nProduto: "${title}"\nDescrição atual: "${description || '(sem descrição)'}"\nTipo: ${productType || 'não informado'}\n\nRetorne APENAS a descrição nova, sem cabeçalhos, sem aspas, sem explicações.`;
  } else if (mode === 'rewrite_both') {
    userPrompt = `Reescreva título e descrição deste produto:\n\nTítulo atual: "${title}"\nDescrição atual: "${description || '(sem descrição)'}"\nTipo: ${productType || 'não informado'}\n\nRetorne em JSON exato:\n{"title": "...", "description": "..."}`;
  } else {
    return new Response(JSON.stringify({ error: 'invalid mode' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    const data = await aiRes.json();
    if (!aiRes.ok) {
      return new Response(JSON.stringify({ error: data.error?.message || 'OpenAI error' }), {
        status: aiRes.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const text = data.choices[0]?.message?.content?.trim() || '';

    let result;
    if (mode === 'rewrite_both') {
      try {
        const cleaned = text.replace(/^```json\s*|\s*```$/g, '').trim();
        result = JSON.parse(cleaned);
      } catch (e) {
        result = { error: 'failed to parse', raw: text };
      }
    } else {
      result = { text };
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
