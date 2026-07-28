#!/usr/bin/env node
"use strict";

/**
 * Preflight Postgres + pgvector + TradeEmbedding before seed/deploy.
 *
 * Usage:
 *   npm run ml:verify-db
 *   node scripts/ml/verify-rag-db.js
 */

require("dotenv").config();

const { _pool } = require("../../src/infrastructure/db/database");
const { preflightRagDatabase } = require("./rag-db-helpers");

async function main() {
  const { pgvectorVersion, host } = await preflightRagDatabase(_pool);
  console.log(JSON.stringify({ ok: true, host, pgvectorVersion }, null, 2));
  await _pool.end();
}

main().catch(async (err) => {
  console.error(err?.message || err);
  try { await _pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
