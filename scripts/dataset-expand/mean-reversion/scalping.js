#!/usr/bin/env node
/**
 * MEAN_REVERSION · Scalping dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/mean-reversion/scalping.js --quick
 *   node mean-reversion/scalping.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "MEAN_REVERSION", tradeType: "Scalping" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
