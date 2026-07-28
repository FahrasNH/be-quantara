"use strict";

/**
 * Shared Postgres / pgvector helpers for ML RAG scripts (seed, deploy verify, diag).
 */

function dbHostHint() {
  const dbUrl = process.env.DATABASE_URL || "";
  if (!dbUrl) return "(DATABASE_URL unset)";
  try {
    const u = new URL(dbUrl.replace(/^postgres(ql)?:\/\//, "http://"));
    const user = u.username ? `${u.username}@` : "";
    const db = u.pathname?.replace(/^\//, "") || "postgres";
    return `${user}${u.hostname}:${u.port || 5432}/${db}`;
  } catch {
    return "(invalid DATABASE_URL)";
  }
}

function isLocalDbUrl() {
  const dbUrl = process.env.DATABASE_URL || "";
  return /localhost|127\.0\.0\.1|::1/i.test(dbUrl);
}

function formatDbConnectionError(err) {
  const msg = err?.message || String(err);
  const causeMsg = err?.errors?.map((e) => e?.message).filter(Boolean).join("; ") || "";
  const full = [msg, causeMsg].filter(Boolean).join(" — ");
  const lines = [`Cannot connect to Postgres at ${dbHostHint()}: ${full}`];
  const connHint = /ECONNREFUSED|connect ETIMEDOUT|ENOTFOUND|getaddrinfo|AggregateError/i.test(full);
  if (connHint || isLocalDbUrl()) {
    if (isLocalDbUrl()) {
      lines.push("DATABASE_URL points to localhost — local Postgres is not expected for RAG ops.");
    }
    lines.push("Run on VPS (recommended):");
    lines.push("  cd /opt/quantara-dev/be && npm run ml:diag");
    lines.push("  cd /opt/quantara-staging/be && npm run ml:embeddings");
    lines.push("Or one-command from laptop: npm run ml:deploy:dev / ml:deploy:staging");
    lines.push("Or SSH tunnel: ssh -L 5433:127.0.0.1:5432 root@srv1722932");
  }
  if (/relation.*does not exist/i.test(full)) {
    lines.push("TradeEmbedding table may be missing — run: npx prisma migrate deploy");
  }
  return lines.join("\n");
}

/**
 * Fail fast before seed / deploy — requires pgvector + TradeEmbedding table.
 * @param {import('pg').Pool} pool
 */
async function preflightRagDatabase(pool) {
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    console.error(formatDbConnectionError(err));
    process.exit(1);
  }

  let extRows;
  try {
    ({ rows: extRows } = await pool.query(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1"
    ));
  } catch (err) {
    console.error(`pgvector check failed: ${err?.message || err}`);
    process.exit(1);
  }

  if (!extRows?.length) {
    console.error("pgvector extension missing on this database.");
    console.error("On VPS: npx prisma migrate deploy");
    console.error("Verify:  SELECT * FROM pg_extension WHERE extname='vector';");
    process.exit(1);
  }

  const { rows: tblRows } = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'TradeEmbedding' LIMIT 1"
  );
  if (!tblRows?.length) {
    console.error("TradeEmbedding table missing — run: npx prisma migrate deploy");
    process.exit(1);
  }

  return { pgvectorVersion: extRows[0].extversion, host: dbHostHint() };
}

/**
 * @param {import('pg').Pool} pool
 * @param {string[]} [componentKeys]
 */
async function queryEmbeddingCounts(pool, componentKeys = []) {
  const all = await pool.query('SELECT COUNT(*)::int AS n FROM "TradeEmbedding"');
  const by = await pool.query(
    `SELECT metadata->>'strategyKey' AS k, COUNT(*)::int AS n
     FROM "TradeEmbedding" GROUP BY 1 ORDER BY n DESC`
  );
  const componentCounts = {};
  for (const k of componentKeys) {
    const row = await pool.query(
      `SELECT COUNT(*)::int AS n FROM "TradeEmbedding" WHERE metadata->>'strategyKey' = $1`,
      [k]
    );
    componentCounts[k] = row.rows?.[0]?.n ?? 0;
  }
  return {
    embeddingCount: all.rows?.[0]?.n ?? 0,
    byStrategy: by.rows || [],
    componentCounts,
  };
}

module.exports = {
  dbHostHint,
  isLocalDbUrl,
  formatDbConnectionError,
  preflightRagDatabase,
  queryEmbeddingCounts,
};
