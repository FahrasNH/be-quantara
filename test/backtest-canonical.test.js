/**
 * backtest-canonical.test.js — Opsi B shared archive
 * Run: node test/backtest-canonical.test.js
 */
"use strict";

const assert = require("assert");
const {
  buildCanonicalKey,
  resolveAction,
  filterSubset,
  ENGINE_VERSION,
  assertAtomicCanonicalExtendPayload,
  healArchivePayload,
  isEquityTradesDesync,
} = require("../src/server/services/BacktestCanonicalService");

let passed = 0;
let failed = 0;

function t(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

console.log("\nBACKTEST CANONICAL\n");

t("buildCanonicalKey is stable for same payload", () => {
  const payload = {
    symbol: "btcusdt",
    strategyKey: "ADAPTIVE_FUSION",
    timeframe: "1d",
    parameters: { capital: 500, atrMult: 1.4, emaFast: 9 },
    enableFees: true,
    enableSlippage: false,
    exchange: "bitget",
    dataSource: "real",
    periodLabel: "500",
  };
  const a = buildCanonicalKey(payload);
  const b = buildCanonicalKey({ ...payload, parameters: { emaFast: 9, capital: 500, atrMult: 1.4 } });
  assert.strictEqual(a, b);
  assert.strictEqual(a.length, 64);
});

t("buildCanonicalKey differs when engine inputs change", () => {
  const base = {
    symbol: "ETHUSDT",
    strategyKey: "MEAN_REVERSION",
    timeframe: "4h",
    parameters: { capital: 500 },
    enableFees: true,
    enableSlippage: false,
    exchange: "sim",
    dataSource: "sim",
    periodLabel: "500",
  };
  const k1 = buildCanonicalKey(base);
  const k2 = buildCanonicalKey({ ...base, enableSlippage: true });
  assert.notStrictEqual(k1, k2);
});

t("resolveAction returns miss without record", () => {
  assert.strictEqual(resolveAction(null, Date.parse("2024-01-01"), Date.parse("2024-06-01")), "miss");
});

t("resolveAction returns reused for same range", () => {
  const record = {
    canonical_key: "abc",
    engine_version: ENGINE_VERSION,
    data_start: "2024-01-01T00:00:00.000Z",
    data_end: "2024-06-01T00:00:00.000Z",
  };
  const action = resolveAction(
    record,
    Date.parse("2024-01-01T00:00:00.000Z"),
    Date.parse("2024-06-01T00:00:00.000Z"),
  );
  assert.strictEqual(action, "reused");
});

t("resolveAction returns subset for narrower window", () => {
  const record = {
    canonical_key: "abc",
    engine_version: ENGINE_VERSION,
    data_start: "2024-01-01T00:00:00.000Z",
    data_end: "2024-12-31T00:00:00.000Z",
  };
  const action = resolveAction(
    record,
    Date.parse("2024-03-01T00:00:00.000Z"),
    Date.parse("2024-06-01T00:00:00.000Z"),
  );
  assert.strictEqual(action, "subset");
});

t("resolveAction returns extend when end exceeds stored", () => {
  const record = {
    canonical_key: "abc",
    engine_version: ENGINE_VERSION,
    data_start: "2024-01-01T00:00:00.000Z",
    data_end: "2024-06-01T00:00:00.000Z",
  };
  const action = resolveAction(
    record,
    Date.parse("2024-01-01T00:00:00.000Z"),
    Date.parse("2024-12-01T00:00:00.000Z"),
  );
  assert.strictEqual(action, "extend");
});

t("filterSubset recalculates metrics for trade window", () => {
  const record = {
    config: { parameters: { capital: 500 } },
    trades_data: [
      { date: "2024-01-15T00:00:00.000Z", pnl: 10 },
      { date: "2024-02-15T00:00:00.000Z", pnl: -5 },
      { date: "2024-05-15T00:00:00.000Z", pnl: 20 },
    ],
    equity_curve: [
      { date: "2024-01-15T00:00:00.000Z", value: 510 },
      { date: "2024-02-15T00:00:00.000Z", value: 505 },
      { date: "2024-05-15T00:00:00.000Z", value: 525 },
    ],
  };
  const start = Date.parse("2024-02-01T00:00:00.000Z");
  const end = Date.parse("2024-03-01T00:00:00.000Z");
  const { metrics, trades, equity } = filterSubset(record, start, end);
  assert.strictEqual(trades.length, 1);
  assert.strictEqual(trades[0].pnl, -5);
  assert.strictEqual(equity.length, 1);
  assert.strictEqual(metrics.totalTrades, 1);
  assert.strictEqual(metrics.wins, 0);
  assert.strictEqual(metrics.losses, 1);
});

// Regression: COALESCE partial-write desync (0 trades + stale declining equity)
t("assertAtomicCanonicalExtendPayload rejects missing equity_curve", () => {
  assert.throws(
    () => assertAtomicCanonicalExtendPayload({ equityCurve: null, tradesData: [] }),
    (err) => err && err.code === "EQUITY_CURVE_REQUIRED" && err.statusCode === 400,
  );
  assert.throws(
    () => assertAtomicCanonicalExtendPayload({ equityCurve: undefined }),
    (err) => err && err.code === "EQUITY_CURVE_REQUIRED",
  );
  assert.throws(
    () => assertAtomicCanonicalExtendPayload({}),
    (err) => err && err.code === "EQUITY_CURVE_REQUIRED",
  );
});

t("assertAtomicCanonicalExtendPayload accepts empty equity + trades arrays", () => {
  assert.doesNotThrow(() =>
    assertAtomicCanonicalExtendPayload({ equityCurve: [], tradesData: [] }),
  );
  assert.doesNotThrow(() =>
    assertAtomicCanonicalExtendPayload({
      equityCurve: [{ date: "2024-01-01", value: 1000 }],
      tradesData: null,
    }),
  );
});

t("assertAtomicCanonicalExtendPayload rejects non-array trades_data when provided", () => {
  assert.throws(
    () => assertAtomicCanonicalExtendPayload({ equityCurve: [], tradesData: { bad: true } }),
    (err) => err && err.code === "TRADES_DATA_INVALID" && err.statusCode === 400,
  );
});

// Heal-on-read: corrupted COALESCE rows (0 trades + declining equity)
t("isEquityTradesDesync detects 0 trades with -70% equity curve", () => {
  assert.strictEqual(
    isEquityTradesDesync(
      { totalTrades: 0, totalReturn: "0.0" },
      [],
      [
        { date: "2025-07-13", value: 1000 },
        { date: "2025-10-01", value: 700 },
        { date: "2026-07-13", value: 300 },
      ],
    ),
    true,
  );
});

t("healArchivePayload clears declining equity when trades empty", () => {
  const healed = healArchivePayload({
    metrics: { totalTrades: 0, totalReturn: "0.0", maxDrawdown: "0.0" },
    trades: [],
    equity_curve: [
      { date: "2025-07-13", value: 1000 },
      { date: "2026-07-13", value: 300 },
    ],
    capital: 1000,
  });
  assert.strictEqual(healed.healed, true);
  assert.strictEqual(healed.healReason, "clear_equity_empty_trades");
  assert.deepStrictEqual(healed.equity_curve, []);
  assert.strictEqual(healed.metrics.totalTrades, 0);
});

t("healArchivePayload rebuilds metrics from trades when metrics say 0", () => {
  const healed = healArchivePayload({
    metrics: { totalTrades: 0 },
    trades: [
      { date: "2025-08-01", pnl: 50 },
      { date: "2025-09-01", pnl: -20 },
    ],
    equity_curve: [],
    capital: 1000,
  });
  assert.strictEqual(healed.healed, true);
  assert.strictEqual(healed.metrics.totalTrades, 2);
  assert.ok(healed.equity_curve.length >= 2);
  assert.strictEqual(healed.equity_curve[healed.equity_curve.length - 1].value, 1030);
});

console.log(`\n${failed === 0 ? "✅" : "❌"} BACKTEST CANONICAL: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
