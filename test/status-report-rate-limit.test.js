// ─────────────────────────────────────────────────────────────────────────────
// status-report-rate-limit.test.js — regression guards for two prod-log bugs:
//
//  BUG 1 (ZEC duplicate status report): each strategy-engine ran its OWN hourly
//  _statusReport, so a coin with N strategies stacked N reports in one log card
//  (ZEC=2 strategies → doubled; ETH=1 → looked fine). Fix: per-engine report is
//  suppressed (emitStatusReport:false) and the coordinator emits ONE aggregated
//  report via the leader engine.
//
//  BUG 2 (HBAR "getCandles error: okx Too many requests 50011"): OKX/Binance
//  getCandles had no rate-limit retry, so an IP-rate-limit burst dropped the bot
//  to stale cache. Fix: retry rate-limit errors with backoff; fail fast otherwise.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require("node:test");
const assert = require("node:assert");

const MultiStrategyCoordinator = require("../src/application/MultiStrategyCoordinator");
const BinanceClient = require("../src/infrastructure/exchange/BinanceClient");
const BitgetClient = require("../src/infrastructure/exchange/BitgetClient");

// Fake engine that records _logBlock calls (so we can assert what the leader emits).
function fakeEngine(strategyKey, state) {
  const captured = [];
  return {
    strategyKey,
    state,
    getState() { return this.state; },
    _logBlock(level, lines) { captured.push({ level, lines }); },
    captured,
  };
}

// ── BUG 1 ────────────────────────────────────────────────────────────────────

test("coordinator emits ONE aggregated status report via the leader (not N)", () => {
  const c = new MultiStrategyCoordinator({
    userId: "u1", symbol: "ZECUSDT",
    strategies: ["ADAPTIVE_FUSION", "TREND_FOLLOWING"],
    totalCapital: 210, engineFactory: () => ({}),
  });
  const leader = fakeEngine("ADAPTIVE_FUSION", {
    capital: 105, trades: [{ pnl: 5 }, { pnl: -2 }], openPositions: [{ side: "LONG" }],
  });
  const second = fakeEngine("TREND_FOLLOWING", {
    capital: 105, trades: [{ pnl: 3 }], openPositions: [],
  });
  c.engines.set("ADAPTIVE_FUSION", leader);
  c.engines.set("TREND_FOLLOWING", second);

  c._emitUnifiedStatus();

  // Exactly ONE report, emitted only by the leader (strategies[0]).
  assert.strictEqual(leader.captured.length, 1, "leader emits exactly one status block");
  assert.strictEqual(second.captured.length, 0, "non-leader emits nothing");

  const lines = leader.captured[0].lines;
  const text = lines.join("\n");
  // Single STATUS REPORT header (not stacked).
  assert.strictEqual((text.match(/STATUS REPORT/g) || []).length, 1, "one STATUS REPORT header");
  // Aggregated: capital = group total; 3 trades, 2 wins; 1 open; PnL = 5-2+3 = 6.
  assert.match(text, /Capital: \$210\.00/, "capital = group total");
  assert.match(text, /Trades: 3 \| Wins: 2 \| WR: 67%/, "trades/wins/WR aggregated across engines");
  assert.match(text, /Open positions: 1/, "open positions aggregated");
  assert.match(text, /PnL: \+\$6\.00/, "PnL aggregated across engines");
});

test("unified status is emitted as one multi-line block (one log card, not 4 logs)", () => {
  const c = new MultiStrategyCoordinator({
    userId: "u1", symbol: "ETHUSDT",
    strategies: ["ADAPTIVE_FUSION"], totalCapital: 105, engineFactory: () => ({}),
  });
  const leader = fakeEngine("ADAPTIVE_FUSION", { capital: 105, trades: [], openPositions: [] });
  c.engines.set("ADAPTIVE_FUSION", leader);

  c._emitUnifiedStatus();

  assert.strictEqual(leader.captured.length, 1, "single _logBlock call → single card");
  assert.strictEqual(leader.captured[0].lines.length, 4, "header + capital + trades + open = 4 lines");
});

// ── BUG 2 ────────────────────────────────────────────────────────────────────

test("getCandles retries on OKX 50011 rate-limit, then succeeds", async () => {
  const c = new BinanceClient("k", "s");
  let calls = 0;
  c.exchange.fetchOHLCV = async () => {
    calls += 1;
    if (calls === 1) throw new Error('okx {"msg":"Too many requests","code":"50011"}');
    return [[1000, 1, 2, 0.5, 1.5, 100]];
  };

  const candles = await c.getCandles("HBARUSDT", "4h", 200);

  assert.strictEqual(calls, 2, "retried once after the rate-limit error");
  assert.strictEqual(candles.length, 1);
  assert.strictEqual(candles[0].close, 1.5, "returns the candle from the successful retry");
});

test("getCandles retries up to 3 attempts then gives up (→ caller falls back to cache)", async () => {
  const c = new BinanceClient("k", "s");
  let calls = 0;
  c.exchange.fetchOHLCV = async () => {
    calls += 1;
    throw new Error("okx Too many requests 50011");
  };

  await assert.rejects(() => c.getCandles("HBARUSDT", "4h", 200), /getCandles error/);
  assert.strictEqual(calls, 3, "3 attempts total before surfacing the error");
});

test("getCandles fails FAST on a non-rate-limit error (no wasted retries)", async () => {
  const c = new BinanceClient("k", "s");
  let calls = 0;
  c.exchange.fetchOHLCV = async () => {
    calls += 1;
    throw new Error("binance does not have market symbol NONEXISTENT");
  };

  await assert.rejects(() => c.getCandles("NONEUSDT", "4h", 200), /getCandles error/);
  assert.strictEqual(calls, 1, "no retry on a non-rate-limit error");
});

// Bug 2 must hold across ALL exchanges — Bitget uses a different client + error
// vocabulary (code 30007 "request over limit" / 429) so it gets its own retry path.

test("Bitget getCandles retries on rate-limit (30007 over-limit) then succeeds", async () => {
  const c = new BitgetClient("k", "s", "p");
  let calls = 0;
  c._fetchMixCandles = async () => {
    calls += 1;
    if (calls === 1) throw new Error('bitget {"code":"30007","msg":"request over limit"}');
    return [{ timestamp: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }];
  };

  const candles = await c.getCandles("HBARUSDT", "4h", 200);

  assert.strictEqual(calls, 2, "Bitget retried once after the over-limit error");
  assert.strictEqual(candles[0].close, 1.5);
});

test("Bitget getCandles does NOT rate-limit-retry a normal error (falls to CCXT then throws)", async () => {
  const c = new BitgetClient("k", "s", "p");
  let directCalls = 0;
  c._fetchMixCandles = async () => { directCalls += 1; throw new Error("bad symbol XYZ"); };
  c.exchange.fetchOHLCV = async () => { throw new Error("bad symbol XYZ"); };

  await assert.rejects(() => c.getCandles("XYZUSDT", "4h", 200), /getCandles error/);
  assert.strictEqual(directCalls, 1, "no rate-limit retry on a non-rate-limit error");
});
