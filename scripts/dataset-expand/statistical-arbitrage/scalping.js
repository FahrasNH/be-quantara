#!/usr/bin/env node
/**
 * STATISTICAL_ARBITRAGE · Scalping dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/statistical-arbitrage/scalping.js --quick
 *   node statistical-arbitrage/scalping.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "STATISTICAL_ARBITRAGE", tradeType: "Scalping" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
