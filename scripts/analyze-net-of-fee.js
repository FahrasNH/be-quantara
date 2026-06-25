#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// analyze-net-of-fee.js — Sprint 6 (FEE-06) validation harness
//
// Laporan per-strategi: gross PnL, fee+funding, NET, win rate, expectancy, R:R.
// Dipakai untuk memvalidasi efek FEE-01..04 — promote ke live HANYA strategi
// yang net-of-fee positif di sampel cukup (≥100 trade).
//
// Usage:
//   node scripts/analyze-net-of-fee.js                # semua trade closed
//   node scripts/analyze-net-of-fee.js --days 14      # 14 hari terakhir
//   node scripts/analyze-net-of-fee.js --mode dry     # dry_run saja (default: semua)
//   node scripts/analyze-net-of-fee.js --mode live
// ─────────────────────────────────────────────────────────────────────────────

const db = require("../src/infrastructure/db/database");
const pool = db._pool;

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const days = arg("days") ? parseInt(arg("days"), 10) : null;
const mode = arg("mode"); // "dry" | "live" | null

function fmt(n, w = 9) { return (n >= 0 ? "+" : "") + n.toFixed(2).padStart(w); }
function pct(n) { return `${(n * 100).toFixed(1)}%`; }

async function main() {
  const where = ["t.close_time IS NOT NULL", "t.pnl IS NOT NULL"];
  const params = [];
  if (days) { params.push(days); where.push(`t.open_time >= now() - ($${params.length} || ' days')::interval`); }
  if (mode === "dry")  where.push("t.dry_run = 1");
  if (mode === "live") where.push("t.dry_run = 0");

  const { rows } = await pool.query(
    `WITH tr AS (
       SELECT
         COALESCE(strategy_name, 'Untracked') AS strategy,
         pnl,
         (pnl - COALESCE(fee,0) - COALESCE(funding,0)) AS net,
         COALESCE(fee,0) + COALESCE(funding,0)         AS cost
       FROM trades t
       WHERE ${where.join(" AND ")}
     )
     SELECT
       strategy,
       COUNT(*)::int                                                  AS trades,
       COUNT(*) FILTER (WHERE pnl > 0)::int                           AS wins,
       COALESCE(SUM(pnl), 0)::float                                   AS gross,
       COALESCE(SUM(cost), 0)::float                                  AS fee,
       COALESCE(SUM(net), 0)::float                                   AS net,
       COALESCE(AVG(pnl) FILTER (WHERE pnl > 0), 0)::float            AS avg_win,
       COALESCE(AVG(pnl) FILTER (WHERE pnl <= 0), 0)::float           AS avg_loss
     FROM tr
     GROUP BY strategy
     ORDER BY net DESC`,
    params
  );

  const scope = [days ? `${days}d` : "all-time", mode || "all-modes"].join(" · ");
  console.log(`\n💸 Net-of-Fee per Strategy  (${scope})\n`);
  console.log("Strategy            Trades  WR     Gross       Fee        NET        RR     Expectancy(net)");
  console.log("─".repeat(96));

  let tg = 0, tf = 0, tn = 0, tt = 0;
  for (const r of rows) {
    const wr = r.trades ? r.wins / r.trades : 0;
    const rr = r.avg_loss !== 0 ? Math.abs(r.avg_win / r.avg_loss) : 0;
    const expNet = r.trades ? r.net / r.trades : 0;
    const flag = r.net > 0 ? "✅" : "❌";
    console.log(
      `${flag} ${r.strategy.padEnd(17)} ${String(r.trades).padStart(4)}  ` +
      `${pct(wr).padStart(5)}  ${fmt(r.gross)}  ${(-r.fee).toFixed(2).padStart(9)}  ` +
      `${fmt(r.net)}  ${rr.toFixed(2).padStart(5)}  ${fmt(expNet, 7)}`
    );
    tg += r.gross; tf += r.fee; tn += r.net; tt += r.trades;
  }
  console.log("─".repeat(96));
  console.log(
    `   ${"TOTAL".padEnd(17)} ${String(tt).padStart(4)}  ` +
    `${"".padStart(5)}  ${fmt(tg)}  ${(-tf).toFixed(2).padStart(9)}  ${fmt(tn)}`
  );

  // Rekomendasi Go/No-Go (FEE-06 gate): net-of-fee positif & sampel ≥100.
  console.log(`\nGo/No-Go (gate: net > 0 & trades ≥ 100):`);
  for (const r of rows) {
    const ok = r.net > 0 && r.trades >= 100;
    const why = r.net <= 0 ? "net negatif" : r.trades < 100 ? `sampel ${r.trades} < 100` : "lolos";
    console.log(`  ${ok ? "✅ LIVE  " : "⛔ HOLD  "} ${r.strategy.padEnd(17)} (${why})`);
  }
  console.log("");
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error("Error:", e.message); pool.end(); process.exit(1); });
