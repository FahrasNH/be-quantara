#!/usr/bin/env node
/**
 * SMART_MONEY_CONCEPTS · Intraday dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/smart-money-concepts/intraday.js --quick
 *   node smart-money-concepts/intraday.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "SMART_MONEY_CONCEPTS", tradeType: "Intraday" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
