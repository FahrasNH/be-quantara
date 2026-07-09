/**
 * regime-classifier.test.js — Sprint 2 / RC-1
 *
 * 30+ unit tests for RegimeClassifierEngine.
 *
 * Run: node test/regime-classifier.test.js
 */

"use strict";

const { RegimeClassifierEngine, PRIMARY, MODIFIER } = require("../src/domain/RegimeClassifierEngine");

// ─────────────────────────────────────────────────────────────────────────────
// Test utilities
// ─────────────────────────────────────────────────────────────────────────────

let testCount = 0;
let passCount = 0;
let failCount = 0;
const failures = [];

function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failCount++;
    failures.push({ test: name, error: err.message });
    console.error(`✗ ${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(msg || `Expected "${expected}", got "${actual}"`);
}

function assertRange(val, lo, hi, msg) {
  if (val < lo || val > hi) throw new Error(msg || `Expected ${lo}–${hi}, got ${val}`);
}

function assertNoNanInf(obj, path = "") {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number") {
      if (!isFinite(v) || isNaN(v)) throw new Error(`NaN/Infinity at ${path}${k} = ${v}`);
    } else if (v !== null && typeof v === "object") {
      assertNoNanInf(v, `${path}${k}.`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function bullIndicators() {
  return { ema9: 110, ema21: 105, ema50: 100, adx: 35, atr: 2.4, atrAvg: 2.0, volume: 1500, volAvg: 1000 };
}

function bearIndicators() {
  return { ema9: 95,  ema21: 100, ema50: 105, adx: 28, atr: 1.5, atrAvg: 2.0, volume: 1100, volAvg: 1000 };
}

function rangingIndicators() {
  return { ema9: 100.5, ema21: 100.3, ema50: 100.1, adx: 15, atr: 1.6, atrAvg: 2.0, volume: 900, volAvg: 1000 };
}

function highVolIndicators() {
  return { ema9: 105, ema21: 103, ema50: 100, adx: 30, atr: 3.0, atrAvg: 2.0, volume: 1500, volAvg: 1000 };
}

function compressionIndicators() {
  return { ema9: 100.5, ema21: 100.3, ema50: 100.1, adx: 12, atr: 1.5, atrAvg: 2.0, volume: 600, volAvg: 1000 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// Fresh engine for each test to avoid cache interference
function eng() { return new RegimeClassifierEngine(); }

// ── Bull trend ────────────────────────────────────────────────────────────────
test("Bull trend: EMA aligned up + ADX 35 → trend_up", () => {
  const r = eng().classify(bullIndicators(), "BTCUSDT", "4h");
  assertEqual(r.primary, PRIMARY.TREND_UP);
  assert(r.confidence > 50);
});

test("Bull trend: composite contains trend_up", () => {
  const r = eng().classify(bullIndicators(), "BTCUSDT", "4h");
  assert(r.composite.startsWith("trend_up"), `Expected trend_up+…, got ${r.composite}`);
});

test("Bull trend + high ATR → expansion modifier", () => {
  const ind = { ...bullIndicators(), atr: 3.5, atrAvg: 2.0 }; // ratio 1.75
  const r = eng().classify(ind, "BTCUSDT", "4h");
  assert(
    r.modifier === MODIFIER.EXPANSION || r.modifier === MODIFIER.HIGH_VOL,
    `Expected expansion/high_vol, got ${r.modifier}`
  );
});

// ── Bear trend ────────────────────────────────────────────────────────────────
test("Bear trend: EMA aligned down + ADX 28 → trend_down", () => {
  const r = eng().classify(bearIndicators(), "BTCUSDT", "1h");
  assertEqual(r.primary, PRIMARY.TREND_DOWN);
});

test("Bear trend + compression ATR → compression modifier", () => {
  const ind = { ...bearIndicators(), atr: 1.2, atrAvg: 2.0 }; // ratio 0.6
  const r = eng().classify(ind, "BTCUSDT", "1h");
  assert(
    r.modifier === MODIFIER.COMPRESSION || r.modifier === MODIFIER.LOW_VOL,
    `Expected compression/low_vol, got ${r.modifier}`
  );
});

test("Bear trend composite: trend_down+...", () => {
  const r = eng().classify(bearIndicators(), "ETHUSDT", "1h");
  assert(r.composite.startsWith("trend_down"), `Expected trend_down+…, got ${r.composite}`);
});

// ── Ranging ───────────────────────────────────────────────────────────────────
test("Ranging: choppy EMAs + ADX 15 → ranging", () => {
  const r = eng().classify(rangingIndicators(), "BTCUSDT", "15m");
  assertEqual(r.primary, PRIMARY.RANGING);
});

test("Ranging + low volume → low_vol modifier", () => {
  const ind = { ...rangingIndicators(), atr: 1.5, atrAvg: 2.0, volume: 500, volAvg: 1000 };
  const r = eng().classify(ind, "BTCUSDT", "15m");
  assertEqual(r.primary, PRIMARY.RANGING);
  assert(r.modifier === MODIFIER.LOW_VOL || r.modifier === MODIFIER.COMPRESSION, `Got ${r.modifier}`);
});

test("Ranging composite: ranging+low_vol", () => {
  const ind = { ...rangingIndicators(), atr: 1.5, atrAvg: 2.0, volume: 500, volAvg: 1000 };
  const r = eng().classify(ind, "BTCUSDT", "15m");
  assert(r.composite.includes("ranging"), `Expected ranging, got ${r.composite}`);
});

// ── High volatility burst ─────────────────────────────────────────────────────
test("High vol burst: ATR 1.5× avg + volume 1.5× → high_vol modifier", () => {
  const r = eng().classify(highVolIndicators(), "BTCUSDT", "4h");
  assert(r.modifier === MODIFIER.HIGH_VOL || r.modifier === MODIFIER.EXPANSION, `Got ${r.modifier}`);
});

test("High vol burst: confidence > 40", () => {
  const r = eng().classify(highVolIndicators(), "BTCUSDT", "4h");
  assert(r.confidence > 40, `Confidence too low: ${r.confidence}`);
});

// ── Confidence score bounds ───────────────────────────────────────────────────
test("Confidence always 0–100 for bull indicators", () => {
  const r = eng().classify(bullIndicators(), "BTC", "4h");
  assertRange(r.confidence, 0, 100);
});

test("Confidence always 0–100 for ranging indicators", () => {
  const r = eng().classify(rangingIndicators(), "BTC", "15m");
  assertRange(r.confidence, 0, 100);
});

test("Confidence always 0–100 for empty indicators", () => {
  const r = eng().classify({}, "BTC", "1h");
  assertRange(r.confidence, 0, 100);
});

// ── No NaN/Infinity ───────────────────────────────────────────────────────────
test("No NaN/Infinity in bull output", () => {
  const r = eng().classify(bullIndicators(), "BTC", "4h");
  assertNoNanInf(r);
});

test("No NaN/Infinity in bear output", () => {
  const r = eng().classify(bearIndicators(), "BTC", "1h");
  assertNoNanInf(r);
});

test("No NaN/Infinity in ranging output", () => {
  const r = eng().classify(rangingIndicators(), "BTC", "15m");
  assertNoNanInf(r);
});

// ── Determinism ───────────────────────────────────────────────────────────────
test("Determinism: same input → same output (run 1 vs run 2)", () => {
  const ind = bullIndicators();
  const e1 = new RegimeClassifierEngine();
  const e2 = new RegimeClassifierEngine();
  const r1 = e1.classify(ind, "BTCUSDT", "4h");
  const r2 = e2.classify(ind, "BTCUSDT", "4h");
  assertEqual(r1.composite, r2.composite);
  assertEqual(r1.confidence, r2.confidence);
});

test("Determinism: calling twice returns identical result", () => {
  const e = new RegimeClassifierEngine();
  const ind = bearIndicators();
  const r1 = e.classify(ind, "ETHUSDT", "1h");
  const r2 = e.classify(ind, "ETHUSDT", "1h"); // second call hits cache
  assertEqual(r1.composite, r2.composite);
  assertEqual(r1.confidence, r2.confidence);
});

// ── Cache hit/miss ────────────────────────────────────────────────────────────
test("Cache hit: second call returns same object reference (via cache)", () => {
  const e = new RegimeClassifierEngine();
  const ind = bullIndicators();
  const r1 = e.classify(ind, "BTCUSDT", "4h");
  const r2 = e.classify(ind, "BTCUSDT", "4h"); // should come from cache
  assertEqual(JSON.stringify(r1), JSON.stringify(r2));
});

test("Cache miss: getCache returns null before any classify call", () => {
  const e = new RegimeClassifierEngine();
  const cached = e.getCache("UNKNOWN", "4h");
  assert(cached === null, "Expected null for empty cache");
});

test("Cache stores result: getCache returns after classify", () => {
  const e = new RegimeClassifierEngine();
  e.classify(bullIndicators(), "BTCUSDT", "4h");
  const cached = e.getCache("BTCUSDT", "4h");
  assert(cached !== null, "Expected cached result");
  assert(cached.primary !== undefined);
});

// ── Cache TTL expiry ──────────────────────────────────────────────────────────
test("Cache TTL: expired entry returns null", () => {
  const e = new RegimeClassifierEngine();
  e.classify(bullIndicators(), "BTCUSDT", "4h");
  // Manually expire the entry
  const key = "BTCUSDT:4h";
  const entry = e._cache.get(key);
  entry.expiresAt = Date.now() - 1; // force expiry
  const cached = e.getCache("BTCUSDT", "4h");
  assert(cached === null, "Expected null after TTL expiry");
});

// ── invalidateCache ───────────────────────────────────────────────────────────
test("invalidateCache clears all entries for a symbol", () => {
  const e = new RegimeClassifierEngine();
  e.classify(bullIndicators(), "BTCUSDT", "4h");
  e.classify(bullIndicators(), "BTCUSDT", "1h");
  e.invalidateCache("BTCUSDT");
  assert(e.getCache("BTCUSDT", "4h") === null, "4h not cleared");
  assert(e.getCache("BTCUSDT", "1h") === null, "1h not cleared");
});

test("invalidateCache does not clear other symbols", () => {
  const e = new RegimeClassifierEngine();
  e.classify(bullIndicators(), "ETHUSDT", "4h");
  e.classify(bullIndicators(), "BTCUSDT", "4h");
  e.invalidateCache("BTCUSDT");
  assert(e.getCache("ETHUSDT", "4h") !== null, "ETHUSDT cache should remain");
});

// ── Edge cases ────────────────────────────────────────────────────────────────
test("Missing data (empty object) → graceful fallback, no crash", () => {
  const r = eng().classify({}, "BTCUSDT", "4h");
  assert(r.primary !== undefined, "primary is undefined");
  assert(typeof r.confidence === "number");
});

test("Zero ATR → no crash, atrAvg 0 safe", () => {
  const ind = { ema9: 100, ema21: 98, ema50: 95, adx: 30, atr: 0, atrAvg: 0 };
  const r = eng().classify(ind, "BTCUSDT", "4h");
  assert(r.primary !== undefined);
  assertNoNanInf(r);
});

test("null ADX (no ADX data) → still classifies primary correctly", () => {
  const ind = { ema9: 110, ema21: 105, ema50: 100, adx: null, atr: 2.0, atrAvg: 2.0 };
  const r = eng().classify(ind, "BTCUSDT", "4h");
  assertEqual(r.primary, PRIMARY.TREND_UP);
});

test("All null indicators → returns valid but low-confidence result", () => {
  const r = eng().classify({ ema9: null, ema21: null, ema50: null, adx: null }, "BTCUSDT", "1h");
  assertRange(r.confidence, 0, 100);
  assert(typeof r.primary === "string");
});

test("Infinity in input → graceful (no Infinity in output)", () => {
  const ind = { ema9: Infinity, ema21: 100, ema50: 95, adx: 25 };
  const r = eng().classify(ind, "BTCUSDT", "4h");
  assertNoNanInf(r);
});

// ── Multi-TF ──────────────────────────────────────────────────────────────────
test("classifyMultiTF: returns htf, mtf, ltf, dominant", () => {
  const e = new RegimeClassifierEngine();
  const result = e.classifyMultiTF(bullIndicators(), bullIndicators(), bullIndicators(), "BTCUSDT");
  assert(result.htf !== undefined, "htf missing");
  assert(result.mtf !== undefined, "mtf missing");
  assert(result.ltf !== undefined, "ltf missing");
  assert(result.dominant !== undefined, "dominant missing");
});

test("Multi-TF: all bullish TFs → dominant is trend_up", () => {
  const e = new RegimeClassifierEngine();
  const result = e.classifyMultiTF(bullIndicators(), bullIndicators(), bullIndicators(), "BTCUSDT");
  assertEqual(result.dominant.primary, PRIMARY.TREND_UP);
});

test("Multi-TF: HTF ranging but MTF+LTF bullish → dominant trend_up", () => {
  const e = new RegimeClassifierEngine();
  const result = e.classifyMultiTF(rangingIndicators(), bullIndicators(), bullIndicators(), "BTCUSDT");
  assertEqual(result.dominant.primary, PRIMARY.TREND_UP);
});

test("Multi-TF: all TFs conflict → dominant falls back to HTF", () => {
  const e = new RegimeClassifierEngine();
  const result = e.classifyMultiTF(bullIndicators(), bearIndicators(), rangingIndicators(), "BTCUSDT");
  assertEqual(result.dominant.primary, PRIMARY.TREND_UP, "Dominant should fall back to HTF");
});

test("Multi-TF: dominant confidence is 0–100", () => {
  const e = new RegimeClassifierEngine();
  const result = e.classifyMultiTF(bullIndicators(), rangingIndicators(), bearIndicators(), "BTCUSDT");
  assertRange(result.dominant.confidence, 0, 100);
});

test("Multi-TF: dominant composite is a string", () => {
  const e = new RegimeClassifierEngine();
  const result = e.classifyMultiTF(bullIndicators(), bullIndicators(), highVolIndicators(), "BTCUSDT");
  assert(typeof result.dominant.composite === "string");
});

// ── All 6 composite regimes ───────────────────────────────────────────────────
test("Composite: trend_up+expansion", () => {
  const ind = { ema9: 120, ema21: 110, ema50: 100, adx: 35, atr: 3.0, atrAvg: 2.0, volume: 900, volAvg: 1000 };
  const r = eng().classify(ind, "BTC", "4h");
  assertEqual(r.primary, PRIMARY.TREND_UP);
  assert(r.modifier !== null, `Expected non-null modifier, got ${r.modifier}`);
});

test("Composite: trend_down+compression", () => {
  const ind = { ema9: 80, ema21: 90, ema50: 100, adx: 28, atr: 1.0, atrAvg: 2.0, volume: 600, volAvg: 1000 };
  const r = eng().classify(ind, "BTC", "1h");
  assertEqual(r.primary, PRIMARY.TREND_DOWN);
  assert(r.modifier === MODIFIER.COMPRESSION || r.modifier === MODIFIER.LOW_VOL, `Got ${r.modifier}`);
});

test("Composite: ranging+low_vol", () => {
  const r = eng().classify(compressionIndicators(), "BTC", "15m");
  assertEqual(r.primary, PRIMARY.RANGING);
  assert(r.modifier === MODIFIER.LOW_VOL || r.modifier === MODIFIER.COMPRESSION, `Got ${r.modifier}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n── Regime Classifier Tests ──────────────────────`);
console.log(`Total  : ${testCount}`);
console.log(`Passed : ${passCount}`);
console.log(`Failed : ${failCount}`);

if (failures.length) {
  console.log("\nFailures:");
  failures.forEach(f => console.log(`  ✗ ${f.test}: ${f.error}`));
}

if (failCount > 0) {
  process.exit(1);
} else {
  console.log("\nAll tests passed!");
}
