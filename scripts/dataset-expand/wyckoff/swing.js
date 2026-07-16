#!/usr/bin/env node
/**
 * WYCKOFF · Swing dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/wyckoff/swing.js --quick
 *   node wyckoff/swing.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "WYCKOFF", tradeType: "Swing" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
