/**
 * performanceAggregationCron.js — Feature Store (Sprint 1 / FS-4)
 *
 * Runs StrategyPerformanceService.aggregateDaily() every day at 02:00 UTC.
 *
 * Usage:
 *   const cron = require('./performanceAggregationCron');
 *   cron.start();   // register the timer
 *   cron.stop();    // cancel the timer
 *
 * The cron uses a pure-Node.js timer approach (no external cron library) to
 * keep the dependency footprint minimal and consistent with the codebase style.
 */

"use strict";

const StrategyPerformanceService = require("../../server/services/StrategyPerformanceService");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Milliseconds until the next 02:00 UTC. */
function msUntilNext0200UTC() {
  const now    = new Date();
  const target = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    2, 0, 0, 0,
  ));
  // If it's already past 02:00 UTC today, advance to tomorrow
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - now.getTime();
}

// ── Cron state ───────────────────────────────────────────────────────────────

let _timeout = null;

async function runAggregation() {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  yesterday.setUTCHours(0, 0, 0, 0);

  try {
    console.log("[performanceAggregationCron] Starting daily aggregation for", yesterday.toISOString().slice(0, 10));
    const results = await StrategyPerformanceService.aggregateDaily(yesterday);
    console.log(`[performanceAggregationCron] Done — ${results.length} StrategyPerformance records upserted`);
  } catch (err) {
    console.error("[performanceAggregationCron] Aggregation failed:", err.message);
  }

  // Schedule the next run (24 hours from now)
  scheduleNext();
}

function scheduleNext() {
  const delay = msUntilNext0200UTC();
  const humanDelay = `${(delay / 3600000).toFixed(2)}h`;
  console.log(`[performanceAggregationCron] Next run in ${humanDelay} (02:00 UTC)`);
  _timeout = setTimeout(runAggregation, delay);
  // Allow the process to exit without waiting for this timer
  if (_timeout.unref) _timeout.unref();
}

// ── Public API ────────────────────────────────────────────────────────────────

function start() {
  if (_timeout) {
    console.warn("[performanceAggregationCron] Already running — call stop() first");
    return;
  }
  scheduleNext();
  console.log("[performanceAggregationCron] Started");
}

function stop() {
  if (_timeout) {
    clearTimeout(_timeout);
    _timeout = null;
    console.log("[performanceAggregationCron] Stopped");
  }
}

module.exports = { start, stop, runAggregation };
