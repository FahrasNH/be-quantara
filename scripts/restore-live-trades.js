#!/usr/bin/env node
/**
 * restore-live-trades.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Restore 7 live trade dari notifikasi Telegram ke production DB.
 *
 * Sumber: notifikasi bot Telegram 04-06 Jun 2026
 * Data:   7 trade LIVE (ETH + SOL SHORT)
 *
 * Safety:
 *   - Cek duplikat via (symbol + side + entry_price + open_time) sebelum insert
 *   - Dry-run default: tampilkan apa yang akan diinsert tanpa benar-benar tulis
 *   - Pass --apply untuk benar-benar insert ke DB
 *   - Backup otomatis setelah insert berhasil
 *
 * Usage:
 *   node scripts/restore-live-trades.js          # dry-run (aman)
 *   node scripts/restore-live-trades.js --apply  # insert ke DB
 * ─────────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config();
const { Pool } = require("pg");
const path     = require("path");

const DRY_RUN = !process.argv.includes("--apply");
const pool    = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Data dari notifikasi Telegram (sumber kebenaran) ─────────────────────────
// WIB = UTC+7  →  UTC = WIB - 7 jam
const LIVE_TRADES = [
  // ─── TRADE 1: ETH SHORT ─────────────────────────────────────────────
  {
    symbol:      "ETHUSDT",
    side:        "SHORT",
    entry_price: 1823.66,
    exit_price:  1805.80,
    sl:          1836.45,
    tp:          1785.29,
    size:        0.0110,
    pnl:         0.20,           // dari notif
    pnl_pct:     0.98,
    reason:      "Exchange (TP/SL)",
    open_time:   "2026-06-03T18:21:00Z",  // 04/06/26 01:21 WIB
    close_time:  "2026-06-03T20:48:00Z",  // 04/06/26 03:48 WIB
    leverage:    5,
    dry_run:     0,
    exchange:    "bitget",
  },
  // ─── TRADE 2: ETH SHORT ─────────────────────────────────────────────
  {
    symbol:      "ETHUSDT",
    side:        "SHORT",
    entry_price: 1782.50,
    exit_price:  1776.39,
    sl:          1811.82,
    tp:          1694.54,
    size:        0.0100,
    pnl:         0.06,
    pnl_pct:     0.34,
    reason:      "Exchange (TP/SL)",
    open_time:   "2026-06-04T07:29:00Z",  // 04/06/26 14:29 WIB
    close_time:  "2026-06-04T13:38:00Z",  // 04/06/26 20:38 WIB
    leverage:    5,
    dry_run:     0,
    exchange:    "bitget",
  },
  // ─── TRADE 3: SOL SHORT ─────────────────────────────────────────────
  {
    symbol:      "SOLUSDT",
    side:        "SHORT",
    entry_price: 69.97,
    exit_price:  69.33,
    sl:          71.28,
    tp:          66.03,
    size:        0.1120,
    pnl:         0.07,
    pnl_pct:     0.91,
    reason:      "Exchange (TP/SL)",
    open_time:   "2026-06-04T07:29:00Z",  // 04/06/26 14:29 WIB
    close_time:  "2026-06-04T12:37:00Z",  // 04/06/26 19:37 WIB
    leverage:    5,
    dry_run:     0,
    exchange:    "bitget",
  },
  // ─── TRADE 4: ETH SHORT ─────────────────────────────────────────────
  {
    symbol:      "ETHUSDT",
    side:        "SHORT",
    entry_price: 1757.24,
    exit_price:  1759.49,
    sl:          1782.67,
    tp:          1680.95,
    size:        0.0100,
    pnl:         -0.02,
    pnl_pct:     -0.13,
    reason:      "Exchange (TP/SL)",
    open_time:   "2026-06-04T17:47:00Z",  // 05/06/26 00:47 WIB
    close_time:  "2026-06-04T18:31:00Z",  // 05/06/26 01:31 WIB
    leverage:    5,
    dry_run:     0,
    exchange:    "bitget",
  },
  // ─── TRADE 5: SOL SHORT ─────────────────────────────────────────────
  {
    symbol:      "SOLUSDT",
    side:        "SHORT",
    entry_price: 64.17,
    exit_price:  64.90,
    sl:          65.15,
    tp:          61.70,
    size:        0.2310,
    pnl:         -0.17,
    pnl_pct:     -1.15,
    reason:      "Exchange (TP/SL)",
    open_time:   "2026-06-05T20:30:00Z",  // 06/06/26 03:30 WIB
    close_time:  "2026-06-05T21:38:00Z",  // 06/06/26 04:38 WIB
    leverage:    2,
    dry_run:     0,
    exchange:    "bitget",
  },
  // ─── TRADE 6: ETH SHORT ─────────────────────────────────────────────
  {
    symbol:      "ETHUSDT",
    side:        "SHORT",
    entry_price: 1591.86,
    exit_price:  1569.93,
    sl:          1606.92,
    tp:          1554.20,
    size:        0.0140,
    pnl:         0.31,
    pnl_pct:     1.38,
    reason:      "Exchange (TP/SL)",
    open_time:   "2026-06-06T01:33:00Z",  // 06/06/26 08:33 WIB
    close_time:  "2026-06-06T03:35:00Z",  // 06/06/26 10:35 WIB
    leverage:    2,
    dry_run:     0,
    exchange:    "bitget",
  },
  // ─── TRADE 7: SOL SHORT (bug report trade) ──────────────────────────
  {
    symbol:      "SOLUSDT",
    side:        "SHORT",
    entry_price: 61.47,
    exit_price:  61.78,
    sl:          62.09,
    tp:          59.93,
    size:        0.3710,
    pnl:         -0.11,
    pnl_pct:     -0.50,
    reason:      "Exchange (TP/SL)",
    open_time:   "2026-06-06T10:47:00Z",  // 06/06/26 17:47 WIB
    close_time:  "2026-06-06T11:03:00Z",  // 06/06/26 18:03 WIB
    leverage:    2,
    dry_run:     0,
    exchange:    "bitget",
  },
];

// ── Verify PnL dari notif dengan kalkulasi manual ────────────────────────────
function verifyPnl(t) {
  const calc = (t.side === "LONG")
    ? (t.exit_price - t.entry_price) * t.size
    : (t.entry_price - t.exit_price) * t.size;
  const diff = Math.abs(calc - t.pnl);
  return { calc: +calc.toFixed(4), diff: +diff.toFixed(4), ok: diff < 0.02 };
}

// ── Helper ───────────────────────────────────────────────────────────────────
function fmt(n, d = 4) { return Number(n).toFixed(d); }
function fmtDate(s) { return new Date(s).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }); }

async function main() {
  console.log(`\n${"═".repeat(68)}`);
  console.log(`  Restore Live Trades — Quantara`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN (tidak ada perubahan)" : "⚡ APPLY — menulis ke DB"}`);
  console.log(`${"═".repeat(68)}\n`);

  // ── 1. Verify kalkulasi PnL ────────────────────────────────────────────────
  console.log("📋 Verifikasi PnL dari notifikasi:");
  let allPnlOk = true;
  for (const t of LIVE_TRADES) {
    const v = verifyPnl(t);
    const flag = v.ok ? "✅" : "⚠️ ";
    console.log(`  ${flag} ${t.symbol} ${t.side} entry=$${t.entry_price} exit=$${t.exit_price} `
      + `size=${t.size} → PnL notif=$${t.pnl} kalkulasi=$${v.calc} diff=$${v.diff}`);
    if (!v.ok) allPnlOk = false;
  }
  if (!allPnlOk) console.log("  ⚠️  Ada selisih PnL > $0.02 — pastikan data notif benar.\n");
  else console.log("  ✅ Semua PnL verified\n");

  // ── 2. Cek duplikat di DB ──────────────────────────────────────────────────
  console.log("🔍 Cek duplikat di DB:");
  const toInsert = [];

  for (const t of LIVE_TRADES) {
    const { rows } = await pool.query(
      `SELECT id, pnl FROM trades
       WHERE symbol = $1 AND side = $2
         AND ABS(entry_price - $3) < 0.01
         AND open_time BETWEEN $4::timestamptz - interval '2 minutes'
                           AND $4::timestamptz + interval '2 minutes'`,
      [t.symbol, t.side, t.entry_price, t.open_time]
    );

    if (rows.length > 0) {
      console.log(`  ⏭  SKIP (sudah ada) id=${rows[0].id} ${t.symbol} ${t.side} entry=$${t.entry_price} open=${fmtDate(t.open_time)}`);
    } else {
      console.log(`  ➕ INSERT ${t.symbol} ${t.side} entry=$${t.entry_price} pnl=$${t.pnl} open=${fmtDate(t.open_time)}`);
      toInsert.push(t);
    }
  }

  console.log(`\n  Akan insert: ${toInsert.length} trade | Skip (duplikat): ${LIVE_TRADES.length - toInsert.length} trade\n`);

  if (toInsert.length === 0) {
    console.log("✅ Tidak ada trade baru yang perlu diinsert. DB sudah lengkap.\n");
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    console.log("ℹ️  DRY RUN — tidak ada yang diinsert.");
    console.log("   Jalankan dengan --apply untuk insert ke DB:\n");
    console.log("   node scripts/restore-live-trades.js --apply\n");
    await pool.end();
    return;
  }

  // ── 3. Cari / buat live sessions per symbol ────────────────────────────────
  console.log("📁 Cari atau buat live sessions:");
  const sessionMap = {}; // symbol → session_id

  const SYMBOLS = [...new Set(toInsert.map(t => t.symbol))];
  for (const sym of SYMBOLS) {
    // Cari session live yang sudah ada untuk symbol ini
    const { rows: existing } = await pool.query(
      `SELECT id, initial_capital, started_at FROM bot_sessions
       WHERE symbol = $1 AND mode = 'live'
       ORDER BY started_at ASC LIMIT 1`,
      [sym]
    );

    if (existing.length > 0) {
      sessionMap[sym] = existing[0].id;
      console.log(`  ✅ Pakai session live yang ada: #${existing[0].id} ${sym}`);
    } else {
      // Buat session live baru untuk restore
      // Initial capital diestimasi dari sesi dry_run yang ada
      const { rows: drySession } = await pool.query(
        `SELECT initial_capital FROM bot_sessions WHERE symbol = $1 LIMIT 1`, [sym]
      );
      const initCap = drySession.length > 0 ? drySession[0].initial_capital : 15.33;

      const tradesForSym = toInsert.filter(t => t.symbol === sym);
      const firstOpen    = tradesForSym.map(t => t.open_time).sort()[0];

      const { rows: newSess } = await pool.query(
        `INSERT INTO bot_sessions
           (exchange, symbol, mode, initial_capital, final_capital, started_at, config)
         VALUES ($1, $2, 'live', $3, $3, $4, $5) RETURNING id`,
        [
          "bitget",
          sym,
          initCap,
          new Date(firstOpen).toISOString(),
          JSON.stringify({ restored: true, source: "telegram_notifications", restoredAt: new Date().toISOString() }),
        ]
      );
      sessionMap[sym] = newSess[0].id;
      console.log(`  ➕ Buat session live baru: #${newSess[0].id} ${sym} (initial_capital=$${initCap})`);
    }
  }

  // ── 4. Insert trades ───────────────────────────────────────────────────────
  console.log("\n📝 Insert trades:");
  const insertedIds = [];

  for (const t of toInsert) {
    const sessId = sessionMap[t.symbol];
    const { rows } = await pool.query(
      `INSERT INTO trades
         (session_id, exchange, symbol, side, entry_price, exit_price, sl, tp,
          size, pnl, pnl_pct, reason, open_time, close_time, dry_run)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        sessId, t.exchange, t.symbol, t.side,
        t.entry_price, t.exit_price, t.sl, t.tp,
        t.size, t.pnl, t.pnl_pct, t.reason,
        new Date(t.open_time).toISOString(),
        new Date(t.close_time).toISOString(),
        t.dry_run,
      ]
    );
    insertedIds.push(rows[0].id);
    console.log(`  ✅ Inserted id=${rows[0].id} ${t.symbol} ${t.side} pnl=$${t.pnl}`);
  }

  // ── 5. Update session stats (wins/losses/final_capital) ───────────────────
  console.log("\n📊 Update session stats:");
  for (const sym of SYMBOLS) {
    const sid = sessionMap[sym];

    const { rows: stats } = await pool.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) AS losses,
         SUM(pnl) AS total_pnl
       FROM trades WHERE session_id = $1 AND close_time IS NOT NULL`, [sid]
    );

    const { rows: sess } = await pool.query(`SELECT initial_capital FROM bot_sessions WHERE id = $1`, [sid]);
    const initCap  = sess[0]?.initial_capital || 15.33;
    const totalPnl = parseFloat(stats[0].total_pnl || 0);
    const finalCap = initCap + totalPnl;

    await pool.query(
      `UPDATE bot_sessions SET wins=$2, losses=$3, total_trades=$4, final_capital=$5 WHERE id=$1`,
      [sid, stats[0].wins, stats[0].losses, stats[0].total, finalCap]
    );
    console.log(`  ✅ Session #${sid} ${sym}: ${stats[0].total} trades | W=${stats[0].wins} L=${stats[0].losses} | final_cap=$${fmt(finalCap, 2)}`);
  }

  // ── 6. Insert equity snapshots (untuk chart) ──────────────────────────────
  console.log("\n📈 Build equity snapshots untuk chart:");

  for (const sym of SYMBOLS) {
    const sid       = sessionMap[sym];
    const { rows: sess } = await pool.query(`SELECT initial_capital FROM bot_sessions WHERE id = $1`, [sid]);
    const initCap   = parseFloat(sess[0]?.initial_capital || 15.33);

    // Semua trade untuk sesi ini, diurutkan by open_time
    const { rows: trades } = await pool.query(
      `SELECT entry_price, exit_price, pnl, open_time, close_time
       FROM trades WHERE session_id = $1 AND close_time IS NOT NULL
       ORDER BY open_time ASC`, [sid]
    );

    // Snapshot 1: modal awal (sebelum trade pertama)
    await pool.query(
      `INSERT INTO equity_snapshots (session_id, timestamp, capital, price, open_positions)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT DO NOTHING`,
      [sid, new Date(trades[0]?.open_time || Date.now()).toISOString(), initCap, 0]
    );

    let cap = initCap;
    let snapshotCount = 1;
    for (const t of trades) {
      cap += parseFloat(t.pnl || 0);
      await pool.query(
        `INSERT INTO equity_snapshots (session_id, timestamp, capital, price, open_positions)
         VALUES ($1, $2, $3, $4, 0)`,
        [sid, new Date(t.close_time).toISOString(), cap, parseFloat(t.exit_price || 0)]
      );
      snapshotCount++;
    }
    console.log(`  ✅ ${sym} sesi #${sid}: ${snapshotCount} equity snapshots`);
    console.log(`     ${fmt(initCap, 2)} → $${fmt(cap, 2)} (${cap > initCap ? "+" : ""}$${fmt(cap - initCap, 4)})`);
  }

  // ── 7. Summary ────────────────────────────────────────────────────────────
  const totalPnl = LIVE_TRADES.reduce((s, t) => s + t.pnl, 0);
  console.log(`\n${"═".repeat(68)}`);
  console.log(`  ✅ Restore selesai`);
  console.log(`  Trade diinsert  : ${insertedIds.length}`);
  console.log(`  Trade di-skip   : ${LIVE_TRADES.length - toInsert.length} (duplikat)`);
  console.log(`  Total PnL live  : ${totalPnl > 0 ? "+" : ""}$${fmt(totalPnl, 4)}`);
  console.log(`  Trade IDs baru  : [${insertedIds.join(", ")}]`);
  console.log(`${"═".repeat(68)}\n`);

  // ── 8. Auto-backup ────────────────────────────────────────────────────────
  console.log("💾 Menjalankan backup...");
  try {
    const { execSync } = require("child_process");
    execSync(`bash ${path.join(__dirname, "backup-db.sh")}`, { stdio: "inherit" });
  } catch (e) {
    console.log("  ⚠️  backup-db.sh tidak tersedia — jalankan manual: bash scripts/backup-db.sh");
  }

  await pool.end();
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
