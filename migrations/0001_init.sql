-- Auditoria de fotos Universo da Fé — schema inicial
-- Aplicar com: wrangler d1 execute universo-da-fe-auditoria --remote --file=migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS audit_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drive_file_id TEXT NOT NULL UNIQUE,
  drive_folder_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  thumbnail_link TEXT,
  file_size INTEGER,
  created_time TEXT,
  -- ordem estável de processamento = ordem de criação no Drive
  sort_key TEXT,

  status TEXT NOT NULL DEFAULT 'PENDENTE',
  -- PENDENTE | ANALISANDO | ANALISADO | PRONTO_PARA_REVISAO | PRECISA_DE_AJUSTE
  -- PRECISA_DE_NOVA_FOTO | APROVADO | REPROVADO | ERRO | ENVIADO_SHOPIFY

  batch_id INTEGER REFERENCES batches(id),

  -- resultado bruto da OpenAI (JSON como veio, antes de qualquer edição humana)
  ai_result_json TEXT,
  ai_error TEXT,
  ai_cache_key TEXT,

  -- campos editáveis na revisão (começam como cópia do ai_result, humano pode sobrescrever)
  produto_identificado TEXT,
  categoria TEXT,
  santo_devocao TEXT,
  material TEXT,
  cor TEXT,
  altura_valor REAL,
  altura_fonte TEXT,
  altura_confianca REAL,
  peso_valor REAL,
  peso_fonte TEXT,
  peso_confianca REAL,
  preco_valor REAL,
  preco_fonte TEXT,
  titulo_recomendado TEXT,
  descricao_recomendada TEXT,

  shopify_product_id TEXT,
  status_correspondencia TEXT,
  confianca_correspondencia REAL,

  evidencias_json TEXT,       -- array JSON
  conflitos_json TEXT,        -- array JSON
  informacoes_ausentes_json TEXT, -- array JSON
  necessita_revisao INTEGER DEFAULT 1,

  reviewer_note TEXT,
  reviewed_at TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_status ON audit_records(status);
CREATE INDEX IF NOT EXISTS idx_audit_sort ON audit_records(sort_key);
CREATE INDEX IF NOT EXISTS idx_audit_batch ON audit_records(batch_id);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'EM_ANDAMENTO', -- EM_ANDAMENTO | CONCLUIDO | INTERROMPIDO
  total_items INTEGER NOT NULL,
  processed_items INTEGER NOT NULL DEFAULT 0,
  error_items INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- cache de respostas da OpenAI para não reprocessar o mesmo registro+foto
CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- espelho leve do catálogo Shopify, para matching rápido sem chamar a API a cada item
CREATE TABLE IF NOT EXISTS shopify_products_cache (
  product_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  status TEXT,
  product_type TEXT,
  image_url TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shopify_title_norm ON shopify_products_cache(title_normalized);
