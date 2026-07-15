/**
 * Sprint 10/11 — MD_SD, MD_SA, BS_ICT, BS_LS unit tests.
 */

"use strict";

const assert = require("assert");
const { evaluateSupplyDemandEntry } = require("#core/strategy-engine/md/supplyDemandEntry.js");
const {
  evaluateStatisticalArbitrageEntry,
  _rollingMeanStd,
  _residualZScore,
} = require("#core/strategy-engine/md/statisticalArbitrage.js");
const {
  isKillZone,
  detectLiquidityRaid,
  evaluateIctStyleEntry,
} = require("#core/strategy-engine/bs/ictKillZoneRaid.js");
const {
  calculateOIChangePercent,
  evaluateOIFundingGate,
  detectLiquidationWick,
  evaluateLiquidationSqueezeEntry,
} = require("#core/strategy-engine/bs/liquidationSqueeze.js");
const { TIER_COMPONENT_MAP, LIVE_COMPONENT_KEYS, STRATEGY_CATALOG } = require("../src/config/strategies");
const MeanDriftUmbrella = require("#core/strategy-engine/umbrellas/MeanDriftUmbrella.js");
const BreakoutStormUmbrella = require("#core/strategy-engine/umbrellas/BreakoutStormUmbrella.js");
const { strategyRegistry } = require("#core/strategy-engine/StrategyRegistry.js");
const {
  resolveEntryReasons,
  formatSupplyDemandReasons,
  formatIctStyleReasons,
  formatLiquidationSqueezeReasons,
} = require("../src/server/services/csv/strategyReasonFormatters");

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

function flatSeries(n, v) {
  return Array(n).fill(v);
}

console.log("\n═══ Sprint 10/11 catalog + race pools ═══");

test("TIER_COMPONENT_MAP MINT/VAULT race participants", () => {
  assert.deepStrictEqual(TIER_COMPONENT_MAP.MINT.active, ["MD_MR", "MD_SD", "MD_SA"]);
  // Sprint 14: BS_BR halted from default VAULT race pool
  assert.deepStrictEqual(TIER_COMPONENT_MAP.VAULT.active, ["BS_ICT", "BS_LS"]);
  assert.deepStrictEqual(TIER_COMPONENT_MAP.VAULT.halted, ["BS_BR"]);
  assert.strictEqual(TIER_COMPONENT_MAP.MINT.combination.mode, "race");
  assert.strictEqual(TIER_COMPONENT_MAP.VAULT.combination.mode, "race");
});

test("catalog display names locked", () => {
  assert.strictEqual(STRATEGY_CATALOG.MD_SD.label, "Supply and Demand");
  assert.strictEqual(STRATEGY_CATALOG.MD_SA.label, "Statistical Arbitrage");
  assert.strictEqual(STRATEGY_CATALOG.BS_ICT.label, "ICT-style trading");
  assert.strictEqual(STRATEGY_CATALOG.BS_LS.label, "Liquidation/Squeeze Trading");
  for (const k of ["MD_SD", "MD_SA", "BS_ICT", "BS_LS"]) {
    assert.ok(LIVE_COMPONENT_KEYS.includes(k), k);
  }
});

test("registry resolves MD/BS racers to umbrellas", () => {
  const md = strategyRegistry.get("MD_SD");
  const bs = strategyRegistry.get("BS_ICT");
  assert.ok(md);
  assert.ok(bs);
  assert.strictEqual(strategyRegistry.get("MD_SA"), md);
  assert.strictEqual(strategyRegistry.get("BS_LS"), bs);
  assert.strictEqual(strategyRegistry.get("MD_MR"), md);
  assert.strictEqual(strategyRegistry.get("BS_BR"), bs);
});

console.log("\n═══ MD_SA Statistical Arbitrage ═══");

test("z-score LONG/SHORT symmetric", () => {
  const n = 60;
  const base = flatSeries(n, 100);
  // Crash last bar → LONG
  const longCloses = base.slice();
  longCloses[n - 1] = 90;
  const longR = evaluateStatisticalArbitrageEntry({
    closes: longCloses,
    lastIdx: n - 1,
    config: { mdSaEntryZ: 1.5, mdSaLookback: 40 },
  });
  // Spike last bar → SHORT
  const shortCloses = base.slice();
  shortCloses[n - 1] = 110;
  const shortR = evaluateStatisticalArbitrageEntry({
    closes: shortCloses,
    lastIdx: n - 1,
    config: { mdSaEntryZ: 1.5, mdSaLookback: 40 },
  });
  assert.strictEqual(longR.signal, "LONG");
  assert.strictEqual(shortR.signal, "SHORT");
  assert.ok(longR.zScore < 0);
  assert.ok(shortR.zScore > 0);
});

test("rolling mean/std helper", () => {
  const arr = [1, 2, 3, 4, 5];
  const s = _rollingMeanStd(arr, 4, 5);
  assert.ok(s);
  assert.ok(Math.abs(s.mean - 3) < 1e-9);
});

test("residual z-score vs benchmark", () => {
  const n = 50;
  const x = [];
  const y = [];
  for (let i = 0; i < n; i++) {
    x.push(100 + i * 0.1);
    y.push(50 + i * 0.05 + (i === n - 1 ? -5 : 0));
  }
  const r = _residualZScore(y, x, n - 1, 40);
  assert.ok(r);
  assert.ok(r.z < 0);
});

console.log("\n═══ BS_ICT Kill Zone + Raid ═══");

test("isKillZone UTC london_open / outside", () => {
  // 2026-07-13 07:30 UTC
  const inside = isKillZone(Date.UTC(2026, 6, 13, 7, 30));
  assert.strictEqual(inside.active, true);
  assert.strictEqual(inside.zone, "london_open");
  const outside = isKillZone(Date.UTC(2026, 6, 13, 3, 0));
  assert.strictEqual(outside.active, false);
});

test("liquidity raid HIGH→SHORT and LOW→LONG symmetric", () => {
  const lookback = 20;
  const n = lookback + 5;
  const highs = flatSeries(n, 105);
  const lows = flatSeries(n, 95);
  const closes = flatSeries(n, 100);
  const volumes = flatSeries(n, 1000);
  const volSMA = flatSeries(n, 800);
  // Set session range on prior bars
  for (let i = 0; i < n - 1; i++) {
    highs[i] = 105;
    lows[i] = 95;
  }
  const last = n - 1;
  // Raid high
  highs[last] = 108;
  lows[last] = 99;
  closes[last] = 104; // close back below session high 105
  volumes[last] = 2000;
  const up = detectLiquidityRaid(highs, lows, closes, volumes, volSMA, last, { sessionLookback: lookback });
  assert.strictEqual(up.detected, true);
  assert.strictEqual(up.direction, "SHORT");

  // Raid low
  highs[last] = 101;
  lows[last] = 92;
  closes[last] = 96;
  volumes[last] = 2000;
  const dn = detectLiquidityRaid(highs, lows, closes, volumes, volSMA, last, { sessionLookback: lookback });
  assert.strictEqual(dn.detected, true);
  assert.strictEqual(dn.direction, "LONG");
});

test("ICT entry outside kill zone still soft-allows", () => {
  const lookback = 20;
  const n = lookback + 5;
  const highs = flatSeries(n, 105);
  const lows = flatSeries(n, 95);
  const closes = flatSeries(n, 100);
  const volumes = flatSeries(n, 1000);
  const volSMA = flatSeries(n, 800);
  const timestamps = flatSeries(n, Date.UTC(2026, 6, 13, 3, 0)); // outside KZ
  const last = n - 1;
  highs[last] = 108;
  closes[last] = 104;
  volumes[last] = 2000;
  const r = evaluateIctStyleEntry({
    highs, lows, closes, volumes, volSMA, timestamps, lastIdx: last,
    config: { bsIctRequireKillZone: false },
  });
  assert.strictEqual(r.signal, "SHORT");
  assert.ok(r.confidence < 0.7);
});

console.log("\n═══ BS_LS Liquidation/Squeeze ═══");

test("OI change percent", () => {
  const hist = Array(25).fill(1000);
  hist[24] = 1100;
  const pct = calculateOIChangePercent(hist, 20);
  assert.ok(Math.abs(pct - 10) < 1e-9);
});

test("OI/funding gate fail-open when missing", () => {
  const r = evaluateOIFundingGate("LONG", {});
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.confidence, 1.0);
  assert.strictEqual(r.dataAvailable, false);
});

test("funding extreme mirror LONG/SHORT", () => {
  const longCrowd = evaluateOIFundingGate("LONG", { funding: 0.0006, oiHistory: Array(25).fill(1000) });
  const shortAgainst = evaluateOIFundingGate("SHORT", { funding: 0.0006, oiHistory: Array(25).fill(1000) });
  assert.ok(longCrowd.confidence < shortAgainst.confidence);

  const shortCrowd = evaluateOIFundingGate("SHORT", { funding: -0.0006, oiHistory: Array(25).fill(1000) });
  const longAgainst = evaluateOIFundingGate("LONG", { funding: -0.0006, oiHistory: Array(25).fill(1000) });
  assert.ok(shortCrowd.confidence < longAgainst.confidence);
});

test("liquidation wick LONG/SHORT + fail-open without OI", () => {
  const lookback = 20;
  const n = lookback + 3;
  const opens = flatSeries(n, 100);
  const highs = flatSeries(n, 102);
  const lows = flatSeries(n, 98);
  const closes = flatSeries(n, 100);
  const volumes = flatSeries(n, 1000);
  const volSMA = flatSeries(n, 800);
  for (let i = 0; i < n - 1; i++) {
    highs[i] = 102;
    lows[i] = 98;
  }
  const last = n - 1;
  // Wick low bounce → LONG
  opens[last] = 99;
  lows[last] = 95;
  highs[last] = 101;
  closes[last] = 100.5;
  volumes[last] = 1500;
  const longW = detectLiquidationWick(highs, lows, opens, closes, volumes, volSMA, last);
  assert.strictEqual(longW.detected, true);
  assert.strictEqual(longW.direction, "LONG");

  const entry = evaluateLiquidationSqueezeEntry({
    highs, lows, opens, closes, volumes, volSMA, lastIdx: last, exchangeData: {},
  });
  assert.strictEqual(entry.signal, "LONG");
  assert.strictEqual(entry.dataAvailable, false);

  // Wick high reject → SHORT
  opens[last] = 101;
  highs[last] = 105;
  lows[last] = 99;
  closes[last] = 99.5;
  const shortW = detectLiquidationWick(highs, lows, opens, closes, volumes, volSMA, last);
  assert.strictEqual(shortW.detected, true);
  assert.strictEqual(shortW.direction, "SHORT");
});

console.log("\n═══ MD_SD Supply and Demand (smoke) ═══");

test("SD entry returns structured result without crash on flat data", () => {
  const n = 50;
  const opens = flatSeries(n, 100);
  const highs = flatSeries(n, 101);
  const lows = flatSeries(n, 99);
  const closes = flatSeries(n, 100);
  const volumes = flatSeries(n, 1000);
  const volSMA = flatSeries(n, 1000);
  const atr = 1;
  const r = evaluateSupplyDemandEntry({
    opens, highs, lows, closes, volumes, volSMA, atr, lastIdx: n - 1,
  });
  assert.ok(r);
  assert.ok(r.signal === null || r.signal === "LONG" || r.signal === "SHORT");
});

console.log("\n═══ Umbrella race attribution ═══");

test("MeanDriftUmbrella single-racer isolation MD_SA", () => {
  const umb = new MeanDriftUmbrella();
  const n = 60;
  const closes = flatSeries(n, 100);
  closes[n - 1] = 90;
  const indicators = {
    opens: flatSeries(n, 100),
    highs: flatSeries(n, 101),
    lows: flatSeries(n, 99),
    closes,
    volumes: flatSeries(n, 1000),
    volSMA: flatSeries(n, 1000),
    atr: flatSeries(n, 1),
    rsi: flatSeries(n, 50),
    vwap: flatSeries(n, 100),
  };
  const signal = umb.detectSignal(indicators, n - 1, {
    mdActiveRacers: ["MD_SA"],
    selectedComponents: ["MD_SA"],
  });
  const meta = umb.getLastSignalMeta();
  if (signal) {
    assert.strictEqual(meta.winningComponent, "MD_SA");
    assert.strictEqual(meta.strategyLabel, "Statistical Arbitrage");
  }
});

test("BreakoutStormUmbrella BS_ICT attribution on raid", () => {
  const umb = new BreakoutStormUmbrella();
  const lookback = 20;
  const n = lookback + 5;
  const highs = flatSeries(n, 105);
  const lows = flatSeries(n, 95);
  const closes = flatSeries(n, 100);
  const volumes = flatSeries(n, 1000);
  const volSMA = flatSeries(n, 800);
  const timestamps = flatSeries(n, Date.UTC(2026, 6, 13, 12, 30)); // ny_open
  const last = n - 1;
  highs[last] = 108;
  closes[last] = 104;
  volumes[last] = 2000;
  const indicators = {
    opens: flatSeries(n, 100),
    highs,
    lows,
    closes,
    volumes,
    volSMA,
    atr: flatSeries(n, 1),
    timestamps,
  };
  const signal = umb.detectSignal(indicators, last, {
    bsActiveRacers: ["BS_ICT"],
    selectedComponents: ["BS_ICT"],
  });
  const meta = umb.getLastSignalMeta();
  assert.strictEqual(signal, "SHORT");
  assert.strictEqual(meta.winningComponent, "BS_ICT");
  assert.strictEqual(meta.strategyLabel, "ICT-style trading");
});

console.log("\n═══ Reason formatters ═══");

test("formatters for new keys non-empty", () => {
  assert.ok(formatSupplyDemandReasons({ winningComponent: "MD_SD", zoneType: "demand_ob" }).length > 0);
  assert.ok(formatIctStyleReasons({
    winningComponent: "BS_ICT",
    killZone: { active: true, zone: "ny_open" },
    raid: { detected: true, direction: "SHORT" },
  }).length > 0);
  assert.ok(formatLiquidationSqueezeReasons({
    winningComponent: "BS_LS",
    dataAvailable: false,
    wick: { detected: true },
  }).length > 0);
  assert.ok(resolveEntryReasons("MD_SA", { winningComponent: "MD_SA", zScore: -2.1, saMode: "rolling_mean" }).includes("Z-Score Extreme"));
  assert.ok(resolveEntryReasons("MD_SA", { winningComponent: "MD_SA", zScore: -2.1, saMode: "rolling_mean" }).includes("Std Threshold"));
});

console.log("\nAll Sprint 10/11 strategy tests passed.\n");
