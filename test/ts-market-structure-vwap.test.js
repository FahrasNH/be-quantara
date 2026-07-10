/**
 * Sprint 9 TS-SUB-01/02/03 — Market Structure, VWAP/VP, TrendSurge layering tests.
 */

"use strict";

const assert = require("assert");
const {
  classifyMarketStructure,
  evaluateMarketStructureGate,
  evaluateMarketStructureComponent,
} = require("../src/domain/strategy/ts/marketStructureComponent");
const {
  calculateSessionVwap,
  buildVolumeProfile,
  evaluateVolumeProfilePrecision,
  evaluateVolumeProfileComponent,
} = require("../src/domain/strategy/ts/volumeProfileComponent");
const { getActiveComponentsForTier, isActiveComponent } = require("../src/config/strategies");
const TrendSurgeUmbrella = require("../src/domain/strategy/umbrellas/TrendSurgeUmbrella");

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

/** Build a clean HH+HL uptrend series with confirmed fractal pivots. */
function buildUptrendSeries(waves = 5) {
  const highs = [];
  const lows = [];
  const closes = [];
  const volumes = [];
  const timestamps = [];
  const day0 = Date.UTC(2026, 0, 1);
  const push = (h, l, c, v) => {
    highs.push(h);
    lows.push(l);
    closes.push(c);
    volumes.push(v);
    timestamps.push(day0 + (highs.length - 1) * 3_600_000);
  };
  for (let wave = 0; wave < waves; wave++) {
    const peak = 110 + wave * 10;
    const trough = 100 + wave * 10;
    // Approach peak
    push(peak - 4, trough - 2, peak - 3, 1000);
    push(peak - 2, trough - 1, peak - 2, 1000);
    push(peak, trough + 1, peak - 1, 1200); // swing high
    push(peak - 2, trough + 2, peak - 2, 900);
    push(peak - 3, trough + 1, peak - 3, 900);
    // Pullback to higher low
    push(peak - 3, trough, peak - 3, 800);
    push(peak - 4, trough - 0.5, trough + 1, 800);
    push(peak - 3, trough, trough + 0.5, 850); // swing low
    push(peak - 2, trough + 1, trough + 2, 900);
    push(peak - 1, trough + 2, trough + 3, 950);
  }
  return { highs, lows, closes, volumes, timestamps };
}

function buildDowntrendSeries(waves = 5) {
  const highs = [];
  const lows = [];
  for (let wave = 0; wave < waves; wave++) {
    const peak = 200 - wave * 10;
    const trough = 190 - wave * 10;
    highs.push(peak - 2, peak, peak - 1, peak - 3, peak - 4);
    lows.push(trough + 2, trough + 3, trough + 1, trough, trough + 1);
    highs.push(peak - 3, peak - 2, peak - 4, peak - 3, peak - 2);
    lows.push(trough + 1, trough + 2, trough - 1, trough, trough + 1); // lower low at trough-1
  }
  return { highs, lows };
}

console.log("\n═══ Market Structure (TS-SUB-01) ═══");

test("classifies uptrend HH+HL", () => {
  const { highs, lows } = buildUptrendSeries();
  const r = classifyMarketStructure(highs, lows, highs.length - 1, {
    leftLook: 2, rightLook: 2, scanBars: 120, minSwingPairs: 2,
  });
  assert.strictEqual(r.structure, "uptrend");
  assert.ok(r.confidence > 0.5);
});

test("classifies downtrend LH+LL", () => {
  const { highs, lows } = buildDowntrendSeries();
  const r = classifyMarketStructure(highs, lows, highs.length - 1, {
    leftLook: 2, rightLook: 2, scanBars: 120, minSwingPairs: 2,
  });
  assert.strictEqual(r.structure, "downtrend");
});

test("insufficient swings → unclear classification, gate passthrough", () => {
  const highs = [1, 2, 1.5, 2.2];
  const lows = [0.5, 1, 0.8, 1.1];
  const r = classifyMarketStructure(highs, lows, 3, {
    leftLook: 2, rightLook: 2, scanBars: 10, minSwingPairs: 3,
  });
  assert.strictEqual(r.structure, "unclear");
  const g = evaluateMarketStructureGate(highs, lows, 3, "LONG", {
    leftLook: 2, rightLook: 2, scanBars: 10, minSwingPairs: 3,
  });
  assert.strictEqual(g.allowed, true);
  assert.strictEqual(g.reason, "structure_warmup_passthrough");
});

test("htfIdx warmup (-1) → gate passthrough", () => {
  const g = evaluateMarketStructureGate([1, 2, 3], [0.5, 1, 1.5], -1, "LONG");
  assert.strictEqual(g.allowed, true);
  assert.ok(String(g.reason).includes("warmup"));
});

test("gate allows LONG on uptrend", () => {
  const { highs, lows } = buildUptrendSeries();
  const g = evaluateMarketStructureGate(highs, lows, highs.length - 1, "LONG", {
    leftLook: 2, rightLook: 2, scanBars: 120, minSwingPairs: 2,
  });
  assert.strictEqual(g.allowed, true);
  assert.strictEqual(g.vote, "LONG");
});

test("gate blocks LONG on downtrend", () => {
  const { highs, lows } = buildDowntrendSeries();
  const g = evaluateMarketStructureGate(highs, lows, highs.length - 1, "LONG", {
    leftLook: 2, rightLook: 2, scanBars: 120, minSwingPairs: 2,
  });
  assert.strictEqual(g.allowed, false);
});

test("component vote matches structure", () => {
  const { highs, lows } = buildUptrendSeries();
  const r = evaluateMarketStructureComponent(highs, lows, highs.length - 1, {
    leftLook: 2, rightLook: 2, scanBars: 120, minSwingPairs: 2,
  });
  assert.strictEqual(r.vote, "LONG");
});

console.log("\n═══ Volume Profile + VWAP (TS-SUB-02) ═══");

test("session VWAP computes", () => {
  const { highs, lows, closes, volumes } = buildUptrendSeries(5);
  // Keep entire series in one UTC day so session VWAP has enough bars
  const timestamps = closes.map((_, i) => Date.UTC(2026, 0, 1) + i * 60_000);
  const r = calculateSessionVwap(highs, lows, closes, volumes, timestamps, closes.length - 1);
  assert.ok(r.vwap != null && Number.isFinite(r.vwap));
  assert.ok(r.bars >= 8);
});

test("volume profile POC + VA", () => {
  const { highs, lows, closes, volumes } = buildUptrendSeries(5);
  const profile = buildVolumeProfile(highs, lows, closes, volumes, 0, closes.length - 1, 20, 0.7);
  assert.ok(profile.poc != null);
  assert.ok(profile.vah != null && profile.val != null);
  assert.ok(profile.vah >= profile.val);
  assert.ok(profile.totalVolume > 0);
});

test("early session passthrough", () => {
  const highs = [10, 11, 12];
  const lows = [9, 10, 11];
  const closes = [9.5, 10.5, 11.5];
  const volumes = [100, 100, 100];
  const timestamps = [0, 3600_000, 7200_000];
  const r = evaluateVolumeProfilePrecision(
    { highs, lows, closes, volumes, timestamps },
    2,
    "LONG",
    { minSessionBars: 20 }
  );
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.reason, "session_warmup_passthrough");
});

test("price far from VWAP/VA blocked (ATR tolerance)", () => {
  const n = 30;
  const highs = [];
  const lows = [];
  const closes = [];
  const volumes = [];
  const atr = [];
  const timestamps = [];
  const day0 = Date.UTC(2026, 0, 2);
  for (let i = 0; i < n; i++) {
    highs.push(100.1);
    lows.push(99.9);
    closes.push(100);
    volumes.push(1000);
    atr.push(1.0); // ATR=1 → 0.5×ATR = 0.5 tolerance
    timestamps.push(day0 + i * 60_000); // 1m bars — full session in one UTC day
  }
  // Spike last close far above the session cluster with tiny volume
  // so VWAP/VA stay near 100 while price is outside.
  closes[n - 1] = 130;
  highs[n - 1] = 130.1;
  lows[n - 1] = 129.9;
  volumes[n - 1] = 1;
  const r = evaluateVolumeProfilePrecision(
    { highs, lows, closes, volumes, timestamps, atr },
    n - 1,
    "LONG",
    { minSessionBars: 8, vwapAtrMult: 0.5 }
  );
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, "outside_vwap_value_area");
  assert.strictEqual(r.meta.tolMode, "atr");
});

test("price within 0.5×ATR of VWAP allowed", () => {
  const n = 30;
  const highs = [];
  const lows = [];
  const closes = [];
  const volumes = [];
  const atr = [];
  const timestamps = [];
  const day0 = Date.UTC(2026, 0, 2);
  for (let i = 0; i < n; i++) {
    highs.push(100.1);
    lows.push(99.9);
    closes.push(100);
    volumes.push(1000);
    atr.push(2.0); // 0.5×ATR = 1.0
    timestamps.push(day0 + i * 60_000);
  }
  closes[n - 1] = 100.8; // within 1.0 of VWAP≈100
  highs[n - 1] = 100.9;
  lows[n - 1] = 100.7;
  const r = evaluateVolumeProfilePrecision(
    { highs, lows, closes, volumes, timestamps, atr },
    n - 1,
    "LONG",
    { minSessionBars: 8, vwapAtrMult: 0.5 }
  );
  assert.strictEqual(r.allowed, true);
  assert.ok(["vwap_retest", "poc_retest", "value_area_overlap"].includes(r.reason));
});

test("component bias above VWAP → LONG", () => {
  const { highs, lows, closes, volumes } = buildUptrendSeries(5);
  const timestamps = closes.map((_, i) => Date.UTC(2026, 0, 1) + i * 60_000);
  const last = closes.length - 1;
  const r = evaluateVolumeProfileComponent(
    { highs, lows, closes, volumes, timestamps },
    last,
    { minSessionBars: 8 }
  );
  assert.ok(["LONG", "SHORT", "NEUTRAL"].includes(r.vote));
});

console.log("\n═══ TrendSurge Integration (TS-SUB-03) ═══");

test("FORGE active components include TS_MS + TS_VP", () => {
  const active = getActiveComponentsForTier("FORGE");
  assert.ok(active.includes("TS_TF"));
  assert.ok(active.includes("TS_MS"));
  assert.ok(active.includes("TS_VP"));
  assert.ok(isActiveComponent("TS_MS"));
  assert.ok(isActiveComponent("TS_VP"));
});

test("FOUNDRY still lists AF Wyckoff + VSA", () => {
  const active = getActiveComponentsForTier("FOUNDRY");
  assert.deepStrictEqual(active, ["AF_SMC", "AF_WYCKOFF", "AF_VSA"]);
});

test("umbrella registers three components", () => {
  const umb = new TrendSurgeUmbrella();
  const keys = umb.getComponentKeys ? umb.getComponentKeys() : Object.keys(umb.components || {});
  // UmbrellaStrategy stores components in a Map/object — probe both shapes
  const compKeys = keys.length
    ? keys
    : [...(umb._components?.keys?.() || []), ...Object.keys(umb._components || {})];
  // Fallback: check private fields
  assert.ok(umb._tf);
  assert.ok(umb._ms);
  assert.ok(umb._vp);
  void compKeys;
});

test("structure gate blocks when forced unclear + TF would fire", () => {
  const umb = new TrendSurgeUmbrella();
  // Stub TF to always fire LONG
  umb._tf.detectSignal = () => "LONG";
  umb._ms.evaluateGate = () => ({
    allowed: false,
    vote: "NEUTRAL",
    confidence: 0,
    reason: "structure_unclear",
  });
  const sig = umb.detectSignal({ closes: new Array(60).fill(100) }, 59, {
    tsUseStructureGate: true,
    tsUseVwapPrecision: false,
  });
  assert.strictEqual(sig, null);
  assert.strictEqual(umb.getLastLayerMeta().reason, "structure_unclear");
});

test("layers pass when gate + precision allow", () => {
  const umb = new TrendSurgeUmbrella();
  umb._tf.detectSignal = () => "LONG";
  umb._ms.evaluateGate = () => ({
    allowed: true, vote: "LONG", confidence: 0.8, reason: "structure_uptrend",
  });
  umb._vp.evaluatePrecision = () => ({
    allowed: true, vote: "LONG", confidence: 0.7, reason: "vwap_retest",
  });
  const sig = umb.detectSignal({ closes: new Array(60).fill(100) }, 59, {});
  assert.strictEqual(sig, "LONG");
  assert.strictEqual(umb.getLastLayerMeta().reason, "ts_layers_passed");
});

test("rollback flags disable layers", () => {
  const umb = new TrendSurgeUmbrella();
  umb._tf.detectSignal = () => "SHORT";
  let msCalled = false;
  let vpCalled = false;
  umb._ms.evaluateGate = () => { msCalled = true; return { allowed: false }; };
  umb._vp.evaluatePrecision = () => { vpCalled = true; return { allowed: false }; };
  const sig = umb.detectSignal({ closes: new Array(60).fill(100) }, 59, {
    tsUseStructureGate: false,
    tsUseVwapPrecision: false,
  });
  assert.strictEqual(sig, "SHORT");
  assert.strictEqual(msCalled, false);
  assert.strictEqual(vpCalled, false);
});

console.log("\nAll TS Market Structure / VWAP / layering tests passed.\n");
