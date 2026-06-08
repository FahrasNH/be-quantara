#!/usr/bin/env node
/**
 * Hapus data trade + sesi bot di database STAGING saja.
 * User, auth session, settings, candle cache, dan backtest history TIDAK disentuh.
 *
 * Usage (di VPS staging):
 *   cd /opt/quantara-staging/be-bot-trading
 *   node scripts/clean-staging-trades-sessions.js
 *
 * Dry-run:
 *   node scripts/clean-staging-trades-sessions.js --dry-run
 */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { Pool } = require("pg");

const DRY_RUN = process.argv.includes("--dry-run");
const STAGING_DB_MARKER = "bot_trading_staging";

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (!url) {
    console.error("ERROR: DATABASE_URL belum diset.");
    process.exit(1);
  }
  if (!url.includes(STAGING_DB_MARKER)) {
    console.error(
      `ERROR: Guard staging gagal — DATABASE_URL harus mengandung "${STAGING_DB_MARKER}".`
    );
    console.error(`       Ditemukan: ${url.replace(/:[^:@/]+@/, ":***@")}`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });

  const tables = ["trades", "equity_snapshots", "logs", "bot_sessions"];
  const counts = {};
  for (const t of tables) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
    counts[t] = rows[0].n;
  }

  console.log("==> Staging DB cleanup (trades + sesi bot)");
  console.log(`    DB: ${url.replace(/:[^:@/]+@/, ":***@")}`);
  console.log("    Sebelum:");
  for (const t of tables) console.log(`      ${t}: ${counts[t]}`);

  if (DRY_RUN) {
    console.log("\n(dry-run — tidak ada data dihapus)");
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "TRUNCATE TABLE trades, equity_snapshots, logs, bot_sessions RESTART IDENTITY"
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const after = {};
  for (const t of tables) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
    after[t] = rows[0].n;
  }

  console.log("\n    Sesudah:");
  for (const t of tables) console.log(`      ${t}: ${after[t]}`);
  console.log("\n✓ Data trade & sesi staging berhasil dibersihkan.");

  await pool.end();
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
