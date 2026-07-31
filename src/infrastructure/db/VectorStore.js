"use strict";

/**
 * VectorStore.js — Sprint 5 / RL-1
 *
 * pgvector abstraction layer for trade embedding storage and similarity search.
 * Uses raw pg Pool/Client (NOT Prisma) because Prisma doesn't support vector ops.
 *
 * Depends on the pgvector extension and TradeEmbedding table created by:
 *   prisma/migrations/20260709060000_add_pgvector/migration.sql
 */

const { toSql, fromSql } = require("pgvector");

const VECTOR_DIM = 60;

class VectorStore {
  /**
   * @param {import('pg').Pool} pgPool — raw pg Pool from database.js._pool
   */
  constructor(pgPool) {
    if (!pgPool) throw new Error("VectorStore: pgPool is required");
    this._pool = pgPool;
    this._available = true; // becomes false if pgvector extension is missing
    this._checkedAvailability = false;
  }

  // ── Availability check ────────────────────────────────────────────────────

  async checkAvailability() {
    if (this._checkedAvailability) return this._available;
    this._checkedAvailability = true;
    try {
      const { rows } = await this._pool.query(
        "SELECT 1 FROM pg_extension WHERE extname = 'vector' LIMIT 1"
      );
      this._available = (rows?.length ?? 0) > 0;
      if (!this._available) {
        console.warn("[VectorStore] pgvector not available — similarity search disabled");
      }
    } catch {
      this._available = false;
      console.warn("[VectorStore] pgvector not available — similarity search disabled");
    }
    return this._available;
  }

  async _ensureAvailable() {
    await this.checkAvailability();
    if (!this._available) throw new Error("pgvector not available — similarity search disabled");
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _toVectorSql(vector60d) {
    const arr = Array.isArray(vector60d)
      ? vector60d
      : Array.from(vector60d); // Float32Array → Array
    if (arr.length !== VECTOR_DIM) {
      throw new Error(`VectorStore: expected ${VECTOR_DIM}-dim vector, got ${arr.length}`);
    }
    // Replace NaN/Infinity with 0 (safety net)
    const safe = arr.map((v) => (Number.isFinite(v) ? v : 0));
    return toSql(safe);
  }

  _buildFilterClause(filters = {}, paramOffset = 1) {
    const conditions = [];
    const params = [];
    let idx = paramOffset;

    if (filters.regime) {
      params.push(filters.regime);
      conditions.push(`metadata->>'regime' = $${idx++}`);
    }
    if (filters.strategyKey) {
      const keys = Array.isArray(filters.strategyKey)
        ? filters.strategyKey.filter(Boolean)
        : [filters.strategyKey];
      if (keys.length === 1) {
        params.push(keys[0]);
        conditions.push(`metadata->>'strategyKey' = $${idx++}`);
      } else if (keys.length > 1) {
        params.push(keys);
        conditions.push(`metadata->>'strategyKey' = ANY($${idx++}::text[])`);
      }
    }
    if (filters.symbol) {
      params.push(filters.symbol);
      conditions.push(`metadata->>'symbol' = $${idx++}`);
    }
    if (filters.outcome) {
      params.push(filters.outcome);
      conditions.push(`metadata->>'outcome' = $${idx++}`);
    }
    if (filters.beforeDate) {
      params.push(filters.beforeDate);
      conditions.push(`(metadata->>'timestamp')::timestamptz < $${idx++}::timestamptz`);
    }

    return { conditions, params };
  }

  // ── Core API ──────────────────────────────────────────────────────────────

  /**
   * Insert or update embedding for a trade.
   * @param {string} tradeId
   * @param {Float32Array|number[]} vector60d
   * @param {object} metadata — { regime, strategyKey, symbol, outcome, timestamp }
   */
  async upsertEmbedding(tradeId, vector60d, metadata = {}) {
    await this._ensureAvailable();

    const vectorSql = this._toVectorSql(vector60d);
    const id = `emb_${tradeId}_${Date.now()}`;

    await this._pool.query(
      `INSERT INTO "TradeEmbedding" ("id", "tradeId", "vector", "metadata", "createdAt")
       VALUES ($1, $2, $3::vector, $4::jsonb, NOW())
       ON CONFLICT ("tradeId") DO UPDATE
         SET "vector" = EXCLUDED."vector",
             "metadata" = EXCLUDED."metadata"`,
      [id, tradeId, vectorSql, JSON.stringify(metadata)]
    );
  }

  /**
   * Find k most similar trades by cosine similarity.
   * @param {Float32Array|number[]} vector60d — query vector
   * @param {number} k — number of results (default 20)
   * @param {object} filters — { regime?, strategyKey?, symbol?, outcome?, beforeDate? }
   * @returns {Array<{tradeId, similarity, metadata}>}
   */
  async findSimilar(vector60d, k = 20, filters = {}) {
    await this._ensureAvailable();

    const vectorSql = this._toVectorSql(vector60d);
    const { conditions, params } = this._buildFilterClause(filters, 2);

    const whereClause =
      conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

    const { rows } = await this._pool.query(
      `SELECT "tradeId",
              1 - ("vector" <=> $1::vector) AS similarity,
              "metadata"
       FROM "TradeEmbedding"
       WHERE "vector" IS NOT NULL ${whereClause}
       ORDER BY "vector" <=> $1::vector
       LIMIT ${Math.max(1, Math.floor(k))}`,
      [vectorSql, ...params]
    );

    return rows.map((r) => ({
      tradeId:    r.tradeId,
      similarity: parseFloat(r.similarity) || 0,
      metadata:   typeof r.metadata === "object" ? r.metadata : JSON.parse(r.metadata || "{}"),
    }));
  }

  /**
   * Batch insert embeddings (for backfill operations).
   * @param {Array<{tradeId, vector, metadata}>} embeddings
   */
  async batchUpsert(embeddings) {
    await this._ensureAvailable();
    if (!embeddings || embeddings.length === 0) return;

    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      for (const emb of embeddings) {
        const vectorSql = this._toVectorSql(emb.vector);
        const id = `emb_${emb.tradeId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        await client.query(
          `INSERT INTO "TradeEmbedding" ("id", "tradeId", "vector", "metadata", "createdAt")
           VALUES ($1, $2, $3::vector, $4::jsonb, NOW())
           ON CONFLICT ("tradeId") DO UPDATE
             SET "vector" = EXCLUDED."vector",
                 "metadata" = EXCLUDED."metadata"`,
          [id, emb.tradeId, vectorSql, JSON.stringify(emb.metadata || {})]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Count embeddings matching optional filters.
   * @param {object} filters
   * @returns {number}
   */
  async count(filters = {}) {
    await this._ensureAvailable();

    const { conditions, params } = this._buildFilterClause(filters, 1);
    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await this._pool.query(
      `SELECT COUNT(*)::int AS cnt FROM "TradeEmbedding" ${whereClause}`,
      params
    );
    return rows[0]?.cnt ?? 0;
  }
}

module.exports = VectorStore;
