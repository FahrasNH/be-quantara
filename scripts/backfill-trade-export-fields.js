/**
 * ─────────────────────────────────────────────────────────────────────────────
 * backfill-trade-export-fields.js — Isi field export yang hilang pada trade lama.
 *
 * Memperbaiki data historis untuk bug yang ditemukan saat DryRun multi-strategy:
 *
 *   BUG-001  strategy_name NULL → "(belum tercatat)". Diisi dari blob `indicators`
 *            (key `strategy` atau `firedByStrategy`) bila tersedia.
 *   BUG-002  pnl_pct salah denominator. Dihitung ulang = (pnlNet / notional) * 100,
 *            notional = entry_price * size, pnlNet = pnl - fee - funding.
 *   BUG-003  zero-fill ghost trade (exit == entry & pnl == 0) ditandai
 *            status = 'cancelled' agar dikecualikan dari win-rate.
 *   status   trade tertutup lain ditandai 'closed'; yang masih open → 'open'.
 *
 * AMAN: default PREVIEW (hitung saja). Tambahkan --apply untuk menulis perubahan.
 *
 *   node scripts/backfill-trade-export-fields.js            # preview
 *   node scripts/backfill-trade-export-fields.js --apply    # tulis perubahan
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

require("dotenv").config();

const { Pool } = require("pg");

function safeParseJSON(v) {
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

async function ensureColumns(pool) {
  // Idempotent — selaras dengan SCHEMA_SQL di database.js.
  const stmts = [
    `DO $$ BEGIN ALTER TABLE trades ADD COLUMN strategy_name TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`,
    `DO $$ BEGIN ALTER TABLE trades ADD COLUMN status TEXT DEFAULT 'open'; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`,
    `DO $$ BEGIN ALTER TABLE trades ADD COLUMN is_partial INTEGER DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`,
  ];
  for (const s of stmts) await pool.query(s);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const pool  = new Pool({ connectionString: process.env.DATABASE_URL });

  if (apply) await ensureColumns(pool);

  const { rows } = await pool.query(
    `SELECT id, entry_price, exit_price, size, pnl, pnl_pct, fee, funding,
            reason, close_time, indicators, strategy_name, status
     FROM trades
     ORDER BY id ASC`
  );

  let strategyFilled = 0;
  let pctFixed       = 0;
  let cancelledMarked = 0;
  let statusSet      = 0;

  for (const r of rows) {
    const updates = [];
    const params  = [];
    let i = 1;

    // BUG-001 — strategi
    if (!r.strategy_name) {
      const ind = safeParseJSON(r.indicators);
      const strat = ind?.strategy ?? ind?.firedByStrategy ?? null;
      if (strat) {
        updates.push(`strategy_name = $${i++}`); params.push(strat); strategyFilled++;
      }
    }

    const isClosed = r.close_time != null && r.pnl != null;

    // BUG-003 — zero-fill → cancelled; selain itu closed/open.
    let newStatus = r.status;
    if (isClosed) {
      const isZeroFill =
        r.exit_price != null &&
        Number(r.exit_price) === Number(r.entry_price) &&
        Number(r.pnl) === 0;
      newStatus = isZeroFill ? "cancelled" : "closed";
      if (isZeroFill) cancelledMarked++;
    } else {
      newStatus = "open";
    }
    if (newStatus !== r.status) {
      updates.push(`status = $${i++}`); params.push(newStatus); statusSet++;
    }

    // BUG-002 — pnl_pct dari net/notional (hanya trade tertutup).
    if (isClosed) {
      const notional = (r.entry_price || 0) * (r.size || 0);
      if (notional > 0) {
        const pnlNet = (r.pnl || 0) - (r.fee || 0) - (r.funding || 0);
        const correct = parseFloat(((pnlNet / notional) * 100).toFixed(4));
        if (r.pnl_pct == null || Math.abs((r.pnl_pct || 0) - correct) > 1e-6) {
          updates.push(`pnl_pct = $${i++}`); params.push(correct); pctFixed++;
        }
      }
    }

    if (updates.length && apply) {
      params.push(r.id);
      await pool.query(`UPDATE trades SET ${updates.join(", ")} WHERE id = $${i}`, params);
    }
  }

  console.log(`\nBackfill ${apply ? "(APPLIED)" : "(PREVIEW)"} atas ${rows.length} trade:`);
  console.log(`  strategy_name diisi : ${strategyFilled}`);
  console.log(`  pnl_pct diperbaiki  : ${pctFixed}`);
  console.log(`  ditandai cancelled  : ${cancelledMarked}`);
  console.log(`  status di-set       : ${statusSet}`);
  if (!apply) console.log(`\n  PREVIEW saja — tambahkan --apply untuk menulis perubahan.\n`);
  else console.log(`\n  Selesai.\n`);

  await pool.end();
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
