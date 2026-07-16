#!/usr/bin/env node
/**
 * VOLUME_SPREAD_ANALYSIS · Swing dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/volume-spread-analysis/swing.js --quick
 *   node volume-spread-analysis/swing.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "VOLUME_SPREAD_ANALYSIS", tradeType: "Swing" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
