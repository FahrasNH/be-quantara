#!/usr/bin/env node
/**
 * dedupe-backtest-archive.js
 * Dedupe legacy backtest_history rows by computed canonical_key.
 * Keeps the row with the newest data_end (fallback: latest updated_at / timestamp).
 *
 * Usage: node scripts/dedupe-backtest-archive.js [--dry-run]
 */
"use strict";

require("dotenv").config();

const db = require("../src/infrastructure/db/database");
const { buildCanonicalKey, ENGINE_VERSION } = require("../src/server/services/BacktestCanonicalService");

const DRY_RUN = process.argv.includes("--dry-run");

function rowCanonicalKey(row) {
  if (row.canonical_key) return row.canonical_key;
  const config = typeof row.config === "string" ? JSON.parse(row.config || "{}") : (row.config || {});
  const params = config.parameters || {};
  return buildCanonicalKey({
    symbol: row.symbol,
    strategyKey: row.strategy_key || config.strategyKey || "ADAPTIVE_FUSION",
    timeframe: row.timeframe || config.timeframe || "1d",
    parameters: params,
    enableFees: config.enableFees !== false,
    enableSlippage: !!config.enableSlippage,
    exchange: config.exchange || "sim",
    dataSource: config.dataSource || "sim",
    periodLabel: row.period_label || config.periodLabel || "500",
  });
}

function rowEndMs(row) {
  const raw = row.data_end || row.timestamp;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

async function main() {
  await db.init();
  const { rows } = await db._pool.query(`SELECT * FROM backtest_history ORDER BY id ASC`);

  const groups = new Map();
  for (const row of rows) {
    let key;
    try {
      key = rowCanonicalKey(row);
    } catch (err) {
      console.warn(`[skip] id=${row.id}: ${err.message}`);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  let deleted = 0;
  let updated = 0;

  for (const [key, list] of groups) {
    if (list.length <= 1) {
      const only = list[0];
      if (!only.canonical_key && !DRY_RUN) {
        await db._pool.query(
          `UPDATE backtest_history SET canonical_key = $2, engine_version = COALESCE(engine_version, $3) WHERE id = $1`,
          [only.id, key, ENGINE_VERSION],
        );
        updated++;
      }
      continue;
    }

    list.sort((a, b) => rowEndMs(b) - rowEndMs(a) || (b.id - a.id));
    const keeper = list[0];
    const dupes = list.slice(1);

    console.log(`[dedupe] key=${key.slice(0, 12)}… keep id=${keeper.id}, remove ${dupes.map(d => d.id).join(", ")}`);

    if (!DRY_RUN) {
      await db._pool.query(
        `UPDATE backtest_history SET
           canonical_key = $2,
           engine_version = COALESCE(engine_version, $3),
           hit_count = COALESCE(hit_count, 1) + $4
         WHERE id = $1`,
        [keeper.id, key, ENGINE_VERSION, dupes.length],
      );
      updated++;

      const dupeIds = dupes.map(d => d.id);
      const { rowCount } = await db._pool.query(
        `DELETE FROM backtest_history WHERE id = ANY($1::int[])`,
        [dupeIds],
      );
      deleted += rowCount;
    }
  }

  console.log(`\nDone. ${DRY_RUN ? "(dry-run) " : ""}Updated ${updated}, deleted ${deleted} duplicate rows.`);
  await db.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
