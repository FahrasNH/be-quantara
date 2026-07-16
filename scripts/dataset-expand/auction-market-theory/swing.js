#!/usr/bin/env node
/**
 * AUCTION_MARKET_THEORY · Swing dataset expand — production TYPE_TF parity.
 *
 * Run from be-bot-trading/ OR from scripts/dataset-expand/:
 *   node scripts/dataset-expand/auction-market-theory/swing.js --quick
 *   node auction-market-theory/swing.js --quick
 */

"use strict";

process.stdout.write("[dataset-expand] starting...\n");
const { main } = require("../lib/runDatasetExpand");

main({ strategyKey: "AUCTION_MARKET_THEORY", tradeType: "Swing" }).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
