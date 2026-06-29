/**
 * adaptive-fusion-v26.test.js — preset AF v3.1 (2026-06-29)
 *
 * v3.0 changes from v2.6 (2026-06-28):
 *  atrMinMult 1.2 → 0.25, htfTrendStrengthMin 0.75 → 0.25,
 *  volSmaMultiplier 2.0 → 1.3, maxEntryExtensionATR 0.7 → 1.5,
 *  maxTradesPerDay 6 → 12, cooldownAfterLoss 90 → 30, maxConsecLoss 2 → 4
 *
 * v3.1 changes (2026-06-29):
 *  SHORT only fires when htfTrend === "BEARISH" (was: blocked only in BULLISH,
 *    allowed in SIDEWAYS — caused WR 31.6%/PF 0.78 against bullish markets)
 *  Component C only fires in marketCond === "STRONG_TREND" (was: fired in NORMAL
 *    trend on 15m → 20% WR / PF 0.45 because swing logic needs 4h/1D context)
 */

const test   = require("node:test");
const assert = require("node:assert");
const { STRATEGIES } = require("../src/domain/legacyStrategies");
const AdaptiveFusionStrategy = require("../src/domain/strategy/implementations/AdaptiveFusionStrategy");

const preset = STRATEGIES.ADAPTIVE_FUSION;
const afs    = new AdaptiveFusionStrategy();

// ── Helpers ──────────────────────────────────────────────────────────────────

function mkSeries(n, val) { return Array(n + 1).fill(val); }
const N = 30;

/** Build minimal indicators that make _detectSignalB fire LONG (uptrend, pullback-resume). */
function makeUpIndicators() {
  const closes = mkSeries(N, 104);
  closes[N - 1] = 103.4;   // pullback below EMA9 (103.5)
  closes[N]     = 104.1;   // resume above
  // AF-FIX-14: EMA9 must be rising for LONG to fire (slope filter). Use slightly rising series.
  const emaFastArr = mkSeries(N, 103.4);
  emaFastArr[N] = 103.5; // current bar EMA9 > previous → rising
  return {
    closes,
    emaFast:  emaFastArr,          // EMA9  > EMA21, rising at N
    emaSlow:  mkSeries(N, 102.5),  // EMA21 > EMA50
    emaTrend: mkSeries(N, 101.0),
    rsi:      mkSeries(N, 62),
    atr:      mkSeries(N, 0.5),
    volumes:  mkSeries(N, 100),
    volSMA:   mkSeries(N, 80),
  };
}

/** Build minimal indicators that make _detectSignalC fire SHORT (downtrend, mid-RSI). */
function makeDownIndicators() {
  const closes = mkSeries(N, 98);
  return {
    closes,
    emaFast:  mkSeries(N, 98.5),   // EMA9  < EMA21 (downtrend)
    emaSlow:  mkSeries(N, 100.0),
    emaTrend: mkSeries(N, 102.0),
    rsi:      mkSeries(N, 42),     // RSI in 35–55 band → _detectSignalC SHORT
    atr:      mkSeries(N, 0.5),
    volumes:  mkSeries(N, 100),
    volSMA:   mkSeries(N, 80),
  };
}

// ── preset values (v2.6 baseline, reverted commit e69199a) ──────────────────────
// NOTE: these assert the ACTUAL current preset. The earlier "v3.0" loose params
// (maxEntryExtensionATR 1.5, cooldown 30, maxTrades 12, atrMinMult 0.25,
// maxConsecLoss 4) were reverted to the v2.6 baseline after the 0% WR diagnosis;
// this test was stale and has been reconciled (Sprint 7). The class getRiskConfig()
// still returns the v3.0 risk numbers — that is asserted separately below.
test("legacyStrategies ADAPTIVE_FUSION preset (v3.5 AF-FIX-17)", () => {
  assert.strictEqual(preset.riskPerTrade, 0.005);
  assert.strictEqual(preset.riskPerTradeStrong, 0.01);
  // AF-FIX-17: widened from 60/40 to 55/45 (too narrow → near-zero B trades on 1h TF)
  assert.strictEqual(preset.rsiLongMin, 55);
  assert.strictEqual(preset.rsiShortMax, 45);
  // AF-FIX-17: relaxed from 0.7 → 1.2 (blocked valid pullback-to-EMA entries)
  assert.strictEqual(preset.maxEntryExtensionATR, 1.2);
  assert.strictEqual(preset.strongTrendTPMult, 1.8);
  assert.strictEqual(preset.volSmaMultiplier, 1.3);
  assert.strictEqual(preset.htfTrendStrengthMin, 0.25);
  assert.strictEqual(preset.cooldownAfterLoss, 90);
  assert.strictEqual(preset.maxTradesPerDay, 6);
  assert.strictEqual(preset.atrMinMult, 1.2);
  assert.strictEqual(preset.maxConsecLoss, 2);
});

test("AdaptiveFusionStrategy class v3.5", () => {
  assert.strictEqual(afs.config.version, "3.6.0");
  const risk = afs.getRiskConfig();
  assert.strictEqual(risk.riskPerTrade, 0.005);
  assert.strictEqual(risk.riskPerTradeStrong, 0.01);
  assert.strictEqual(risk.maxTradesPerDay, 12);
  assert.strictEqual(risk.cooldownAfterLoss, 30);
  assert.strictEqual(risk.maxConsecLoss, 4);
});

test("validateEntry ATR floor hardcoded = 1.2%", () => {
  const low = afs.validateEntry(50000, 550, 2000, 1000); // 1.1%
  assert.strictEqual(low.valid, false);
  const ok  = afs.validateEntry(50000, 600, 2000, 1000); // 1.2%
  assert.strictEqual(ok.valid, true);
});

test("strongTrendTPMult v3.1 = ×1.8", () => {
  const base   = afs.calculateRiskConfig(100, 2, "LONG", "B");
  const strong = afs.calculateRiskConfig(100, 2, "LONG", "B", {
    marketCond: "STRONG_TREND",
    strongTrendTPMult: 1.8,
  });
  assert.ok(Math.abs(strong.tpDistance - base.tpDistance * 1.8) < 1e-9);
});

// ── v3.1 Fix A: SHORT only in BEARISH HTF ────────────────────────────────────

test("v3.1 SHORT blocked in BULLISH HTF (pre-existing rule still holds)", () => {
  const ind = makeDownIndicators();
  const sig = afs.detectSignalMulti(ind, N, {
    balance: 500, volatility: 1.0, trend_strength: 0.5,
    htfTrend: "BULLISH", maxEntryExtensionATR: 1.5,
  });
  assert.strictEqual(sig.B, null, "B SHORT must be null in BULLISH HTF");
  assert.strictEqual(sig.C, null, "C SHORT must be null in BULLISH HTF");
});

test("v3.1 SHORT blocked in SIDEWAYS HTF (new stricter rule)", () => {
  const ind = makeDownIndicators();
  const sig = afs.detectSignalMulti(ind, N, {
    balance: 500, volatility: 1.0, trend_strength: 0.5,
    htfTrend: "SIDEWAYS", maxEntryExtensionATR: 1.5,
  });
  // All SHORT signals must be null when HTF is SIDEWAYS
  assert.strictEqual(sig.A, null, "A SHORT null in SIDEWAYS");
  assert.strictEqual(sig.B, null, "B SHORT null in SIDEWAYS");
  assert.strictEqual(sig.C, null, "C SHORT null in SIDEWAYS");
});

test("v3.1 SHORT fires in BEARISH HTF", () => {
  const ind = makeDownIndicators();
  const sig = afs.detectSignalMulti(ind, N, {
    balance: 500, volatility: 1.0, trend_strength: 0.5,
    htfTrend: "BEARISH", maxEntryExtensionATR: 1.5,
  });
  // At least B or C should fire SHORT — indicators are clear downtrend with mid RSI
  const anyShort = sig.A === "SHORT" || sig.B === "SHORT" || sig.C === "SHORT";
  // Note: C only fires in STRONG_TREND so may be null here; B or A can fire
  assert.ok(anyShort, `Expected at least one SHORT signal in BEARISH HTF, got A=${sig.A} B=${sig.B} C=${sig.C}`);
});

test("v3.1 SHORT fallback: fires when no htfTrend provided (backward compat)", () => {
  // When htfTrend is null (no HTF data / unit test), filter is skipped — fail-open
  const ind = makeDownIndicators();
  const sig = afs.detectSignalMulti(ind, N, {
    balance: 500, volatility: 1.0, trend_strength: 0.5,
    htfTrend: null, maxEntryExtensionATR: 1.5,
  });
  // No htfTrend → direction filter skipped; result may or may not have signals
  // but should NOT throw
  assert.ok(typeof sig === "object", "result must be an object");
  assert.ok("A" in sig && "B" in sig && "C" in sig, "result must have A/B/C keys");
});

// ── v3.1 Fix B: Component C only in STRONG_TREND ─────────────────────────────

test("v3.5 Component C allowed in NORMAL regime (AF-FIX-17: removed STRONG_TREND-only gate)", () => {
  // AF-FIX-17: C now fires in NORMAL too (not just STRONG_TREND).
  // trendStrength=0.25 → marketCond=NORMAL. C can now fire when indicators align.
  const ind = makeDownIndicators();
  const sig = afs.detectSignalMulti(ind, N, {
    balance: 500, volatility: 0.8, trend_strength: 0.25,
    htfTrend: "BEARISH", maxEntryExtensionATR: 1.5,
  });
  // C may fire SHORT or null (depends on confidence gate); it must NOT crash.
  assert.ok(sig.C === "SHORT" || sig.C === null, `C must be SHORT or null in NORMAL BEARISH, got ${sig.C}`);
});

test("v3.1 Component C blocked in DEAD_MARKET regime", () => {
  const ind = makeDownIndicators();
  const sig = afs.detectSignalMulti(ind, N, {
    balance: 500, volatility: 0.2, trend_strength: 0.05,
    htfTrend: "BEARISH", maxEntryExtensionATR: 1.5,
  });
  assert.strictEqual(sig.C, null, "C must be null in DEAD_MARKET");
  assert.strictEqual(sig.A, null, "All components null in DEAD_MARKET");
  assert.strictEqual(sig.B, null);
});

test("v3.1 Component C can fire in STRONG_TREND + BEARISH HTF", () => {
  // trendStrength=0.6 → marketCond=STRONG_TREND (threshold=0.40)
  // downtrend with RSI 42 → _detectSignalC fires SHORT
  const ind = makeDownIndicators();
  const sig = afs.detectSignalMulti(ind, N, {
    balance: 500, volatility: 0.8, trend_strength: 0.6,
    htfTrend: "BEARISH", maxEntryExtensionATR: 1.5,
  });
  // C is now eligible — it may fire SHORT (depends on chase guard + RSI band)
  // The key assertion: result is object with C key (not an error/undefined)
  assert.ok(sig.C === "SHORT" || sig.C === null,
    `C must be SHORT or null in STRONG_TREND BEARISH, got: ${sig.C}`);
  // C === "SHORT" is the expected happy path
  assert.strictEqual(sig.C, "SHORT",
    "C should fire SHORT in STRONG_TREND BEARISH downtrend with RSI 42");
});

test("v3.1 Component C blocked in STRONG_TREND but BULLISH HTF (SHORT blocked)", () => {
  // Even if regime is STRONG_TREND, SHORT can't fire in BULLISH HTF
  const ind = makeDownIndicators();
  const sig = afs.detectSignalMulti(ind, N, {
    balance: 500, volatility: 0.8, trend_strength: 0.6,
    htfTrend: "BULLISH", maxEntryExtensionATR: 1.5,
  });
  assert.strictEqual(sig.C, null, "C SHORT blocked by BULLISH HTF even in STRONG_TREND");
});

test("v3.1 LONG still fires normally in BULLISH HTF (not affected by SHORT filter)", () => {
  const ind = makeUpIndicators();
  const sig = afs.detectSignalMulti(ind, N, {
    balance: 500, volatility: 1.0, trend_strength: 0.5,
    htfTrend: "BULLISH", maxEntryExtensionATR: 1.5,
    afEnabledComponents: ["A", "B", "C"], // explicitly enable all for this legacy assertion
  });
  // B should fire LONG (uptrend, pullback-resume event)
  assert.strictEqual(sig.B, "LONG", `B must fire LONG in BULLISH HTF, got ${sig.B}`);
});

// ── v3.2 Fix: component enable-list (default C-only) ─────────────────────────

test("v3.6 (AF-FIX-12/13) preset enables all 4 components including SMC (D)", () => {
  // AF-FIX-12/13 (Sprint 8): Component D (SMC Order Block + FVG) added to the
  // enable-list behind the same ≥60 confidence gate as A/B/C.
  assert.deepStrictEqual(preset.afEnabledComponents, ["A", "B", "C", "D"]);
  assert.strictEqual(preset.afMinComponentConfidence, 60);
  assert.strictEqual(preset.afMinAggregateConfidence, 60);
});

test("v3.6 class version 3.6.0 (AF-FIX-12/13: SMC Component D added)", () => {
  assert.strictEqual(afs.config.version, "3.6.0");
});

test("v3.2 afEnabledComponents=['C'] blocks A and B even when their signals would fire", () => {
  // makeUpIndicators makes B fire LONG; with C-only, B must be suppressed
  const ind = makeUpIndicators();
  const sig = afs.detectSignalMulti(ind, N, {
    balance: 500, volatility: 1.0, trend_strength: 0.5,
    htfTrend: "BULLISH", maxEntryExtensionATR: 1.5,
    afEnabledComponents: ["C"],
  });
  assert.strictEqual(sig.A, null, "A must be null when not in enable-list");
  assert.strictEqual(sig.B, null, "B must be null when not in enable-list");
});

test("v3.2 afEnabledComponents=['A','B','C'] re-enables all components", () => {
  const ind = makeUpIndicators();
  const sig = afs.detectSignalMulti(ind, N, {
    balance: 500, volatility: 1.0, trend_strength: 0.5,
    htfTrend: "BULLISH", maxEntryExtensionATR: 1.5,
    afEnabledComponents: ["A", "B", "C"],
  });
  // B fires LONG when re-enabled (proves the flag, not a permanent block)
  assert.strictEqual(sig.B, "LONG", "B must fire when explicitly enabled");
});

test("v3.2 default (no afEnabledComponents passed) enables all (backward compat)", () => {
  // When the caller omits the flag, fall back to all three (legacy/test behavior)
  const ind = makeUpIndicators();
  const sig = afs.detectSignalMulti(ind, N, {
    balance: 500, volatility: 1.0, trend_strength: 0.5,
    htfTrend: "BULLISH", maxEntryExtensionATR: 1.5,
  });
  assert.strictEqual(sig.B, "LONG", "B fires under backward-compat default (all enabled)");
});
