-- Sprint 5 / RL-1: pgvector extension + TradeEmbedding table
-- Apply manually: psql $DATABASE_URL -f this_file.sql

-- Enable pgvector extension (requires pgvector installed on Postgres server)
CREATE EXTENSION IF NOT EXISTS vector;

-- TradeEmbedding: stores 60-dim feature vectors for each trade (for RAG/similarity search)
CREATE TABLE IF NOT EXISTS "TradeEmbedding" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "tradeId"   TEXT NOT NULL UNIQUE,
  "vector"    vector(60),
  "metadata"  JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- HNSW index for approximate nearest neighbor (cosine similarity)
CREATE INDEX IF NOT EXISTS "TradeEmbedding_vector_hnsw_idx"
  ON "TradeEmbedding" USING hnsw ("vector" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS "TradeEmbedding_tradeId_idx"  ON "TradeEmbedding"("tradeId");
CREATE INDEX IF NOT EXISTS "TradeEmbedding_createdAt_idx" ON "TradeEmbedding"("createdAt");
