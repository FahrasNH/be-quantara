#!/usr/bin/env node
/**
 * recalibrate-pair-tiers.js — quarterly pair-tier threshold review.
 *
 * Fetches the live top-250 CoinGecko universe, recomputes the hybrid-score
 * distribution, and prints suggested TIER_THRESHOLDS next to the current ones.
 * Read-only: it never edits code. Apply flagged changes via a reviewed commit
 * to TIER_THRESHOLDS in PairClassifier.js AFTER backtesting with the new values.
 *
 * Run: node scripts/recalibrate-pair-tiers.js [--json]
 * Cadence: quarterly, after a bull↔bear regime flip, or when the drift
 * monitor (PairTierDriftMonitor) alerts.
 */

'use strict';

const { pairClassifier } = require('../src/infrastructure/classification/PairClassifier');
const { computeRecalibrationReport } = require('../src/infrastructure/classification/tierRecalibration');

async function main() {
  const asJson = process.argv.includes('--json');

  console.error('[recalibrate] fetching CoinGecko top-250…');
  const ok = await pairClassifier.refreshDynamic();
  if (!ok) {
    console.error('[recalibrate] CoinGecko unreachable — cannot build a report from stale/empty data.');
    process.exit(1);
  }

  const report = computeRecalibrationReport();
  if (!report.ok) {
    console.error(`[recalibrate] ${report.reason}`);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const f = (n) => (n == null ? '   —  ' : n.toFixed(4));
  console.log('\n═══ Pair-Tier Recalibration Report ═══');
  console.log(`at: ${report.at}   universe: ${report.universe} coins`);
  console.log('\nScore distribution:');
  const d = report.scoreDistribution;
  console.log(`  p10 ${f(d.p10)}  p25 ${f(d.p25)}  p50 ${f(d.p50)}  p75 ${f(d.p75)}  p90 ${f(d.p90)}`);
  console.log('\nTier population (current thresholds):');
  for (const [tier, n] of Object.entries(report.tierCounts)) {
    console.log(`  ${tier.padEnd(14)} ${String(n).padStart(4)}  (${((n / report.universe) * 100).toFixed(1)}%)`);
  }
  console.log(`\nBlue-chip anchor: max score among top-10 ranks = ${f(report.anchors.top10MaxScore)} (${report.anchors.top10Count} coins)`);
  console.log('\nThresholds (current → suggested, drift):');
  for (const key of Object.keys(report.currentThresholds)) {
    const flag = report.flagged.includes(key) ? '  ⚠ REVIEW' : '';
    console.log(`  ${key.padEnd(14)} ${f(report.currentThresholds[key])} → ${f(report.suggestedThresholds[key])}   (${report.drift[key] >= 0 ? '+' : ''}${report.drift[key]})${flag}`);
  }
  console.log(`\n${report.recommendation}\n`);
}

main().catch((e) => {
  console.error('[recalibrate] failed:', e.message);
  process.exit(1);
});
