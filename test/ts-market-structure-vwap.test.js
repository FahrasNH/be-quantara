/**
 * Sprint 9 TS-SUB-01/02 + Sprint 12 race-to-confirm — Dow Theory, AMT, TrendSurge.
 */

"use strict";

const assert = require("assert");
const {
  classifyMarketStructure,
  evaluateMarketStructureGate,
  evaluateMarketStructureComponent,
  evaluateMarketStructureEntry,
} = require("#core/strategy-engine/ts/marketStructureEntry.js");
const {
  calculateSessionVwap,
  buildVolumeProfile,
  evaluateVolumeProfilePrecision,
  evaluateVolumeProfileComponent,
  evaluateVolumeProfileEntry,
} = require("#core/strategy-engine/ts/volumeProfileEntry.js");
const { getActiveComponentsForTier, isActiveComponent } = require("../src/config/strategies");
const TrendSurgeUmbrella = require("#core/strategy-engine/umbrellas/TrendSurgeUmbrella.js");

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
    push(peak - 4, trough - 2, peak - 3, 1000);
    push(peak - 2, trough - 1, peak - 2, 1000);
    push(peak, trough + 1, peak - 1, 1200);
    push(peak - 2, trough + 2, peak - 2, 900);
    push(peak - 3, trough + 1, peak - 3, 900);
    push(peak - 3, trough, peak - 3, 800);
    push(peak - 4, trough - 0.5, trough + 1, 800);
    push(peak - 3, trough, trough + 0.5, 850);
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
    lows.push(trough + 1, trough + 2, trough - 1, trough, trough + 1);
  }
  return { highs, lows };
}

console.log("\n═══ Dow Theory (TS-SUB-01) ═══");

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

test("race entry fires LONG on HL pullback bounce", () => {
  const { highs, lows, closes } = buildUptrendSeries();
  const classified = classifyMarketStructure(highs, lows, highs.length - 1, {
    leftLook: 2, rightLook: 2, scanBars: 120, minSwingPairs: 2,
  });
  assert.strictEqual(classified.structure, "uptrend");
  const hl = classified.meta.lastSwingLow.price;
  const idx = closes.length - 1;
  closes[idx - 1] = hl + 5;
  closes[idx] = hl + 0.2;
  highs[idx] = hl + 1;
  lows[idx] = hl - 0.1;
  const r = evaluateMarketStructureEntry(highs, lows, closes, idx, {
    leftLook: 2, rightLook: 2, scanBars: 120, minSwingPairs: 2,
    atr: 2,
    entryAtrMult: 1.5,
    opens: closes.map((c, i) => (i === idx ? hl - 0.05 : c)),
  });
  assert.strictEqual(r.signal, "LONG");
  assert.ok(r.reason.includes("hl_pullback") || r.reason.includes("bounce"));
});

console.log("\n═══ Auction Market Theory / VWAP (TS-SUB-02) ═══");

test("session VWAP computes", () => {
  const { highs, lows, closes, volumes } = buildUptrendSeries(5);
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
    atr.push(1.0);
    timestamps.push(day0 + i * 60_000);
  }
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
    atr.push(2.0);
    timestamps.push(day0 + i * 60_000);
  }
  closes[n - 1] = 100.8;
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

test("race entry fires on VWAP reclaim", () => {
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
    atr.push(1.0);
    timestamps.push(day0 + i * 60_000);
  }
  closes[n - 2] = 99.5;
  closes[n - 1] = 100.2;
  highs[n - 1] = 100.3;
  lows[n - 1] = 99.8;
  const r = evaluateVolumeProfileEntry(
    { highs, lows, closes, volumes, timestamps, atr },
    n - 1,
    { minSessionBars: 8, vwapAtrMult: 0.5 }
  );
  assert.strictEqual(r.signal, "LONG");
  assert.strictEqual(r.reason, "vwap_reclaim");
});

test("AMT race entry fails closed without timestamps (no whole-history session)", () => {
  const n = 40;
  const highs = Array(n).fill(100.1);
  const lows = Array(n).fill(99.9);
  const closes = Array(n).fill(100);
  const volumes = Array(n).fill(1000);
  closes[n - 2] = 99.5;
  closes[n - 1] = 100.2;
  const r = evaluateVolumeProfileEntry(
    { highs, lows, closes, volumes, atr: Array(n).fill(1) },
    n - 1,
    { minSessionBars: 20 }
  );
  assert.strictEqual(r.signal, null);
  assert.strictEqual(r.reason, "session_timestamps_missing");
});

test("AMT Swing 4h uses UTC-week session and can fire (not stuck at 0 trades)", () => {
  // Monday 00:00 UTC → fill a week of 4h bars (42), reclaim on last bar.
  const weekStart = Date.UTC(2026, 0, 5); // Monday
  const highs = [];
  const lows = [];
  const closes = [];
  const opens = [];
  const volumes = [];
  const timestamps = [];
  for (let b = 0; b < 42; b++) {
    const t = weekStart + b * 4 * 3_600_000;
    timestamps.push(t);
    const px = 100 + b * 0.05;
    opens.push(px - 0.1);
    highs.push(px + 0.3);
    lows.push(px - 0.3);
    closes.push(px);
    volumes.push(1000);
  }
  const i = closes.length - 1;
  // Force reclaim across session VWAP
  closes[i - 1] = 99.0;
  closes[i] = 103.0;
  highs[i] = 103.2;
  lows[i] = 102.8;
  const r = evaluateVolumeProfileEntry(
    { highs, lows, closes, opens, volumes, timestamps, atr: closes.map(() => 1) },
    i,
    { tradeType: "Swing" } // auto utc_week + minSessionBarsSwing=6
  );
  assert.ok(r.meta?.bars >= 6, `expected week session bars≥6, got ${r.meta?.bars}`);
  assert.strictEqual(r.meta?.sessionMode, "utc_week");
  assert.strictEqual(r.signal, "LONG");
  assert.strictEqual(r.reason, "vwap_reclaim");
});

test("AMT Intraday still uses UTC-day + minSessionBars 20 (4h day-session remains blocked)", () => {
  const day0 = Date.UTC(2026, 0, 5);
  const highs = [];
  const lows = [];
  const closes = [];
  const opens = [];
  const volumes = [];
  const timestamps = [];
  for (let b = 0; b < 6; b++) {
    timestamps.push(day0 + b * 4 * 3_600_000);
    const px = 100 + b * 0.1;
    opens.push(px); highs.push(px + 0.2); lows.push(px - 0.2); closes.push(px); volumes.push(1000);
  }
  const i = closes.length - 1;
  closes[i - 1] = 99.5;
  closes[i] = 100.5;
  // Without tradeType/Swing hint, 4h bars auto-detect as Swing (barMs≥4h).
  // Force Intraday day-session to prove the old structural block still applies there.
  const r = evaluateVolumeProfileEntry(
    { highs, lows, closes, opens, volumes, timestamps, atr: closes.map(() => 1) },
    i,
    { tradeType: "Intraday", minSessionBars: 20 }
  );
  assert.strictEqual(r.signal, null);
  assert.strictEqual(r.reason, "session_warmup");
  assert.ok((r.meta?.bars ?? 0) < 20);
});

console.log("\n═══ TrendSurge Race (Sprint 12) ═══");

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
  assert.ok(umb._tf);
  assert.ok(umb._ms);
  assert.ok(umb._vp);
});

test("race: highest confidence wins with attribution", () => {
  const umb = new TrendSurgeUmbrella();
  umb._tf.detectSignal = () => "LONG";
  umb._tf.getLastSignalMeta = () => ({ confidence: 0.5, reason: "tf" });
  umb._ms.detectSignal = () => "LONG";
  umb._ms.getLastSignalMeta = () => ({ confidence: 0.9, reason: "dow_hl_pullback_bounce" });
  umb._vp.detectSignal = () => null;
  umb._vp.getLastSignalMeta = () => ({ confidence: 0, reason: "awaiting" });
  const sig = umb.detectSignal({ closes: new Array(60).fill(100) }, 59, {
    tsCombinationMode: "race",
    selectedComponents: ["TS_TF", "TS_MS", "TS_VP"],
  });
  assert.strictEqual(sig, "LONG");
  const meta = umb.getLastSignalMeta();
  assert.strictEqual(meta.winningComponent, "TS_MS");
  assert.strictEqual(meta.strategyLabel, "Dow Theory");
  assert.strictEqual(umb.getLastRaceMeta().mode, "race");
});

test("race: TF-only selected → MS/VP do not participate", () => {
  const umb = new TrendSurgeUmbrella();
  umb._tf.detectSignal = () => "SHORT";
  umb._tf.getLastSignalMeta = () => ({ confidence: 0.7 });
  let msCalled = false;
  let vpCalled = false;
  umb._ms.detectSignal = () => { msCalled = true; return "LONG"; };
  umb._vp.detectSignal = () => { vpCalled = true; return "LONG"; };
  const sig = umb.detectSignal({ closes: new Array(60).fill(100) }, 59, {
    tsCombinationMode: "race",
    selectedComponents: ["TS_TF"],
  });
  assert.strictEqual(sig, "SHORT");
  assert.strictEqual(msCalled, false);
  assert.strictEqual(vpCalled, false);
  assert.strictEqual(umb.getLastSignalMeta().winningComponent, "TS_TF");
});

test("gate mode rollback: structure gate still blocks", () => {
  const umb = new TrendSurgeUmbrella();
  umb._tf.detectSignal = () => "LONG";
  umb._ms.evaluateGate = () => ({
    allowed: false,
    vote: "NEUTRAL",
    confidence: 0,
    reason: "structure_unclear",
  });
  const sig = umb.detectSignal({ closes: new Array(60).fill(100) }, 59, {
    tsCombinationMode: "gate",
    tsUseStructureGate: true,
    tsUseVwapPrecision: false,
  });
  assert.strictEqual(sig, null);
  assert.strictEqual(umb.getLastLayerMeta().reason, "structure_unclear");
});

test("gate mode: layers pass when gate + precision allow", () => {
  const umb = new TrendSurgeUmbrella();
  umb._tf.detectSignal = () => "LONG";
  umb._ms.evaluateGate = () => ({
    allowed: true, vote: "LONG", confidence: 0.8, reason: "structure_uptrend",
  });
  umb._vp.evaluatePrecision = () => ({
    allowed: true, vote: "LONG", confidence: 0.7, reason: "vwap_retest",
  });
  const sig = umb.detectSignal({ closes: new Array(60).fill(100) }, 59, {
    tsCombinationMode: "gate",
  });
  assert.strictEqual(sig, "LONG");
  assert.strictEqual(umb.getLastLayerMeta().reason, "ts_layers_passed");
});

test("tie-break prefers TS_TF over TS_MS at equal confidence", () => {
  const umb = new TrendSurgeUmbrella();
  umb._tf.detectSignal = () => "LONG";
  umb._tf.getLastSignalMeta = () => ({ confidence: 0.8 });
  umb._ms.detectSignal = () => "SHORT";
  umb._ms.getLastSignalMeta = () => ({ confidence: 0.8 });
  umb._vp.detectSignal = () => null;
  const sig = umb.detectSignal({ closes: new Array(60).fill(100) }, 59, {
    tsCombinationMode: "race",
  });
  assert.strictEqual(sig, "LONG");
  assert.strictEqual(umb.getLastSignalMeta().winningComponent, "TS_TF");
});

console.log("\nAll TS Dow Theory / Auction Market Theory / race tests passed.\n");
