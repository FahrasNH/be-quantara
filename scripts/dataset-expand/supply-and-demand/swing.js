#!/usr/bin/env node
/**
 * SUPPLY_AND_DEMAND · Swing dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/supply-and-demand/swing.js --quick
 *   node supply-and-demand/swing.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "SUPPLY_AND_DEMAND", tradeType: "Swing" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
