#!/usr/bin/env node
/**
 * VOLUME_SPREAD_ANALYSIS · Scalping dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/volume-spread-analysis/scalping.js --quick
 *   node volume-spread-analysis/scalping.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "VOLUME_SPREAD_ANALYSIS", tradeType: "Scalping" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
