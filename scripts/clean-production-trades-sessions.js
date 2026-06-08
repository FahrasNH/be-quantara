#!/usr/bin/env node
/**
 * Hapus data trade + sesi bot di database PRODUCTION.
 * User, auth session, settings, candle cache, dan backtest history TIDAK disentuh.
 *
 * Safety:
 *   - Default dry-run (tidak hapus apa pun)
 *   - Guard: DATABASE_URL harus DB produksi (bot_trading), BUKAN staging
 *   - Eksekusi nyata butuh flag --apply
 *
 * Usage (di VPS production):
 *   cd /opt/be-quantara
 *   node scripts/clean-production-trades-sessions.js           # dry-run
 *   node scripts/clean-production-trades-sessions.js --apply   # hapus data
 */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { Pool } = require("pg");

const DRY_RUN = !process.argv.includes("--apply");
const STAGING_MARKER = "bot_trading_staging";
const TABLES = ["trades", "equity_snapshots", "logs", "bot_sessions"];

function assertProductionDb(url) {
  if (!url) {
    console.error("ERROR: DATABASE_URL belum diset.");
    process.exit(1);
  }
  if (url.includes(STAGING_MARKER)) {
    console.error("ERROR: Guard production gagal — ini database STAGING.");
    console.error(`       Ditemukan: ${url.replace(/:[^:@/]+@/, ":***@")}`);
    console.error("       Pakai scripts/clean-staging-trades-sessions.js untuk staging.");
    process.exit(1);
  }
  // DB name di path connection string (setelah host/port/)
  const dbName = url.split("/").pop()?.split("?")[0] || "";
  if (dbName !== "bot_trading") {
    console.error('ERROR: Guard production gagal — nama DB harus "bot_trading".');
    console.error(`       Ditemukan: ${dbName || "(kosong)"}`);
    process.exit(1);
  }
  // Blokir hanya DB dev lokal (port 5433 di .env.example). VPS production
  // umumnya localhost/127.0.0.1:5432 + user bottrading — itu valid.
  const portMatch = url.match(/:(\d+)\//);
  const port = portMatch?.[1] || "5432";
  if (port === "5433") {
    console.error("ERROR: Guard production gagal — port 5433 = DB dev lokal.");
    console.error(`       Ditemukan: ${url.replace(/:[^:@/]+@/, ":***@")}`);
    console.error("       Jalankan via ./scripts/clean-production-remote.sh (SSH ke VPS).");
    process.exit(1);
  }
}

async function countRows(pool, table) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  assertProductionDb(url);

  const pool = new Pool({ connectionString: url });
  const counts = {};
  for (const t of TABLES) counts[t] = await countRows(pool, t);

  console.log("==> PRODUCTION DB cleanup (trades + sesi bot)");
  console.log(`    DB: ${url.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(`    Mode: ${DRY_RUN ? "DRY-RUN (preview)" : "APPLY (menghapus data)"}`);
  console.log("    Sebelum:");
  for (const t of TABLES) console.log(`      ${t}: ${counts[t]}`);

  if (DRY_RUN) {
    console.log("\n(dry-run — tidak ada data dihapus)");
    console.log("Untuk eksekusi nyata: node scripts/clean-production-trades-sessions.js --apply");
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY`
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log("\n    Sesudah:");
  for (const t of TABLES) console.log(`      ${t}: ${await countRows(pool, t)}`);
  console.log("\n✓ Data trade & sesi PRODUCTION berhasil dibersihkan.");

  await pool.end();
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
