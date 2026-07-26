#!/usr/bin/env node
"use strict";

/**
 * cleanup-delisted-bots.js — Wind down bots & orphan trades outside the platform allowlist.
 *
 * What it does (per user, across the whole DB):
 *   1. Stop bots (DB running=false) whose symbol is outside the 5-coin allowlist.
 *   2. Force-close open trades (close_time IS NULL) on those symbols so they stop
 *      counting toward the per-tier account open-position cap.
 *
 * Default is REPORT-ONLY. Pass --apply to execute.
 *
 * Orphan closes use entry price (PnL 0) — the same fallback as the stop+forceClose
 * API path — because there is no engine/price context for delisted symbols.
 *
 * IMPORTANT: run this on the server that owns the DB (staging/dev), then reload PM2
 * so in-memory engines rebuild from the updated DB state:
 *   node scripts/cleanup-delisted-bots.js          # report only
 *   node scripts/cleanup-delisted-bots.js --apply  # stop bots + close orphans
 *   pm2 reload be-quantara-staging
 */

require("dotenv").config();

const prisma = require("../src/infrastructure/db/prismaClient");
const { _pool } = require("../src/infrastructure/db/database");
const { isAllowedSymbol, ALLOWED_SYMBOLS } = require("../src/shared/constants/allowedSymbols");
const { forceCloseOpenTrades } = require("../src/modules/trading/services/forceCloseOpenTrades");

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(`[cleanup-delisted] Allowlist: ${ALLOWED_SYMBOLS.join(", ")}`);
  console.log(`[cleanup-delisted] Mode: ${APPLY ? "APPLY" : "report-only (pass --apply to execute)"}\n`);

  // ── 1. Open trades grouped by (user, symbol) ─────────────────────────────
  const { rows: openGroups } = await _pool.query(
    `SELECT s.user_id, t.symbol, COUNT(*)::int AS open_count,
            MIN(t.open_time) AS oldest_open, BOOL_OR(t.dry_run = 0) AS has_live
     FROM trades t
     JOIN bot_sessions s ON s.id = t.session_id
     WHERE t.close_time IS NULL
     GROUP BY s.user_id, t.symbol
     ORDER BY t.symbol`
  );

  const delistedGroups = openGroups.filter((g) => !isAllowedSymbol(g.symbol));
  const allowedGroups  = openGroups.filter((g) => isAllowedSymbol(g.symbol));

  console.log(`[cleanup-delisted] Open positions total: ${openGroups.reduce((a, g) => a + g.open_count, 0)}`);
  for (const g of openGroups) {
    const tag = isAllowedSymbol(g.symbol) ? "keep " : "CLOSE";
    console.log(
      `  [${tag}] ${g.symbol.padEnd(12)} user=${g.user_id} open=${g.open_count} oldest=${g.oldest_open}${g.has_live ? " (LIVE!)" : ""}`
    );
  }
  if (allowedGroups.length) {
    console.log("  (posisi pada simbol allowlist TIDAK disentuh)");
  }

  // ── 2. Bots outside allowlist ─────────────────────────────────────────────
  const bots = await prisma.bot.findMany({
    select: { id: true, userId: true, symbol: true, running: true, dryRun: true },
  });
  const delistedBots = bots.filter((b) => !isAllowedSymbol(b.symbol));
  const runningDelisted = delistedBots.filter((b) => b.running);

  console.log(`\n[cleanup-delisted] Bots di luar allowlist: ${delistedBots.length} (running: ${runningDelisted.length})`);
  for (const b of delistedBots) {
    console.log(`  [${b.running ? "STOP" : "idle"}] ${b.symbol.padEnd(12)} user=${b.userId} ${b.dryRun ? "dry-run" : "LIVE"}`);
  }

  if (!APPLY) {
    console.log("\n[cleanup-delisted] Report-only selesai. Jalankan ulang dengan --apply untuk eksekusi.");
    return;
  }

  // ── 3. Apply: stop delisted bots ──────────────────────────────────────────
  let stopped = 0;
  for (const b of runningDelisted) {
    await prisma.bot.update({
      where: { id: b.id },
      data: { running: false, stoppedAt: new Date() },
    });
    stopped++;
    console.log(`\n[cleanup-delisted] Bot ${b.symbol} (user ${b.userId}) → running=false`);
  }

  // ── 4. Apply: force-close delisted orphan trades ──────────────────────────
  let totalClosed = 0;
  let totalFailed = 0;
  for (const g of delistedGroups) {
    const { closed, failed, reasons } = await forceCloseOpenTrades({
      userId: g.user_id,
      symbol: g.symbol,
      instance: null,
    });
    totalClosed += closed;
    totalFailed += failed;
    console.log(`[cleanup-delisted] ${g.symbol} user=${g.user_id}: closed=${closed} failed=${failed}${reasons.length ? ` (${reasons.join("; ")})` : ""}`);
  }

  console.log(`\n[cleanup-delisted] DONE. Bots stopped: ${stopped}, trades closed: ${totalClosed}, failed: ${totalFailed}`);
  console.log("[cleanup-delisted] Lanjutkan dengan: pm2 reload <app> agar engine in-memory ikut berhenti.");
}

main()
  .catch((err) => {
    console.error("[cleanup-delisted] Fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    await _pool.end().catch(() => {});
  });
