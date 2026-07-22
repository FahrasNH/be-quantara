/**
 * strategyDefaults.js — per-leg typeOverrides + smc isolation + tier COMPONENT_BASE guardrails.
 */
"use strict";

const assert = require("node:assert/strict");
const {
  STRATEGIES,
  AF_COMPONENT_BASE,
  TS_COMPONENT_BASE,
  MD_COMPONENT_BASE,
  BS_COMPONENT_BASE,
  SCALP_GEOMETRY,
  INTRADAY_HOLD,
  SWING_HOLD,
} = require("../src/config/strategyDefaults");
const { normalizeStrategyKey, normalizeTradeTypeKey } = require("../src/config/strategyKeyNormalizer");

const MULTI_LEG_KEYS = [
  "SMART_MONEY_CONCEPTS",
  "TREND_FOLLOWING",
  "MEAN_REVERSION",
  "BREAKOUT_RETEST",
  "WYCKOFF",
  "VOLUME_SPREAD_ANALYSIS",
  "MARKET_STRUCTURE",
  "AUCTION_MARKET_THEORY",
  "SUPPLY_AND_DEMAND",
  "STATISTICAL_ARBITRAGE",
  "ICT_STYLE_TRADING",
  "LIQUIDATION_SQUEEZE",
];

const NON_SMC_KEYS = MULTI_LEG_KEYS.filter((k) => k !== "SMART_MONEY_CONCEPTS");

const TF_PARENT_ONLY = [
  "donchianPeriod", "adxMinStrength", "htfRatio", "mtfRatio", "minVolRatio",
  "tfHtfLayerEnabled", "tsCombinationMode", "tsUseStructureGate", "tsUseVwapPrecision",
  "tpMode", "grokConfirmMinEntry", "grokConfirmMinTp",
];

const MR_PARENT_ONLY = [
  "bbStdDevA", "bbStdDevB", "rsiOversoldA", "rsiOverboughtA",
  "rsiOversoldB", "rsiOverboughtB", "mdAdxGateEnabled", "mdObFvgEnabled",
  "mdAdxPeriod", "mdAdxBalanceMax", "mdAdxImbalanceMin", "mdAdxTransitionConfidenceMult",
  "mdConfluenceAtrMult", "mdNoConfluenceConfidenceMult", "mdWithConfluenceConfidenceBoost",
  "mdFvgScanBars", "mdFvgMinGapPct", "mdObLookback", "mdObDispMult",
];

const BR_PARENT_ONLY = [
  "lookbackBars", "volumeMultiplier", "maxVolumeRatio", "retestWindow",
  "minRetestBars", "minRejectionWickRatio", "minRetestDepthAtr", "maxRetestDepthAtr",
  "minDisplacementAtr", "blockedMarketConds", "squeezeLookback",
  "squeezeThreshold", "minBbWidthPct", "minAtrPct", "requireConsolidation",
  "preferredTpMode", "minSlAtrFloor", "maxPlannedRR",
];

const PARENT_ONLY_ALL_TIERS = [...TF_PARENT_ONLY, ...MR_PARENT_ONLY, ...BR_PARENT_ONLY];

const AF_COMPONENTS = ["WYCKOFF", "VOLUME_SPREAD_ANALYSIS"];
const TS_COMPONENTS = ["MARKET_STRUCTURE", "AUCTION_MARKET_THEORY"];
const MD_COMPONENTS = ["SUPPLY_AND_DEMAND", "STATISTICAL_ARBITRAGE"];
const BS_COMPONENTS = ["ICT_STYLE_TRADING", "LIQUIDATION_SQUEEZE"];

function assertNoKeys(cfg, forbidden, label) {
  for (const key of forbidden) {
    assert.ok(!(key in cfg), `${label} must not have parent-only key ${key}`);
  }
  for (const leg of ["Scalping", "Intraday", "Swing"]) {
    const ov = cfg.typeOverrides?.[leg] || {};
    for (const key of forbidden) {
      assert.ok(!(key in ov), `${label}.typeOverrides.${leg} must not have ${key}`);
    }
  }
}

console.log("\n═══ strategyDefaults per-leg SSOT ═══\n");

assert.ok(!STRATEGIES.AGGRESSIVE_SCALPING, "AGGRESSIVE_SCALPING preset removed");
assert.ok(!STRATEGIES.DAY_TRADING, "DAY_TRADING preset removed");
assert.ok(!STRATEGIES.SWING_TRADING, "SWING_TRADING preset removed");

// ── Tier COMPONENT_BASE blocks exist ─────────────────────────────────────────
assert.ok(AF_COMPONENT_BASE.emaFast === 9, "AF_COMPONENT_BASE has shared geometry");
assert.ok(TS_COMPONENT_BASE.emaFast === 9, "TS_COMPONENT_BASE has shared geometry");
assert.ok(MD_COMPONENT_BASE.emaFast === 9, "MD_COMPONENT_BASE has shared geometry");
assert.ok(BS_COMPONENT_BASE.emaFast === 9, "BS_COMPONENT_BASE has shared geometry");
assert.ok(!("donchianPeriod" in TS_COMPONENT_BASE), "TS_COMPONENT_BASE excludes TF parent knobs");
assert.ok(!("mdAdxGateEnabled" in MD_COMPONENT_BASE), "MD_COMPONENT_BASE excludes MR parent knobs");
assert.ok(!("lookbackBars" in BS_COMPONENT_BASE), "BS_COMPONENT_BASE excludes BR parent knobs");
assert.ok(!("smcMinVotes" in AF_COMPONENT_BASE), "AF_COMPONENT_BASE excludes smc* knobs");

for (const key of MULTI_LEG_KEYS) {
  const cfg = STRATEGIES[key];
  assert.ok(cfg, `${key} must exist`);
  assert.ok(cfg.typeOverrides?.Scalping?.atrMinMult != null, `${key} Scalping atrMinMult`);
  assert.ok(cfg.typeOverrides?.Intraday?.atrMinMult != null, `${key} Intraday atrMinMult`);
  assert.ok(cfg.typeOverrides?.Swing?.atrMinMult != null, `${key} Swing atrMinMult`);
  const scalp = cfg.typeOverrides.Scalping;
  assert.equal(scalp.slAtrMult, SCALP_GEOMETRY.slAtrMult, `${key} Scalping slAtrMult`);
  assert.equal(scalp.tpAtrMult, SCALP_GEOMETRY.tpAtrMult, `${key} Scalping tpAtrMult`);
  assert.equal(scalp.maxHoldHours, SCALP_GEOMETRY.maxHoldHours, `${key} Scalping maxHoldHours`);
  const intraday = cfg.typeOverrides.Intraday;
  assert.equal(intraday.maxHoldHours, INTRADAY_HOLD.maxHoldHours, `${key} Intraday maxHoldHours`);
  const swing = cfg.typeOverrides.Swing;
  assert.equal(swing.maxHoldHours, SWING_HOLD.maxHoldHours, `${key} Swing maxHoldHours`);
}

for (const key of NON_SMC_KEYS) {
  const cfg = STRATEGIES[key];
  for (const prop of Object.keys(cfg)) {
    assert.ok(!prop.startsWith("smc"), `${key} must not have top-level ${prop}`);
  }
  for (const leg of ["Scalping", "Intraday", "Swing"]) {
    const ov = cfg.typeOverrides?.[leg] || {};
    for (const prop of Object.keys(ov)) {
      assert.ok(!prop.startsWith("smc"), `${key}.typeOverrides.${leg} must not have ${prop}`);
    }
  }
}

// ── Components must NOT inherit parent-specific knobs ────────────────────────
for (const key of AF_COMPONENTS.concat(TS_COMPONENTS, MD_COMPONENTS, BS_COMPONENTS)) {
  assertNoKeys(STRATEGIES[key], PARENT_ONLY_ALL_TIERS, key);
}

// ── Component-specific knobs present (not just tier base) ────────────────────
assert.equal(STRATEGIES.WYCKOFF.entryModel, "aggressive");
assert.equal(STRATEGIES.WYCKOFF.springLookback, 20);
assert.equal(STRATEGIES.VOLUME_SPREAD_ANALYSIS.wideSpreadMult, 1.3);
assert.equal(STRATEGIES.MARKET_STRUCTURE.leftLook, 2);
assert.equal(STRATEGIES.AUCTION_MARKET_THEORY.vwapAtrMult, 0.5);
assert.equal(STRATEGIES.SUPPLY_AND_DEMAND.mdSdConfluenceAtrMult, 0.75);
assert.equal(STRATEGIES.STATISTICAL_ARBITRAGE.mdSaEntryZ, 1.6);
assert.equal(STRATEGIES.STATISTICAL_ARBITRAGE.mdSaEntryZMax, 2.5);
assert.equal(STRATEGIES.STATISTICAL_ARBITRAGE.mdSaZBoostPerUnit, 0);
assert.equal(STRATEGIES.ICT_STYLE_TRADING.bsIctBaseConfidence, 0.7);
assert.equal(STRATEGIES.LIQUIDATION_SQUEEZE.bsLsWickLookback, 20);

// ── Parents retain their specific knobs ──────────────────────────────────────
assert.equal(STRATEGIES.TREND_FOLLOWING.donchianPeriod, 20);
assert.equal(STRATEGIES.MEAN_REVERSION.mdAdxGateEnabled, true);
assert.equal(STRATEGIES.BREAKOUT_RETEST.lookbackBars, 20);

const smc = STRATEGIES.SMART_MONEY_CONCEPTS;
assert.equal(smc.enabledComponents?.join(","), "Scalping,Intraday,Swing");
assert.equal(smc.typeOverrides.Scalping.smcMinConfidenceA, 40);
assert.equal(smc.typeOverrides.Scalping.smcSweepVolMult, 1.2);
assert.equal(smc.typeOverrides.Intraday.smcMinConfidenceB, 45);
assert.equal(smc.typeOverrides.Intraday.smcSweepVolMult, undefined);
assert.equal(smc.typeOverrides.Swing.smcSweepVolMult, undefined);
assert.ok(smc.smcUseSequenceEngine === true);

const UMBRELLA_KEYS = ["ADAPTIVE_FUSION", "TREND_SURGE", "MEAN_DRIFT", "BREAKOUT_STORM"];
for (const key of UMBRELLA_KEYS) {
  const cfg = STRATEGIES[key];
  assert.ok(cfg, `${key} umbrella must exist`);
  assert.ok(!cfg.typeOverrides, `${key} umbrella must not have typeOverrides`);
  assert.ok(!cfg.enabledComponents, `${key} umbrella must not have enabledComponents`);
  for (const prop of Object.keys(cfg)) {
    assert.ok(!prop.startsWith("smc"), `${key} umbrella must not have ${prop}`);
    assert.ok(!["emaFast", "atrPeriod", "riskReward"].includes(prop), `${key} umbrella must not have shared geometry ${prop}`);
  }
}
assert.ok(!STRATEGIES.ADAPTIVE_FUSION.smcUseSequenceEngine, "ADAPTIVE_FUSION umbrella has no smc*");

assert.equal(normalizeStrategyKey("DAY_TRADING"), "TREND_FOLLOWING");
assert.equal(normalizeStrategyKey("AGGRESSIVE_SCALPING"), "SMART_MONEY_CONCEPTS");
assert.equal(normalizeTradeTypeKey("B"), "Intraday");
assert.equal(normalizeTradeTypeKey("A"), "Scalping");

console.log("  ✓ PDF presets removed; per-leg typeOverrides on all multi-leg strategies");
console.log("  ✓ Scalping RR 2.0 + 120m time-stop on all 12 multi-leg strategies");
console.log("  ✓ Intraday 6h + Swing 120h TIME_STOP on all 12 multi-leg strategies");
console.log("  ✓ smc* isolated to SMART_MONEY_CONCEPTS");
console.log("  ✓ tier COMPONENT_BASE blocks; components exclude parent-only knobs");
console.log("\nAll strategy-defaults-legs tests passed.\n");
