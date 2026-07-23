-- Sprint 21 / True-RAG: DocEmbedding table (separate from TradeEmbedding 60d)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "DocEmbedding" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "docId"        TEXT NOT NULL,
  "chunkIndex"   INT NOT NULL DEFAULT 0,
  "content"      TEXT NOT NULL,
  "searchVector" tsvector,
  "vector"       vector(384),
  "metadata"     JSONB,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("docId", "chunkIndex")
);

CREATE INDEX IF NOT EXISTS "DocEmbedding_vector_hnsw_idx"
  ON "DocEmbedding" USING hnsw ("vector" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS "DocEmbedding_searchVector_gin_idx"
  ON "DocEmbedding" USING gin ("searchVector");

CREATE INDEX IF NOT EXISTS "DocEmbedding_docId_idx" ON "DocEmbedding"("docId");
CREATE INDEX IF NOT EXISTS "DocEmbedding_createdAt_idx" ON "DocEmbedding"("createdAt");
