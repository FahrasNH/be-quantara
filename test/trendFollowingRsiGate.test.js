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
    expect(passesRsiGate(null, DEFAULTS)).toBe(false);
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
});

run();
