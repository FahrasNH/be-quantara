#!/usr/bin/env node
/**
 * ICT_STYLE_TRADING · Intraday dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/ict-style-trading/intraday.js --quick
 *   node ict-style-trading/intraday.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "ICT_STYLE_TRADING", tradeType: "Intraday" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
