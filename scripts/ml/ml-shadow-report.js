#!/usr/bin/env node
"use strict";

/**
 * ml-shadow-report.js — Sprint 5 / RL-4
 * Weekly ML shadow mode analysis report.
 * Usage: node scripts/ml/ml-shadow-report.js [--days 7]
 */

require("dotenv").config();

const prisma         = require("../../src/infrastructure/db/prismaClient");
const MLShadowService = require("../../src/server/services/MLShadowService");
const WinPredictor   = require("#modules/ml/domain/WinPredictor.js");
const FeatureEngineer = require("#modules/ml/domain/FeatureEngineer.js");

async function main() {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf("--days");
  const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) || 7 : 7;

  const weekEnd   = new Date();
  const weekStart = new Date(Date.now() - days * 86400000);

  const wp = new WinPredictor();
  await wp.load();

  const service = new MLShadowService(wp, null, new FeatureEngineer());
  const report  = await service.generateWeeklyReport(weekStart, weekEnd);

  const [shadowTotal, shadowOpen, engineClosed] = await Promise.all([
    prisma.mLShadowLog.count(),
    prisma.mLShadowLog.count({ where: { actualOutcome: null } }),
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS count
        FROM trades
       WHERE status = 'closed'
         AND close_time IS NOT NULL
         AND open_time > NOW() - (${String(days)} || ' days')::interval
    `.then((rows) => rows[0]?.count ?? 0).catch(() => null),
  ]);

  console.log(`\n[ML Shadow Report] Last ${days} days:`);
  console.log(`  Period:       ${weekStart.toISOString().slice(0, 10)} → ${weekEnd.toISOString().slice(0, 10)}`);
  console.log(`  Trade count:  ${report.tradeCount} (MLShadowLog with outcome)`);
  console.log(`  Diagnostics:  MLShadowLog total=${shadowTotal}, pending outcome=${shadowOpen}` +
    (engineClosed != null ? `, engine trades closed=${engineClosed}` : ""));
  if (report.tradeCount === 0 && engineClosed > 0) {
    console.log(
      "  Hint:         Engine trades exist but MLShadowLog is empty — run:\n" +
      "                node scripts/ml/backfill-ml-shadow-log.js --days=" + days
    );
  }
  console.log(`  AUC:          ${report.auc.toFixed(3)}`);
  console.log(`  Accuracy:     ${(report.accuracy * 100).toFixed(1)}%`);
  console.log(`  WR diff:      ${(report.wRateDiff * 100).toFixed(1)}% (ML vs baseline)`);
  console.log(`  Confusion:    TP=${report.confusionMatrix.tp} FP=${report.confusionMatrix.fp} TN=${report.confusionMatrix.tn} FN=${report.confusionMatrix.fn}`);

  const readiness = await service.checkPromotionReadiness();
  console.log(`\n[Promotion Readiness] ${readiness.ready ? "READY ✓" : "NOT READY"}: ${readiness.reason}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[ml-shadow-report] Fatal:", err);
  process.exit(1);
});
