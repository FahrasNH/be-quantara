#!/usr/bin/env node
/**
 * MARKET_STRUCTURE · Swing dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/market-structure/swing.js --quick
 *   node market-structure/swing.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "MARKET_STRUCTURE", tradeType: "Swing" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
