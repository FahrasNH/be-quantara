"use strict";

const assert = require("assert");

const DEFAULTS = require("../src/config/strategyDefaults");
const { evaluateMeanReversionEntry, resolveMrComponentScope } = require("../src/core/strategy-engine/md/meanReversionEntry");
const MeanReversionStrategy = require("../src/core/strategy-engine/implementations/MeanReversionStrategy");
const { applyRegimeGate } = require("../src/core/signal-engine/dailyRegimeGate");
const { meanReversionRegimeFilter } = require("../src/core/signal-engine/htfRegimeFilter");

function makeReversalIndicators(currentClose = 41500, currentRsi = 35) {
  const closes = Array(60).fill(42000);
  closes[58] = 40000;
  closes[59] = currentClose;

  const rsi = Array(60).fill(50);
  rsi[58] = 20;
  rsi[59] = currentRsi;

  return {
    closes,
    opens: closes.map((value) => value),
    highs: closes.map((value) => value + 50),
    lows: closes.map((value) => value - 50),
    volumes: Array(60).fill(1000),
    vwap: Array(60).fill(42000),
    atr: Array(60).fill(100),
    rsi,
    volSMA: Array(60).fill(1000),
  };
}

function evaluateTypedEntry(tradeType, indicators = makeReversalIndicators()) {
  return evaluateMeanReversionEntry({
    indicators,
    lastIdx: 59,
    config: {
      tradeType,
      mdAdxGateEnabled: false,
      mdObFvgEnabled: false,
      minVolRatio: 0.1,
    },
    defaults: DEFAULTS,
  });
}

function test(name, fn) {
  fn();
  console.log(`✓ ${name}`);
}

test("maps production trade types to isolated mean-reversion components", () => {
  assert.strictEqual(resolveMrComponentScope({ tradeType: "Scalping" }), "Scalping");
  assert.strictEqual(resolveMrComponentScope({ tradeType: "Intraday" }), "Intraday");
  assert.strictEqual(resolveMrComponentScope({ tradeType: "Swing" }), "Intraday");
});

test("requires a confirmed reversal and attributes only the requested component", () => {
  const scalp = evaluateTypedEntry("Scalping");
  const intraday = evaluateTypedEntry("Intraday");

  assert.ok(scalp, "scalping reversal should be confirmed");
  assert.ok(intraday, "intraday reversal should be confirmed");
  assert.strictEqual(scalp.meta.component, "Scalping");
  assert.strictEqual(intraday.meta.component, "Intraday");
  assert.strictEqual(scalp.meta.mrConfirmation, "reentry_and_rsi_turn");
  assert.strictEqual(intraday.meta.mrConfirmation, "reentry_and_rsi_turn");
  assert.strictEqual(scalp.meta.mrSetupIdx, 58);
  assert.strictEqual(intraday.meta.mrSetupIdx, 58);
});

test("rejects an oversold setup that has not reverted", () => {
  const rejected = evaluateTypedEntry(
    "Intraday",
    makeReversalIndicators(40500, 18),
  );

  assert.ok(rejected);
  assert.strictEqual(rejected.signal, null);
  assert.strictEqual(rejected.meta, null);
});

test("blocks mean reversion in strong daily trend and scales risk in chop", () => {
  const blocked = applyRegimeGate({
    signal: "LONG",
    strategyKey: "MEAN_REVERSION",
    regime: "STRONG_TREND",
    riskPerTrade: 0.01,
  });
  const chop = applyRegimeGate({
    signal: "LONG",
    strategyKey: "MEAN_REVERSION",
    regime: "CHOP",
    riskPerTrade: 0.01,
  });

  assert.strictEqual(blocked.allow, false);
  assert.strictEqual(blocked.reason, "strong_trend_mean_reversion_blocked");
  assert.strictEqual(chop.allow, true);
  assert.strictEqual(chop.riskPerTrade, 0.005);
});

test("blocks strong higher-timeframe trend only when explicitly enabled", () => {
  const htfData = {
    close: 42000,
    emaFast: 41000,
    emaSlow: 40000,
    rsi: 65,
    atr: 500,
    atrBaseline: 400,
  };

  assert.strictEqual(
    meanReversionRegimeFilter({ direction: "LONG", htfData, blockStrongTrend: true }).allowed,
    false,
  );
  assert.strictEqual(
    meanReversionRegimeFilter({ direction: "LONG", htfData, blockStrongTrend: false }).allowed,
    true,
  );
});

test("floors mean-reversion take profit at the configured minimum RR", () => {
  const strategy = new MeanReversionStrategy();
  strategy._lastSignalMeta = {
    tpOverride: 42080,
    tpSource: "bb_middle",
  };

  const risk = strategy.calculateRiskConfig(
    42000,
    100,
    "LONG",
    "Intraday",
    { slMultiplier: 1, tpMultiplier: 1 },
  );

  assert.strictEqual(risk.riskReward, 2);
  assert.strictEqual(risk.tpSource, "min_rr_floor");
  assert.strictEqual(risk.takeProfit, 42200);
});

console.log("All mean-reversion edge-fix tests passed.");
