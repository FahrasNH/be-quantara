#!/usr/bin/env node
/**
 * Delete all rows from backtest_history (shared canonical archive).
 *
 * Usage:
 *   node scripts/clear-backtest-archive.js --confirm
 */
"use strict";

require("dotenv").config();

const db = require("../src/infrastructure/db/database");

async function main() {
  if (!process.argv.includes("--confirm")) {
    console.error("Refusing to delete without --confirm");
    console.error("Usage: node scripts/clear-backtest-archive.js --confirm");
    process.exit(1);
  }

  const deleted = await db.deleteAllBacktestHistory();
  console.log(`Deleted ${deleted} row(s) from backtest_history`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
