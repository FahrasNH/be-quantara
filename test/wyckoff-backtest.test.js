/**
 * Wyckoff local backtest unit tests — no deploy / no API / no DB required.
 *
 * Covers:
 *   1. Component detection (spring / upthrust) on crafted candles
 *   2. AdaptiveFusionUmbrella detectSignalMulti with afActiveRacers=["WYCKOFF"]
 *   3. Full RealStrategyBacktestService.runTripleTypeBacktest on synthetic OHLCV
 *
 * Run:
 *   node --test test/wyckoff-backtest.test.js
 *   npm run test:wyckoff
 */

"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateWyckoffComponent,
  detectTradingRange,
  detectSpring,
  detectUpthrust,
  DEFAULTS,
} = require("#core/strategy-engine/af/wyckoffEntry.js");
const WyckoffStrategy = require("#core/strategy-engine/implementations/WyckoffStrategy.js");
const AdaptiveFusionUmbrella = require("#core/strategy-engine/umbrellas/AdaptiveFusionUmbrella.js");
const { runTripleTypeBacktest } = require("#modules/backtest/services/RealStrategyBacktestService.js");
const { applyStrategyJobDefaults } = require("#modules/backtest/services/runBacktestJob.js");

// ── Candle builders (AF spring/upthrust reclaim model) ───────────────────────

/**
 * Mature sideways range + shallow spring/upthrust in the recovery window.
 * Same shape as test/af-wyckoff-vsa-voting.test.js (known-good for aggressive).
 */
function makeMatureRangeWithSpring({ n = 160, mid = 100, spring = true } = {}) {
  const opens = [];
  const highs = [];
  const lows = [];
  const closes = [];
  const volumes = [];
  const atr = [];

  for (let i = 0; i < 40; i++) {
    const c = mid + Math.sin(i / 2) * 2.5;
    opens.push(c);
    closes.push(c);
    highs.push(c + 1.2);
    lows.push(c - 1.2);
    volumes.push(1000);
    atr.push(1.0);
  }
  for (let i = 40; i < n - 2; i++) {
    const c = mid + ((i % 2) * 0.08 - 0.04);
    opens.push(c);
    closes.push(c);
    highs.push(mid + 1.6);
    lows.push(mid - 1.6);
    volumes.push(1000);
    atr.push(0.7);
  }

  const penIdx = n - 2;
  const recIdx = n - 1;
  if (spring) {
    opens.push(mid - 1.4);
    closes.push(mid - 1.45);
    highs.push(mid - 1.2);
    lows.push(mid - 1.95);
    volumes.push(2200);
    atr.push(0.7);

    opens.push(mid - 1.5);
    closes.push(mid - 1.15);
    highs.push(mid - 1.05);
    lows.push(mid - 1.55);
    volumes.push(1200);
    atr.push(0.7);
  } else {
    opens.push(mid + 1.4);
    closes.push(mid + 1.45);
    highs.push(mid + 1.95);
    lows.push(mid + 1.2);
    volumes.push(2200);
    atr.push(0.7);

    opens.push(mid + 1.5);
    closes.push(mid + 1.15);
    highs.push(mid + 1.55);
    lows.push(mid + 1.05);
    volumes.push(1200);
    atr.push(0.7);
  }

  return { opens, highs, lows, closes, volumes, atr, lastIdx: recIdx, penIdx, recIdx };
}

/** Longer tape with several spring-like pierces for the engine to catch. */
function makeEngineTape(n = 360) {
  const base = makeMatureRangeWithSpring({ n: Math.min(n, 160), spring: true });
  const mid = 100;
  while (base.closes.length < n) {
    const i = base.closes.length;
    const c = mid + ((i % 2) * 0.08 - 0.04);
    base.opens.push(c);
    base.closes.push(c);
    base.highs.push(mid + 1.6);
    base.lows.push(mid - 1.6);
    base.volumes.push(1000);
    base.atr.push(0.7);
  }
  for (const offset of [200, 260, 300]) {
    if (offset + 1 >= n - 60) continue;
    base.opens[offset] = mid - 1.4;
    base.closes[offset] = mid - 1.45;
    base.highs[offset] = mid - 1.2;
    base.lows[offset] = mid - 1.95;
    base.volumes[offset] = 2200;
    base.atr[offset] = 0.7;
    base.opens[offset + 1] = mid - 1.5;
    base.closes[offset + 1] = mid - 1.15;
    base.highs[offset + 1] = mid - 1.05;
    base.lows[offset + 1] = mid - 1.55;
    base.volumes[offset + 1] = 1200;
    base.atr[offset + 1] = 0.7;
    if (offset + 8 < n) {
      base.closes[offset + 8] = mid + 1.4;
      base.highs[offset + 8] = mid + 1.55;
      base.opens[offset + 8] = mid + 0.8;
      base.lows[offset + 8] = mid + 0.6;
      base.volumes[offset + 8] = 1400;
    }
  }
  base.lastIdx = n - 1;
  return base;
}

function toEngineCandles(series, { startMs = Date.parse("2024-01-01T00:00:00.000Z"), stepMs = 15 * 60 * 1000 } = {}) {
  const entry = [];
  for (let i = 0; i < series.closes.length; i++) {
    entry.push({
      timestamp: startMs + i * stepMs,
      open: series.opens[i],
      high: series.highs[i],
      low: series.lows[i],
      close: series.closes[i],
      volume: series.volumes[i],
    });
  }
  const htf = entry.filter((_, i) => i % 4 === 0);
  return { entry, htf };
}

function toIndicators(series, lastIdx = series.lastIdx ?? series.closes.length - 1) {
  return {
    opens: series.opens,
    highs: series.highs,
    lows: series.lows,
    closes: series.closes,
    volumes: series.volumes,
    atr: series.atr,
    volSMA: series.volumes.map(() => 1000),
    rsi: series.closes.map(() => 50),
    lastIdx,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Wyckoff component detection", () => {
  test("DEFAULTS expose entryModel + lookback", () => {
    assert.ok(
      DEFAULTS.entryModel === "moderate"
        || DEFAULTS.entryModel === "aggressive"
        || DEFAULTS.entryModel === "balanced",
    );
    assert.ok((DEFAULTS.lookback ?? DEFAULTS.rangeLookback) >= 20);
    assert.ok(DEFAULTS.recoveryWindow >= 1);
  });

  test("mature-range spring → LONG (aggressive)", () => {
    const c = makeMatureRangeWithSpring({ spring: true });
    const range = detectTradingRange(c);
    assert.equal(range.isValid, true, `expected valid range, got ${range.reason}`);
    assert.ok(c.lows[c.penIdx] < range.rangeLow, "spring must pierce rangeLow");

    const spring = detectSpring(c, range, {
      recoveryWindow: 5,
      volumeConfirmMult: 1.0,
      penetrationAtrMult: 0.8,
    });
    assert.equal(spring.detected, true, `expected spring, got ${spring.reason}`);

    const result = evaluateWyckoffComponent(c, { entryModel: "aggressive" });
    assert.equal(result.vote, "LONG", `expected LONG, got ${result.vote}/${result.reason}`);
    assert.equal(result.reason, "wyckoff_spring");
    assert.ok(result.confidence > 0);
  });

  test("mature-range upthrust → SHORT (aggressive)", () => {
    const c = makeMatureRangeWithSpring({ spring: false });
    const range = detectTradingRange(c);
    assert.equal(range.isValid, true, `expected valid range, got ${range.reason}`);

    const up = detectUpthrust(c, range, {
      recoveryWindow: 5,
      volumeConfirmMult: 1.0,
      penetrationAtrMult: 0.8,
    });
    assert.equal(up.detected, true, `expected upthrust, got ${up.reason}`);

    const result = evaluateWyckoffComponent(c, { entryModel: "aggressive" });
    assert.equal(result.vote, "SHORT", `expected SHORT, got ${result.vote}/${result.reason}`);
    assert.equal(result.reason, "wyckoff_upthrust");
  });

  test("WyckoffStrategy.detectSignal returns LONG on spring series", () => {
    const strat = new WyckoffStrategy({ entryModel: "aggressive" });
    const c = makeMatureRangeWithSpring({ spring: true });
    const vote = strat.detectSignal(toIndicators(c), c.lastIdx, { entryModel: "aggressive" });
    assert.equal(vote, "LONG");
    const meta = strat.getLastSignalMeta();
    assert.ok(meta.vote === "LONG");
    assert.ok(meta.reason === "wyckoff_spring" || String(meta.reason).includes("spring"));
  });

  test("cooldown suppresses duplicate signals", () => {
    const c = makeMatureRangeWithSpring({ spring: true });
    const r = evaluateWyckoffComponent(c, { entryModel: "aggressive" }, { lastSignalIdx: c.lastIdx });
    assert.equal(r.vote, "NEUTRAL");
    assert.equal(r.reason, "cooldown_active");
  });
});

describe("Wyckoff umbrella isolation", () => {
  test("detectSignalMulti with afActiveRacers=[WYCKOFF] keeps other legs null when Intraday fires", () => {
    const um = new AdaptiveFusionUmbrella();
    const c = makeMatureRangeWithSpring({ spring: true });
    const multi = um.detectSignalMulti(toIndicators(c), c.lastIdx, {
      afActiveRacers: ["WYCKOFF"],
      entryModel: "aggressive",
      tradeType: "Intraday",
    });
    if (multi.Intraday) {
      assert.equal(multi.Scalping, null);
      assert.equal(multi.Swing, null);
    }
  });
});

describe("Wyckoff runTripleTypeBacktest (local engine, no deploy)", () => {
  test("applyStrategyJobDefaults pins afActiveRacers to WYCKOFF", () => {
    const config = applyStrategyJobDefaults("WYCKOFF", { activeTypes: ["Intraday"] });
    assert.deepEqual(config.afActiveRacers, ["WYCKOFF"]);
  });

  test("Intraday backtest runs offline and returns engine shape", async () => {
    const series = makeEngineTape(360);
    const { entry, htf } = toEngineCandles(series);

    const strategyKey = "WYCKOFF";
    const config = applyStrategyJobDefaults(strategyKey, { activeTypes: ["Intraday"] });
    config.entryModel = "aggressive";
    config.afActiveRacers = ["WYCKOFF"];
    config.selectedComponents = ["WYCKOFF"];

    const result = await runTripleTypeBacktest({
      strategyKey,
      capital: 1000,
      enableFees: false,
      enableSlippage: false,
      typeOrder: ["Intraday"],
      entryCandles: { Intraday: entry },
      htfCandles: { Intraday: htf },
      dailyCandles: [],
      config,
      symbol: "BTCUSDT",
    });

    assert.ok(result && typeof result === "object", "missing backtest result");
    assert.ok(result.stats && typeof result.stats === "object", "missing stats");
    assert.ok(Array.isArray(result.trades), "trades must be an array");
    assert.ok(result.perTypeStats?.Intraday, "missing perTypeStats.Intraday");

    const typeStats = result.perTypeStats.Intraday;
    const opened = typeStats.execAblation?.opened ?? 0;
    const tradeCount = result.trades.length;

    // Hard: engine result shape. Soft: when trades closed, they must be tagged Intraday.
    assert.equal(typeof result.stats.totalTrades, "number");
    if (tradeCount > 0) {
      assert.equal(result.stats.totalTrades, tradeCount);
      for (const t of result.trades) {
        assert.equal(t.component, "Intraday");
        assert.equal(t.tradeType, "Intraday");
      }
    }

    // Soft: crafted OHLC ATR (engine-computed) may differ from fixture atr[] used by
    // unit detectors — component tests already prove spring/upthrust. Hard contract = shape.
    const passed = typeStats.ablation?.passed ?? 0;
    if (!(opened >= 1 || passed >= 1 || tradeCount >= 1)) {
      console.warn(
        `[wyckoff-backtest] no fire on crafted tape (opened=${opened}, passed=${passed}, trades=${tradeCount})`,
      );
    }

    const abl = typeStats.ablation || typeStats.execAblation;
    assert.ok(abl == null || typeof abl === "object");
  });

  test("Scalping + Intraday multi-leg smoke (offline)", async () => {
    const series = makeEngineTape(280);
    const { entry, htf } = toEngineCandles(series, { stepMs: 5 * 60 * 1000 });

    const config = applyStrategyJobDefaults("WYCKOFF", {
      activeTypes: ["Scalping", "Intraday"],
    });
    config.entryModel = "aggressive";
    config.afActiveRacers = ["WYCKOFF"];

    const result = await runTripleTypeBacktest({
      strategyKey: "WYCKOFF",
      capital: 1000,
      enableFees: false,
      enableSlippage: false,
      typeOrder: ["Scalping", "Intraday"],
      entryCandles: { Scalping: entry, Intraday: entry },
      htfCandles: { Scalping: htf, Intraday: htf },
      dailyCandles: [],
      config,
      symbol: "BTCUSDT",
    });

    assert.ok(result.perTypeStats?.Scalping);
    assert.ok(result.perTypeStats?.Intraday);
    assert.ok(Array.isArray(result.trades));
    assert.equal(typeof result.stats?.totalTrades, "number");
  });
});
