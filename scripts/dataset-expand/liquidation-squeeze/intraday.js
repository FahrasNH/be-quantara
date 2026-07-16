#!/usr/bin/env node
/**
 * LIQUIDATION_SQUEEZE · Intraday dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/liquidation-squeeze/intraday.js --quick
 *   node liquidation-squeeze/intraday.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "LIQUIDATION_SQUEEZE", tradeType: "Intraday" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
