#!/usr/bin/env node
/**
 * BREAKOUT_RETEST · Swing dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/breakout-retest/swing.js --quick
 *   node breakout-retest/swing.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "BREAKOUT_RETEST", tradeType: "Swing" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
