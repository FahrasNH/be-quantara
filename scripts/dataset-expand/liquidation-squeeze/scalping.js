#!/usr/bin/env node
/**
 * LIQUIDATION_SQUEEZE · Scalping dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/liquidation-squeeze/scalping.js --quick
 *   node liquidation-squeeze/scalping.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "LIQUIDATION_SQUEEZE", tradeType: "Scalping" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
