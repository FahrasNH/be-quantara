/**
 * ─────────────────────────────────────────────────────────────────────────────
 * cleanup-stale-orphans.js — Tutup trade open basi (orphan) di mode DRY RUN.
 *
 * Konteks: selama periode debugging (crash-loop), beberapa posisi dry-run terbuka
 * di DB (close_time IS NULL) tapi tidak lagi dipegang engine live manapun. Ini
 * membuat "Posisi Terbuka" di UI lebih besar dari posisi yang benar-benar aktif.
 *
 * Script ini AMAN: hanya menyentuh trade DRY RUN (dry_run = true), dan default-nya
 * PREVIEW saja (tidak mengubah apa pun) kecuali dijalankan dengan --apply.
 *
 * Penggunaan:
 *   node scripts/cleanup-stale-orphans.js                 # preview semua open dry-run
 *   node scripts/cleanup-stale-orphans.js --before "2026-06-09T22:00:00Z"
 *   node scripts/cleanup-stale-orphans.js --before "..." --apply
 *
 * Trade ditutup di entry_price (PnL = 0, netral — TIDAK mengarang profit/loss),
 * dengan reason "Cleanup_Stale" agar terlacak di histori.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { Pool } = require("pg");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const apply  = process.argv.includes("--apply");
  const before = arg("--before"); // ISO timestamp; jika ada, hanya trade dibuka SEBELUM ini

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const params = [];
  let where = `t.close_time IS NULL AND s.mode = 'dry_run'`;
  if (before) {
    params.push(before);
    where += ` AND t.open_time < $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT t.id, t.symbol, t.side, t.entry_price, t.size, t.open_time, t.session_id,
            s.user_id
     FROM trades t
     JOIN bot_sessions s ON s.id = t.session_id
     WHERE ${where}
     ORDER BY t.open_time ASC`,
    params
  );

  console.log(`\n🔍 Ditemukan ${rows.length} trade DRY RUN terbuka${before ? ` (dibuka sebelum ${before})` : ""}:\n`);
  for (const r of rows) {
    console.log(
      `  #${r.id} ${r.symbol} ${r.side} @ $${r.entry_price} ` +
      `(size ${r.size}) — sesi #${r.session_id} — ${new Date(r.open_time).toISOString()}`
    );
  }

  if (rows.length === 0) {
    console.log("✅ Tidak ada yang perlu dibersihkan.\n");
    await pool.end();
    return;
  }

  if (!apply) {
    console.log(`\n⚠️  PREVIEW saja — tidak ada perubahan. Tambahkan --apply untuk menutup ${rows.length} trade.\n`);
    await pool.end();
    return;
  }

  let closed = 0;
  for (const r of rows) {
    try {
      await pool.query(
        `UPDATE trades
         SET close_time = now(), exit_price = entry_price, pnl = 0, pnl_pct = 0,
             reason = 'Cleanup_Stale'
         WHERE id = $1`,
        [r.id]
      );
      closed++;
    } catch (e) {
      console.warn(`  ✗ Gagal tutup #${r.id}: ${e.message}`);
    }
  }
  console.log(`\n✅ Selesai: ${closed}/${rows.length} trade ditutup (reason=Cleanup_Stale, PnL=0).\n`);
  await pool.end();
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
