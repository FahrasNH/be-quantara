/**
 * trendFollowingRsiGate.test.js — RSI gate ablation helpers + entry checklist
 */

const { describe, test, expect, run } = require("./helpers/jest-lite");
const {
  DEFAULTS,
  RSI_VARIANT_PRESETS,
  resolveRsiVariant,
  passesRsiGate,
  rsiGateRejectReason,
  checkLongEntry,
  checkShortEntry,
  evaluateTrendFollowingEntry,
} = require("#core/strategy-engine/ts/trendFollowingEntry.js");

describe("RSI gate ablation", () => {
  test("resolveRsiVariant maps A/B/C presets", () => {
    expect(resolveRsiVariant("a").rsiGateEnabled).toBe(true);
    expect(resolveRsiVariant("a").rsiOversold).toBe(30);
    expect(resolveRsiVariant("b").rsiGateEnabled).toBe(false);
    expect(resolveRsiVariant("c").rsiOversold).toBe(20);
    expect(resolveRsiVariant("c").rsiOverbought).toBe(80);
    expect(resolveRsiVariant("x")).toBeNull();
  });

  test("passesRsiGate — baseline rejects extremes", () => {
    expect(passesRsiGate(50, DEFAULTS)).toBe(true);
    expect(passesRsiGate(75, DEFAULTS)).toBe(false);
    expect(passesRsiGate(null, DEFAULTS)).toBe(true);
  });

  test("rsiGateRejectReason — null RSI does not reject when gate ON", () => {
    expect(rsiGateRejectReason(null, DEFAULTS)).toBeNull();
    expect(rsiGateRejectReason(75, DEFAULTS)).toContain("outside");
  });

  test("passesRsiGate — gate OFF accepts any RSI including null", () => {
    const cfg = { ...DEFAULTS, rsiGateEnabled: false };
    expect(passesRsiGate(85, cfg)).toBe(true);
    expect(passesRsiGate(null, cfg)).toBe(true);
  });

  test("passesRsiGate — wide band 20-80", () => {
    const cfg = resolveRsiVariant("c");
    expect(passesRsiGate(75, cfg)).toBe(true);
    expect(passesRsiGate(15, cfg)).toBe(false);
  });

  test("checkLongEntry uses config RSI bounds", () => {
    const baseArgs = [
      [102], [1000], 101, 100, 75,
      1200, 800,
      "LONG", true, 105,
      null, null, null,
    ];
    expect(checkLongEntry(...baseArgs, DEFAULTS).valid).toBe(false);
    expect(rsiGateRejectReason(75, DEFAULTS)).toContain("outside");

    const off = { ...DEFAULTS, rsiGateEnabled: false };
    expect(checkLongEntry(...baseArgs, off).valid).toBe(true);
  });

  test("checkShortEntry rejects RSI above band", () => {
    const args = [
      [98], [1000], 99, 100, 72,
      1200, 800,
      "SHORT", true, 95,
      null, null, null,
    ];
    expect(checkShortEntry(...args, DEFAULTS).valid).toBe(false);
    const wide = resolveRsiVariant("c");
    expect(checkShortEntry(...args, wide).valid).toBe(true);
  });

  test("checkLongEntry proceeds without entry EMAs when other layers pass", () => {
    const args = [
      [102], [1000], null, null, null,
      1200, 800,
      "LONG", true, 105,
      null, null, null,
    ];
    expect(checkLongEntry(...args, DEFAULTS).valid).toBe(true);
  });

  test("checkLongEntry still enforces EMA pullback when EMAs present", () => {
    const args = [
      [98], [1000], 101, 100, 50,
      1200, 800,
      "LONG", true, 105,
      null, null, null,
    ];
    expect(checkLongEntry(...args, DEFAULTS).valid).toBe(false);
  });

  test("checkLongEntry rejects out-of-band RSI when available", () => {
    const args = [
      [102], [1000], null, null, 75,
      1200, 800,
      "LONG", true, 105,
      null, null, null,
    ];
    expect(checkLongEntry(...args, DEFAULTS).valid).toBe(false);
    expect(checkLongEntry(...args, { ...DEFAULTS, rsiGateEnabled: false }).valid).toBe(true);
  });
});

function buildLongEntryIndicators({ withEntryEma = true, withRsi = true } = {}) {
  const len = 60;
  const closes = Array.from({ length: len }, (_, i) => 100 + i * 0.5);
  const last = len - 1;
  closes[last] = 135;

  const highs = closes.map((c) => c + 1);
  const lows = closes.map((c) => c - 1);
  const volumes = Array.from({ length: len }, () => 1000);
  volumes[last] = 2000;

  const indicators = {
    closes,
    highs,
    lows,
    volumes,
    atr: Array.from({ length: len }, () => 2),
    volSMA: Array.from({ length: len }, () => 800),
    closesHTF: Array.from({ length: 6 }, () => 120),
    emaFastHTF: Array.from({ length: 6 }, () => 118),
    emaMidHTF: Array.from({ length: 6 }, () => 115),
    emaSlowHTF: Array.from({ length: 6 }, () => 110),
    adxHTF: Array.from({ length: 6 }, () => 30),
  };

  if (withEntryEma) {
    indicators.emaFast = Array.from({ length: len }, () => 125);
    indicators.emaSlow = Array.from({ length: len }, () => 120);
  }

  if (withRsi) {
    indicators.rsi = Array.from({ length: len }, () => 50);
  }

  return { indicators, lastIdx: last };
}

describe("evaluateTrendFollowingEntry optional indicators", () => {
  test("signal proceeds without entry EMAs or RSI when HTF/Donchian/vol pass", () => {
    const { indicators, lastIdx } = buildLongEntryIndicators({
      withEntryEma: false,
      withRsi: false,
    });

    const result = evaluateTrendFollowingEntry({ indicators, lastIdx, config: DEFAULTS });
    expect(result.signal).toBe("LONG");
    expect(result.entryChecklist.ema9Retest).toBe(false);
  });

  test("signal blocked by RSI when available and outside band", () => {
    const { indicators, lastIdx } = buildLongEntryIndicators({
      withEntryEma: false,
      withRsi: true,
    });
    indicators.rsi[lastIdx] = 85;

    const result = evaluateTrendFollowingEntry({ indicators, lastIdx, config: DEFAULTS });
    expect(result.signal).toBeNull();
  });
});

run();
