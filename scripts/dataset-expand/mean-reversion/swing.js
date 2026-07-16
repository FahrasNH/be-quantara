#!/usr/bin/env node
/**
 * MEAN_REVERSION · Swing dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/mean-reversion/swing.js --quick
 *   node mean-reversion/swing.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "MEAN_REVERSION", tradeType: "Swing" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
