/**
 * tradeAttribution unit tests (TASK 2.3 — Multi-Strategy per Coin).
 * Mencakup AC-04: firedByStrategy terisi + SL/TP match config strategi yang fire.
 */
const { buildTradeAttribution } = require("../src/domain/tradeAttribution");

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
  const { resolvePersistedStrategyKey } = require("../src/domain/tradeAttribution");
  t(
    "winningComponent beats config umbrella",
    resolvePersistedStrategyKey({
      strategyName: "AF_WYCKOFF",
      configKey: "AF_SMC",
      indicators: { winningComponent: "AF_WYCKOFF", firedByStrategy: "AF_WYCKOFF" },
    }) === "AF_WYCKOFF"
  );
  t(
    "winningComponent beats stale umbrella strategyName",
    resolvePersistedStrategyKey({
      strategyName: "AF_SMC",
      indicators: { winningComponent: "AF_VSA" },
    }) === "AF_VSA"
  );
  t(
    "firedByStrategy used when strategyName omitted",
    resolvePersistedStrategyKey({
      indicators: { firedByStrategy: "TS_MS" },
      configKey: "TS_TF",
    }) === "TS_MS"
  );
  t(
    "legacy ADAPTIVE_FUSION normalizes to AF_SMC",
    resolvePersistedStrategyKey({ strategyName: "ADAPTIVE_FUSION" }) === "AF_SMC"
  );
  t(
    "abbrev AF → AF_SMC",
    resolvePersistedStrategyKey({ strategyName: "AF" }) === "AF_SMC"
  );
  t(
    "Gen1 abbrev SAC → AF_SMC via normalizeStrategyKey SSOT",
    resolvePersistedStrategyKey({ strategyName: "SAC" }) === "AF_SMC"
  );
  t(
    "Gen1 abbrev TM → TS_TF via normalizeStrategyKey SSOT",
    resolvePersistedStrategyKey({ strategyName: "TM" }) === "TS_TF"
  );
  t(
    "Gen1 abbrev MR → MD_MR via normalizeStrategyKey SSOT",
    resolvePersistedStrategyKey({ strategyName: "MR" }) === "MD_MR"
  );
  t(
    "Gen1 abbrev BR → BS_BR via normalizeStrategyKey SSOT",
    resolvePersistedStrategyKey({ strategyName: "BR" }) === "BS_BR"
  );
  t(
    "null inputs → null",
    resolvePersistedStrategyKey({}) === null
  );
}

console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
process.exit(fail === 0 ? 0 : 1);
