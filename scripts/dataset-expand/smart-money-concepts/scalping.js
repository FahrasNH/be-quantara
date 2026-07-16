#!/usr/bin/env node
/**
 * SMART_MONEY_CONCEPTS · Scalping dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/smart-money-concepts/scalping.js --quick
 *   node smart-money-concepts/scalping.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "SMART_MONEY_CONCEPTS", tradeType: "Scalping" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
