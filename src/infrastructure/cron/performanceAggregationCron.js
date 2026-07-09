/**
 * performanceAggregationCron.js — Feature Store (Sprint 1 / FS-4, enhanced Sprint 2 / PA-1)
 *
 * Schedule:
 *   Daily     — aggregateDaily()          every day at 02:00 UTC
 *   Weekly    — aggregateRolling('7d')    Sunday 03:00 UTC
 *               aggregateRolling('30d')   Sunday 03:00 UTC
 *   Monthly   — aggregateRolling('all-time')  1st of month 04:00 UTC
 *
 * Job failures send a Telegram alert via TelegramNotifier.
 */

"use strict";

const StrategyPerformanceService = require("../../server/services/StrategyPerformanceService");
const telegram = require("../notifications/TelegramNotifier");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Milliseconds until the next occurrence of HH:MM UTC. */
function msUntilNextUTC(hour, minute) {
  const now    = new Date();
  const target = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    hour, minute, 0, 0,
  ));
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - now.getTime();
}

/** Milliseconds until next Sunday HH:MM UTC (0 = Sunday). */
function msUntilNextSundayUTC(hour, minute) {
  const now = new Date();
  let daysUntilSunday = (7 - now.getUTCDay()) % 7;
  if (daysUntilSunday === 0) {
    // Today is Sunday — check if the time has already passed
    const todayTarget = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute));
    if (todayTarget.getTime() <= now.getTime()) daysUntilSunday = 7;
  }
  const target = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilSunday,
    hour, minute, 0, 0,
  ));
  return target.getTime() - now.getTime();
}

/** Milliseconds until 1st of next month at HH:MM UTC. */
function msUntilFirstOfMonthUTC(hour, minute) {
  const now    = new Date();
  let   target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, hour, minute, 0, 0));
  // If already on the 1st but past the target time, go to next month
  if (target.getTime() <= now.getTime()) {
    target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1, hour, minute, 0, 0));
  }
  return target.getTime() - now.getTime();
}

/** Notify via Telegram (best-effort — never throws). */
async function alertFailure(label, error) {
  const msg = `⚠️ [PerformanceCron] <b>${label}</b> failed\n\n<code>${error.message}</code>`;
  try {
    await telegram.notifyError ? telegram.notifyError(msg) : telegram.send(msg);
  } catch (_e) { /* swallow */ }
}

// ── Cron state ────────────────────────────────────────────────────────────────

let _dailyTimeout   = null;
let _weeklyTimeout  = null;
let _monthlyTimeout = null;

// ── Daily (02:00 UTC) ─────────────────────────────────────────────────────────

async function runDaily() {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  yesterday.setUTCHours(0, 0, 0, 0);

  try {
    console.log("[performanceAggregationCron] Starting daily aggregation for", yesterday.toISOString().slice(0, 10));
    const results = await StrategyPerformanceService.aggregateDaily(yesterday);
    console.log(`[performanceAggregationCron] Daily done — ${results.length} records upserted`);
  } catch (err) {
    console.error("[performanceAggregationCron] Daily failed:", err.message);
    await alertFailure("aggregateDaily", err);
  }

  scheduleDaily();
}

function scheduleDaily() {
  const delay     = msUntilNextUTC(2, 0);
  const humanDelay = `${(delay / 3600000).toFixed(2)}h`;
  console.log(`[performanceAggregationCron] Next daily run in ${humanDelay} (02:00 UTC)`);
  _dailyTimeout = setTimeout(runDaily, delay);
  if (_dailyTimeout.unref) _dailyTimeout.unref();
}

// ── Weekly (Sunday 03:00 UTC) ─────────────────────────────────────────────────

async function runWeekly() {
  console.log("[performanceAggregationCron] Starting weekly rolling aggregations (7d + 30d)");

  for (const period of ["7d", "30d"]) {
    try {
      const results = await StrategyPerformanceService.aggregateRolling(period);
      console.log(`[performanceAggregationCron] Weekly ${period} done — ${results.length} records`);
    } catch (err) {
      console.error(`[performanceAggregationCron] Weekly ${period} failed:`, err.message);
      await alertFailure(`aggregateRolling('${period}')`, err);
    }
  }

  scheduleWeekly();
}

function scheduleWeekly() {
  const delay = msUntilNextSundayUTC(3, 0);
  console.log(`[performanceAggregationCron] Next weekly run in ${(delay / 3600000).toFixed(2)}h (Sun 03:00 UTC)`);
  _weeklyTimeout = setTimeout(runWeekly, delay);
  if (_weeklyTimeout.unref) _weeklyTimeout.unref();
}

// ── Monthly (1st of month 04:00 UTC) ─────────────────────────────────────────

async function runMonthly() {
  console.log("[performanceAggregationCron] Starting monthly all-time aggregation");

  try {
    const results = await StrategyPerformanceService.aggregateRolling("all-time");
    console.log(`[performanceAggregationCron] Monthly all-time done — ${results.length} records`);
  } catch (err) {
    console.error("[performanceAggregationCron] Monthly all-time failed:", err.message);
    await alertFailure("aggregateRolling('all-time')", err);
  }

  scheduleMonthly();
}

function scheduleMonthly() {
  const delay = msUntilFirstOfMonthUTC(4, 0);
  console.log(`[performanceAggregationCron] Next monthly run in ${(delay / 3600000).toFixed(2)}h (1st 04:00 UTC)`);
  _monthlyTimeout = setTimeout(runMonthly, delay);
  if (_monthlyTimeout.unref) _monthlyTimeout.unref();
}

// ── Public API ────────────────────────────────────────────────────────────────

function start() {
  if (_dailyTimeout) {
    console.warn("[performanceAggregationCron] Already running — call stop() first");
    return;
  }
  scheduleDaily();
  scheduleWeekly();
  scheduleMonthly();
  console.log("[performanceAggregationCron] Started (daily/weekly/monthly)");
}

function stop() {
  [_dailyTimeout, _weeklyTimeout, _monthlyTimeout].forEach(t => t && clearTimeout(t));
  _dailyTimeout = _weeklyTimeout = _monthlyTimeout = null;
  console.log("[performanceAggregationCron] Stopped");
}

module.exports = { start, stop, runDaily, runWeekly, runMonthly };
