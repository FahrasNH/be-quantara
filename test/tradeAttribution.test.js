/**
 * tradeAttribution unit tests (TASK 2.3 — Multi-Strategy per Coin).
 * Mencakup AC-04: firedByStrategy terisi + SL/TP match config strategi yang fire.
 */
const { buildTradeAttribution } = require("#modules/analytics/domain/tradeAttribution.js");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

console.log("\n🏷️  tradeAttribution Unit Tests\n");

// ── LONG: SL di bawah, TP di atas ───────────────────────────────────────────
{
  // entry 100, atr 2, slMult 1.5 → slDist 3 → sl 97; RR 2 → tpDist 6 → tp 106
  const a = buildTradeAttribution({
    strategyKey: "TREND_FOLLOWING", sl: 97, tp: 106, slDist: 3, tpDist: 6, atr: 2,
  });
  t("AC-04: firedByStrategy terisi", a.firedByStrategy === "TREND_FOLLOWING");
  t("slPrice = 97", a.slPrice === 97);
  t("tpPrice = 106", a.tpPrice === 106);
  t("slMultiplier = slDist/atr = 1.5", a.slMultiplier === 1.5);
  t("tpMultiplier = tpDist/atr = 3", a.tpMultiplier === 3);
}

// ── ADAPTIVE_FUSION per-component override (slDist/tpDist non-standar) ───────
{
  // override: slDist 2.5, tpDist 7.5, atr 2 → slMult 1.25, tpMult 3.75
  const a = buildTradeAttribution({
    strategyKey: "ADAPTIVE_FUSION", sl: 97.5, tp: 107.5, slDist: 2.5, tpDist: 7.5, atr: 2,
  });
  t("override slMultiplier = 1.25 (bukan default)", a.slMultiplier === 1.25);
  t("override tpMultiplier = 3.75", a.tpMultiplier === 3.75);
}

// ── Guard: atr 0 / undefined → multiplier null (tidak NaN/Infinity) ─────────
{
  const a = buildTradeAttribution({ strategyKey: "MEAN_REVERSION", sl: 50, tp: 55, slDist: 1, tpDist: 5, atr: 0 });
  t("atr=0 → slMultiplier null", a.slMultiplier === null);
  t("atr=0 → tpMultiplier null", a.tpMultiplier === null);
  t("slPrice tetap terisi walau atr 0", a.slPrice === 50);
}

// ── Guard: strategyKey null → firedByStrategy null (bukan undefined) ─────────
{
  const a = buildTradeAttribution({ strategyKey: undefined, sl: 1, tp: 2, slDist: 0.5, tpDist: 1, atr: 0.5 });
  t("strategyKey undefined → firedByStrategy null", a.firedByStrategy === null);
}

// ── resolvePersistedStrategyKey: prefer winning component over umbrella ──────
{
  const { resolvePersistedStrategyKey } = require("#modules/analytics/domain/tradeAttribution.js");
  t(
    "winningComponent beats config umbrella",
    resolvePersistedStrategyKey({
      strategyName: "WYCKOFF",
      configKey: "SMART_MONEY_CONCEPTS",
      indicators: { winningComponent: "WYCKOFF", firedByStrategy: "WYCKOFF" },
    }) === "WYCKOFF"
  );
  t(
    "winningComponent beats stale umbrella strategyName",
    resolvePersistedStrategyKey({
      strategyName: "SMART_MONEY_CONCEPTS",
      indicators: { winningComponent: "VOLUME_SPREAD_ANALYSIS" },
    }) === "VOLUME_SPREAD_ANALYSIS"
  );
  t(
    "firedByStrategy used when strategyName omitted",
    resolvePersistedStrategyKey({
      indicators: { firedByStrategy: "MARKET_STRUCTURE" },
      configKey: "TREND_FOLLOWING",
    }) === "MARKET_STRUCTURE"
  );
  t(
    "legacy ADAPTIVE_FUSION normalizes to SMART_MONEY_CONCEPTS",
    resolvePersistedStrategyKey({ strategyName: "ADAPTIVE_FUSION" }) === "SMART_MONEY_CONCEPTS"
  );
  t(
    "abbrev AF → SMART_MONEY_CONCEPTS",
    resolvePersistedStrategyKey({ strategyName: "AF" }) === "SMART_MONEY_CONCEPTS"
  );
  t(
    "Gen1 abbrev SAC → SMART_MONEY_CONCEPTS via normalizeStrategyKey SSOT",
    resolvePersistedStrategyKey({ strategyName: "SAC" }) === "SMART_MONEY_CONCEPTS"
  );
  t(
    "Gen1 abbrev TM → TREND_FOLLOWING via normalizeStrategyKey SSOT",
    resolvePersistedStrategyKey({ strategyName: "TM" }) === "TREND_FOLLOWING"
  );
  t(
    "Gen1 abbrev MR → MEAN_REVERSION via normalizeStrategyKey SSOT",
    resolvePersistedStrategyKey({ strategyName: "MR" }) === "MEAN_REVERSION"
  );
  t(
    "Gen1 abbrev BR → BREAKOUT_RETEST via normalizeStrategyKey SSOT",
    resolvePersistedStrategyKey({ strategyName: "BR" }) === "BREAKOUT_RETEST"
  );
  t(
    "null inputs → null",
    resolvePersistedStrategyKey({}) === null
  );
}

console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
process.exit(fail === 0 ? 0 : 1);
