#!/usr/bin/env node
/**
 * Sprint 14: stop any RUNNING bots on BREAKOUT_RETEST / BREAKOUT_RETEST / BR.
 *
 * Usage (from be-bot-trading):
 *   node scripts/halt-bs-br-bots.js [--dry-run]
 *
 * Requires DATABASE_URL. Does not force-push or touch secrets.
 */
"use strict";

const prisma = require("../src/infrastructure/db/prismaClient");

const HALTED = ["BREAKOUT_RETEST", "BREAKOUT_RETEST", "BREAKOUT_TRADING", "BR", "BREAKOUT_STORM"];

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const bots = await prisma.bot.findMany({
    where: {
      running: true,
      OR: [
        { strategyKey: { in: HALTED } },
        // strategyGroup may contain BREAKOUT_RETEST among multi-strategy bots
        ...HALTED.map((k) => ({ strategyGroup: { has: k } })),
      ],
    },
    select: {
      id: true,
      userId: true,
      symbol: true,
      strategyKey: true,
      strategyGroup: true,
      dryRun: true,
      running: true,
    },
  });

  console.log(`Found ${bots.length} running bot(s) matching halted BREAKOUT_RETEST keys.`);
  for (const b of bots) {
    console.log(
      ` - ${b.id} user=${b.userId} ${b.symbol} strategy=${b.strategyKey}` +
        ` group=${JSON.stringify(b.strategyGroup)} dryRun=${b.dryRun}`
    );
  }

  if (dryRun || bots.length === 0) {
    console.log(dryRun ? "Dry-run only — no DB updates." : "Nothing to update.");
    return;
  }

  const ids = bots.map((b) => b.id);
  const result = await prisma.bot.updateMany({
    where: { id: { in: ids } },
    data: { running: false },
  });
  console.log(`Stopped ${result.count} bot(s). Restart in-memory engines via Stop-All / redeploy if needed.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await prisma.$disconnect(); } catch { /* ignore */ }
  });
