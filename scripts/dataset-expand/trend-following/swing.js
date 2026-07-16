#!/usr/bin/env node
/**
 * TREND_FOLLOWING · Swing dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/trend-following/swing.js --quick
 *   node trend-following/swing.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "TREND_FOLLOWING", tradeType: "Swing" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
