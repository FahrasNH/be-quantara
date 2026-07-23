"use strict";

/**
 * DocVectorStore.js — Sprint 21 / True-RAG
 * pgvector + full-text (BM25 via ts_rank) for document chunks.
 */

const { toSql } = require("pgvector");
const { DOC_VECTOR_DIM } = require("./LocalTextEmbedder");

class DocVectorStore {
  constructor(pgPool) {
    if (!pgPool) throw new Error("DocVectorStore: pgPool is required");
    this._pool = pgPool;
    this._available = true;
    this._checkedAvailability = false;
  }

  async checkAvailability() {
    if (this._checkedAvailability) return this._available;
    this._checkedAvailability = true;
    try {
      const { rows } = await this._pool.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_name = 'DocEmbedding' LIMIT 1`
      );
      this._available = (rows?.length ?? 0) > 0;
      if (!this._available) {
        console.warn("[DocVectorStore] DocEmbedding table missing — doc RAG disabled");
      }
    } catch {
      this._available = false;
    }
    return this._available;
  }

  async _ensureAvailable() {
    await this.checkAvailability();
    if (!this._available) throw new Error("DocEmbedding table not available");
  }

  _toVectorSql(vector) {
    const arr = Array.isArray(vector) ? vector : Array.from(vector);
    if (arr.length !== DOC_VECTOR_DIM) {
      throw new Error(`DocVectorStore: expected ${DOC_VECTOR_DIM}-dim vector, got ${arr.length}`);
    }
    const safe = arr.map((v) => (Number.isFinite(v) ? v : 0));
    return toSql(safe);
  }

  _buildFilterClause(filters = {}, paramOffset = 1) {
    const conditions = [];
    const params = [];
    let idx = paramOffset;

    for (const key of ["strategyKey", "regime", "symbol", "timeframe", "source", "docType"]) {
      if (filters[key]) {
        params.push(filters[key]);
        conditions.push(`metadata->>'${key}' = $${idx++}`);
      }
    }
    return { conditions, params };
  }

  async upsertChunk({ docId, chunkIndex, content, vector, metadata = {} }) {
    await this._ensureAvailable();
    const vectorSql = this._toVectorSql(vector);
    const id = `doc_${docId}_${chunkIndex}`;

    await this._pool.query(
      `INSERT INTO "DocEmbedding" ("id", "docId", "chunkIndex", "content", "searchVector", "vector", "metadata", "createdAt")
       VALUES ($1, $2, $3, $4, to_tsvector('english', $4), $5::vector, $6::jsonb, NOW())
       ON CONFLICT ("docId", "chunkIndex") DO UPDATE
         SET "content" = EXCLUDED."content",
             "searchVector" = EXCLUDED."searchVector",
             "vector" = EXCLUDED."vector",
             "metadata" = EXCLUDED."metadata"`,
      [id, docId, chunkIndex, content, vectorSql, JSON.stringify(metadata)]
    );
  }

  async findSimilarDense(vector, k = 20, filters = {}) {
    await this._ensureAvailable();
    const vectorSql = this._toVectorSql(vector);
    const { conditions, params } = this._buildFilterClause(filters, 2);
    const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

    const { rows } = await this._pool.query(
      `SELECT "docId", "chunkIndex", "content", "metadata",
              1 - ("vector" <=> $1::vector) AS score
       FROM "DocEmbedding"
       WHERE "vector" IS NOT NULL ${whereClause}
       ORDER BY "vector" <=> $1::vector
       LIMIT ${Math.max(1, Math.floor(k))}`,
      [vectorSql, ...params]
    );

    return rows.map((r) => ({
      docId: r.docId,
      chunkIndex: r.chunkIndex,
      content: r.content,
      metadata: typeof r.metadata === "object" ? r.metadata : JSON.parse(r.metadata || "{}"),
      score: parseFloat(r.score) || 0,
      source: "dense",
    }));
  }

  async findSimilarSparse(queryText, k = 20, filters = {}) {
    await this._ensureAvailable();
    const { conditions, params } = this._buildFilterClause(filters, 2);
    const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

    const { rows } = await this._pool.query(
      `SELECT "docId", "chunkIndex", "content", "metadata",
              ts_rank("searchVector", plainto_tsquery('english', $1)) AS score
       FROM "DocEmbedding"
       WHERE "searchVector" @@ plainto_tsquery('english', $1) ${whereClause}
       ORDER BY score DESC
       LIMIT ${Math.max(1, Math.floor(k))}`,
      [queryText, ...params]
    );

    return rows.map((r) => ({
      docId: r.docId,
      chunkIndex: r.chunkIndex,
      content: r.content,
      metadata: typeof r.metadata === "object" ? r.metadata : JSON.parse(r.metadata || "{}"),
      score: parseFloat(r.score) || 0,
      source: "sparse",
    }));
  }

  async count(filters = {}) {
    await this._ensureAvailable();
    const { conditions, params } = this._buildFilterClause(filters, 1);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this._pool.query(
      `SELECT COUNT(*)::int AS cnt FROM "DocEmbedding" ${whereClause}`,
      params
    );
    return rows[0]?.cnt ?? 0;
  }
}

module.exports = DocVectorStore;
