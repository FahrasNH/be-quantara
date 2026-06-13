#!/usr/bin/env node
/**
 * Hapus HANYA tabel `logs` (log bot) di database yang ditunjuk DATABASE_URL.
 * Trades, sessions, equity, user, settings TIDAK disentuh.
 *
 * Aman untuk staging maupun production — karena cuma menyentuh tabel `logs`.
 *
 * Safety:
 *   - Default dry-run (tidak menghapus apa pun)
 *   - Eksekusi nyata butuh flag --apply
 *
 * Usage (di VPS, di folder be-bot-trading dgn .env yang benar):
 *   node scripts/clean-logs-only.js           # dry-run (preview jumlah)
 *   node scripts/clean-logs-only.js --apply    # hapus isi tabel logs
 */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { Pool } = require("pg");

const DRY_RUN = !process.argv.includes("--apply");
const TABLE = "logs";

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (!url) {
    console.error("ERROR: DATABASE_URL belum diset.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${TABLE}`);
  const before = rows[0].n;

  console.log("==> Cleanup LOGS-ONLY");
  console.log(`    DB:   ${url.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(`    Mode: ${DRY_RUN ? "DRY-RUN (preview)" : "APPLY (menghapus)"}`);
  console.log(`    logs sebelum: ${before}`);

  if (DRY_RUN) {
    console.log("\n(dry-run — tidak ada data dihapus)");
    console.log("Untuk eksekusi nyata: node scripts/clean-logs-only.js --apply");
    await pool.end();
    return;
  }

  await pool.query(`TRUNCATE TABLE ${TABLE} RESTART IDENTITY`);
  const { rows: after } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${TABLE}`);
  console.log(`    logs sesudah: ${after[0].n}`);
  console.log("\n✓ Tabel logs berhasil dikosongkan (trades & sessions tidak disentuh).");

  await pool.end();
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
