/**
 * entitlement strategy-mode helpers — unit tests (TASK 2.1).
 * Menguji bagian PURE (tanpa DB): isStrategyLiveReady + filterStrategiesByMode.
 * Mencakup AC-07 (BR tidak boleh live).
 */
const { isStrategyLiveReady, filterStrategiesByMode } = require("../src/services/entitlement");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

console.log("\n🎫 entitlement strategy-mode Unit Tests\n");

// ── isStrategyLiveReady ─────────────────────────────────────────────────────
t("ADAPTIVE_FUSION live-ready", isStrategyLiveReady("ADAPTIVE_FUSION") === true);
t("TREND_MOMENTUM live-ready", isStrategyLiveReady("TREND_MOMENTUM") === true);
t("MEAN_REVERSION live-ready", isStrategyLiveReady("MEAN_REVERSION") === true);
t("AC-07: BREAKOUT_RETEST NOT live-ready (dry-run only)", isStrategyLiveReady("BREAKOUT_RETEST") === false);

// ── filterStrategiesByMode ──────────────────────────────────────────────────
const vault = ["ADAPTIVE_FUSION", "TREND_MOMENTUM", "MEAN_REVERSION", "BREAKOUT_RETEST"];

{
  const dry = filterStrategiesByMode(vault, "dry");
  t("dry mode → semua 4 strategi (termasuk BR)", dry.length === 4);
}
{
  const live = filterStrategiesByMode(vault, "live");
  t("AC-07: live mode → BR di-exclude (3 strategi)", live.length === 3);
  t("live mode → BR tidak ada", !live.includes("BREAKOUT_RETEST"));
  t("live mode → AF/TM/MR tetap ada",
    live.includes("ADAPTIVE_FUSION") && live.includes("TREND_MOMENTUM") && live.includes("MEAN_REVERSION"));
}
{
  t("filter mengembalikan salinan (tidak mutasi input)",
    (() => { const src = ["ADAPTIVE_FUSION"]; const out = filterStrategiesByMode(src, "dry"); out.push("X"); return src.length === 1; })());
  t("input non-array → array kosong", filterStrategiesByMode(null, "live").length === 0);
}

console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
process.exit(fail === 0 ? 0 : 1);
