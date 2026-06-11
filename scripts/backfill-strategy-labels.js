#!/usr/bin/env node
/**
 * backfill-strategy-labels.js — Isi strategy_name pada trade yang "Untracked"
 *
 * Latar belakang (dry-run 2026-06-09):
 *   Sebelum commit 44bc878 (Jun 10 06:43), AdaptiveStrategyEngine tidak menyimpan
 *   `strategy` ke dalam blob indicators. Akibatnya 33 trade Jun 9 masuk tanpa label
 *   dan tampil sebagai "Untracked" di export.
 *
 * Strategi identifikasi (fingerprint dari data dry-run):
 *   R:R ≈ 1.92 + LONG + RSI 55-65  → TREND_MOMENTUM
 *   R:R ≈ 3.00 + LONG + RSI < 35   → MEAN_REVERSION
 *   R:R ≈ 2.00 + SHORT + RSI 30-55 → ADAPTIVE_FUSION
 *   Lainnya                         → biarkan Untracked (tidak di-force-label)
 *
 * Usage:
 *   node scripts/backfill-strategy-labels.js           # preview (aman, tidak menulis)
 *   node scripts/backfill-strategy-labels.js --apply   # tulis perubahan ke DB
 *
 * Wajib backup DB sebelum --apply:
 *   bash scripts/backup-db.sh
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { Pool } = require("pg");

const APPLY = process.argv.includes("--apply");

function safeParseJSON(v) {
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

/**
 * Hitung planned R:R dari entry, sl, tp.
 * Return null jika data tidak cukup.
 */
function calcPlannedRR(entry, sl, tp) {
  if (!entry || !sl || !tp) return null;
  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp - entry);
  if (slDist <= 0) return null;
  return tpDist / slDist;
}

/**
 * Tentukan strategy dari fingerprint R:R + side + RSI.
 * Return null jika tidak bisa ditentukan (jangan force-label).
 *
 * RSI boleh null untuk MEAN_REVERSION karena R:R 3.00 + LONG adalah
 * sidik jari unik yang tidak overlap dengan strategy lain.
 */
function inferStrategy(rr, side, rsi) {
  if (rr == null) return null;

  // MEAN_REVERSION: R:R ≈ 3.00, LONG — RSI tidak diperlukan karena R:R ini
  // unik hanya dimiliki MR. Ini menangani trade lama yang RSI-nya tidak tersimpan.
  if (rr >= 2.70 && rr <= 3.30 && side === "LONG") {
    if (rsi == null || rsi < 40) return "MEAN_REVERSION";
  }

  // TREND_MOMENTUM: R:R ≈ 1.92, LONG, RSI 55-68
  if (rr >= 1.80 && rr <= 2.05 && side === "LONG" && rsi != null && rsi >= 55 && rsi <= 68) {
    return "TREND_MOMENTUM";
  }

  // ADAPTIVE_FUSION: R:R ≈ 2.00, SHORT, RSI 28-55
  if (rr >= 1.80 && rr <= 2.20 && side === "SHORT" && rsi != null && rsi >= 28 && rsi <= 55) {
    return "ADAPTIVE_FUSION";
  }

  return null;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL tidak ditemukan di .env");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });

  console.log(`\n=== Quantara Backfill Strategy Labels ===`);
  console.log(`Mode: ${APPLY ? "APPLY (menulis ke DB)" : "PREVIEW (read-only)"}`);
  console.log(`DB: ${url.replace(/:[^:@/]+@/, ":***@")}\n`);

  // Query semua trade yang strategy_name-nya null atau 'Untracked'
  const { rows } = await pool.query(`
    SELECT id, symbol, side, entry_price, sl, tp, indicators, strategy_name, open_time
    FROM trades
    WHERE strategy_name IS NULL OR strategy_name = 'Untracked'
    ORDER BY open_time ASC
  `);

  console.log(`Trade Untracked/NULL ditemukan: ${rows.length}`);
  if (rows.length === 0) {
    console.log("Tidak ada yang perlu diperbaiki.");
    await pool.end();
    return;
  }

  const updates = [];
  const skipped = [];

  for (const row of rows) {
    const ind = safeParseJSON(row.indicators);

    // 1. Cek dulu dari indicators blob (lebih reliable)
    const fromBlob = ind?.strategy ?? ind?.firedByStrategy ?? null;
    if (fromBlob) {
      updates.push({ id: row.id, strategy: fromBlob, method: "blob", symbol: row.symbol, side: row.side, openTime: row.open_time });
      continue;
    }

    // 2. Inferensi dari R:R + side + RSI
    const rr = calcPlannedRR(row.entry_price, row.sl, row.tp);
    // Blob lama menyimpan RSI sebagai array penuh; blob baru (post-44bc878) sudah scalar.
    const rsiRaw = ind?.rsi ?? null;
    const rsi = Array.isArray(rsiRaw)
      ? (rsiRaw.length > 0 ? rsiRaw[rsiRaw.length - 1] : null)
      : (typeof rsiRaw === 'number' ? rsiRaw : null);
    const inferred = inferStrategy(rr, row.side, rsi);

    if (inferred) {
      updates.push({
        id: row.id,
        strategy: inferred,
        method: `inferred (rr=${rr?.toFixed(2)}, side=${row.side}, rsi=${rsi?.toFixed(1)})`,
        symbol: row.symbol,
        side: row.side,
        openTime: row.open_time,
      });
    } else {
      // 3. Proximity matching — cari strategi dari trade sibling dalam ±5 menit
      //    dengan symbol+side yang sama. Dipakai untuk partial-close atau duplicate
      //    entry dimana entry/sl/tp tidak tersimpan (rr=null rsi=null).
      const proximityResult = await pool.query(`
        SELECT strategy_name, COUNT(*) as cnt
        FROM trades
        WHERE symbol = $1
          AND side   = $2
          AND strategy_name IS NOT NULL
          AND strategy_name != 'Untracked'
          AND open_time BETWEEN $3::timestamptz - INTERVAL '5 minutes'
                             AND $3::timestamptz + INTERVAL '5 minutes'
          AND id != $4
        GROUP BY strategy_name
        ORDER BY cnt DESC
        LIMIT 1
      `, [row.symbol, row.side, row.open_time, row.id]);

      if (proximityResult.rows.length > 0) {
        const proximityStrategy = proximityResult.rows[0].strategy_name;
        updates.push({
          id: row.id,
          strategy: proximityStrategy,
          method: `proximity (±5min, symbol=${row.symbol}, side=${row.side})`,
          symbol: row.symbol,
          side: row.side,
          openTime: row.open_time,
        });
      } else {
        skipped.push({
          id: row.id,
          symbol: row.symbol,
          side: row.side,
          rr: rr?.toFixed(2) ?? "null",
          rsi: rsi?.toFixed(1) ?? "null",
          openTime: row.open_time,
        });
      }
    }
  }

  // Tampilkan hasil preview
  console.log(`\n--- Akan di-update: ${updates.length} trade ---`);
  const byStrategy = {};
  for (const u of updates) {
    byStrategy[u.strategy] = (byStrategy[u.strategy] || 0) + 1;
    console.log(`  [${u.strategy}] ${u.symbol} ${u.side} @ ${u.openTime} (via ${u.method})`);
  }
  console.log("\nRingkasan per strategy:");
  for (const [s, c] of Object.entries(byStrategy)) {
    console.log(`  ${s}: ${c} trade`);
  }

  if (skipped.length > 0) {
    console.log(`\n--- Tidak bisa di-label (ambigu): ${skipped.length} trade ---`);
    for (const s of skipped) {
      console.log(`  [SKIP] ${s.symbol} ${s.side} rr=${s.rr} rsi=${s.rsi} @ ${s.openTime}`);
    }
    console.log("  → Trade ini tetap Untracked. Perlu review manual.");
  }

  if (!APPLY) {
    console.log(`\n[PREVIEW ONLY] Tidak ada yang ditulis. Tambahkan --apply untuk eksekusi.`);
    await pool.end();
    return;
  }

  // Apply — UPDATE dalam transaksi
  console.log(`\n[APPLY] Menulis ${updates.length} update...`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let count = 0;
    for (const u of updates) {
      await client.query(
        `UPDATE trades SET strategy_name = $1 WHERE id = $2 AND (strategy_name IS NULL OR strategy_name = 'Untracked')`,
        [u.strategy, u.id]
      );
      count++;
    }
    await client.query("COMMIT");
    console.log(`✅ ${count} trade berhasil di-update.`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error saat UPDATE — ROLLBACK dijalankan:", err.message);
    process.exit(1);
  } finally {
    client.release();
  }

  // Verifikasi hasil
  const { rows: remaining } = await pool.query(`
    SELECT COUNT(*) as cnt FROM trades
    WHERE strategy_name IS NULL OR strategy_name = 'Untracked'
  `);
  console.log(`\nVerifikasi: trade Untracked tersisa = ${remaining[0].cnt}`);

  await pool.end();
  console.log("Selesai.");
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
