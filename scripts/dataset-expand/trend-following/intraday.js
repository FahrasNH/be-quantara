#!/usr/bin/env node
/**
 * TREND_FOLLOWING · Intraday dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/trend-following/intraday.js --quick
 *   node trend-following/intraday.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "TREND_FOLLOWING", tradeType: "Intraday" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
