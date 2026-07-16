#!/usr/bin/env node
/**
 * ICT_STYLE_TRADING · Scalping dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/ict-style-trading/scalping.js --quick
 *   node ict-style-trading/scalping.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "ICT_STYLE_TRADING", tradeType: "Scalping" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
