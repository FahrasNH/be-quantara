/**
 * strategyKeyNormalizer.js — Anti-Corruption Layer (ACL) for strategy keys.
 *
 * CONVENTION (Gen2-only internal):
 *   Internal code MUST use Gen2 canonical full-word keys: SMART_MONEY_CONCEPTS,
 *   TREND_FOLLOWING, MEAN_REVERSION, BREAKOUT_RETEST, race components
 *   (WYCKOFF, MARKET_STRUCTURE, …), umbrellas (ADAPTIVE_FUSION, TREND_SURGE,
 *   MEAN_DRIFT, BREAKOUT_STORM), GROK_AI_TRADING.
 *
 *   Deprecated Gen2 abbrev keys (AF_SMC, TS_TF, MD_MR, BS_BR, …) and Gen1
 *   legacy keys (SAC, TF, TM, MR, BR) are accepted ONLY at ingress via
 *   normalizeStrategyKey() / ingressNormalizeStrategyKey().
 *
 *   Trade-type leg keys (A/B/C → Scalping/Intraday/Swing) are a SEPARATE axis —
 *   use normalizeTradeTypeKey(), not strategy migration.
 *
 *   Deprecated PDF preset strategy keys (AGGRESSIVE_SCALPING / DAY_TRADING /
 *   SWING_TRADING) normalize to canonical engines via STRATEGY_MIGRATION_MAP.
 *
 *   Do NOT add deprecated abbrev literals outside this file.
 *   Guardrail: test/gen1-literal-guard.test.js
 */

/** Ingress alias → Gen2 canonical full-word engine or component key. */
const STRATEGY_MIGRATION_MAP = Object.freeze({
  // Umbrella → primary engine
  ADAPTIVE_FUSION: "SMART_MONEY_CONCEPTS",
  TREND_SURGE: "TREND_FOLLOWING",
  MEAN_DRIFT: "MEAN_REVERSION",
  BREAKOUT_STORM: "BREAKOUT_RETEST",

  // Deprecated Gen2 abbrevs → canonical
  AF_SMC: "SMART_MONEY_CONCEPTS",
  AF_WYCKOFF: "WYCKOFF",
  AF_VSA: "VOLUME_SPREAD_ANALYSIS",
  TS_TF: "TREND_FOLLOWING",
  TS_MS: "MARKET_STRUCTURE",
  TS_VP: "AUCTION_MARKET_THEORY",
  MD_MR: "MEAN_REVERSION",
  MD_SD: "SUPPLY_AND_DEMAND",
  MD_SA: "STATISTICAL_ARBITRAGE",
  BS_BR: "BREAKOUT_RETEST",
  BS_ICT: "ICT_STYLE_TRADING",
  BS_LS: "LIQUIDATION_SQUEEZE",

  // Gen1 legacy abbrevs
  SAC: "SMART_MONEY_CONCEPTS",
  TF: "TREND_FOLLOWING",
  TM: "TREND_FOLLOWING",
  MR: "MEAN_REVERSION",
  BR: "BREAKOUT_RETEST",

  // Deprecated PDF trade-type preset strategy keys → canonical engines
  AGGRESSIVE_SCALPING: "SMART_MONEY_CONCEPTS",
  DAY_TRADING: "TREND_FOLLOWING",
  SWING_TRADING: "SMART_MONEY_CONCEPTS",
});

/** Deprecated abbrev literals — guardrail (must match STRATEGY_MIGRATION_MAP abbrevs). */
const DEPRECATED_STRATEGY_ABBREVS = Object.freeze([
  "AF_SMC",
  "AF_WYCKOFF",
  "AF_VSA",
  "TS_TF",
  "TS_MS",
  "TS_VP",
  "MD_MR",
  "MD_SD",
  "MD_SA",
  "BS_BR",
  "BS_ICT",
  "BS_LS",
]);

/** Gen1 short abbrevs — used by guardrail test. */
const GEN1_STRATEGY_LITERALS = Object.freeze([
  "SAC",
  "TF",
  "TM",
  "MR",
  "BR",
]);

/** Trade-type leg aliases — Scalping / Intraday / Swing (NOT strategy keys). */
const LEGACY_TRADE_TYPE_ALIASES = Object.freeze({
  A: "Scalping",
  B: "Intraday",
  C: "Swing",
  AGGRESSIVE_SCALPING: "Scalping",
  DAY_TRADING: "Intraday",
  SWING_TRADING: "Swing",
});

const TRADE_TYPE_LEGS = Object.freeze(["Scalping", "Intraday", "Swing"]);

const GEN1_STRATEGY_KEYS = new Set(Object.keys(STRATEGY_MIGRATION_MAP));

/** @type {Map<string, { count: number, samples: Array<{ source?: string, mode?: string }> }>} */
const _gen1DeprecationCounts = new Map();
let _gen1DeprecationLogCount = 0;
const MAX_DEPRECATION_LOGS = 200;

/**
 * @param {string} rawKey
 * @param {string} canonicalKey
 * @param {{ source?: string, mode?: string }} [hint]
 */
function _recordGen1Deprecation(rawKey, canonicalKey, hint = {}) {
  const upper = String(rawKey).toUpperCase();
  const entry = _gen1DeprecationCounts.get(upper) || { count: 0, canonical: canonicalKey, samples: [] };
  entry.count += 1;
  if (entry.samples.length < 5) {
    entry.samples.push({
      source: hint.source || "unknown",
      mode: hint.mode || "unknown",
    });
  }
  _gen1DeprecationCounts.set(upper, entry);

  if (_gen1DeprecationLogCount < MAX_DEPRECATION_LOGS) {
    _gen1DeprecationLogCount += 1;
    const src = hint.source ? ` source=${hint.source}` : "";
    const mode = hint.mode ? ` mode=${hint.mode}` : "";
    console.warn(
      `[strategyKey ACL] Deprecated alias: "${rawKey}" → "${canonicalKey}"${src}${mode}`
    );
  }
}

/**
 * Normalize a strategy key (deprecated alias → canonical). Identity keys pass through.
 * @param {string|null|undefined} key
 * @param {{ source?: string, mode?: 'live'|'backtest'|'unknown', ingress?: boolean }} [opts]
 * @returns {string|null|undefined}
 */
function normalizeStrategyKey(key, opts = {}) {
  if (key == null || key === "") return key;
  const raw = String(key);
  const upper = raw.toUpperCase();
  const canonical = STRATEGY_MIGRATION_MAP[raw] || STRATEGY_MIGRATION_MAP[upper] || raw;

  if (canonical !== raw && canonical !== upper) {
    _recordGen1Deprecation(raw, canonical, {
      source: opts.source,
      mode: opts.mode || (opts.ingress ? "ingress" : "unknown"),
    });
  }

  return canonical;
}

/** Ingress boundary helper — always logs deprecated alias with caller context. */
function ingressNormalizeStrategyKey(key, context = {}) {
  return normalizeStrategyKey(key, { ...context, ingress: true });
}

function isLegacyAlias(key) {
  const k = String(key || "").toUpperCase();
  return Boolean(STRATEGY_MIGRATION_MAP[k]);
}

function isGen1StrategyKey(key) {
  const k = String(key || "").toUpperCase();
  return GEN1_STRATEGY_KEYS.has(k);
}

/** Normalize trade-type leg key (A/B/C legacy → Scalping / Intraday / Swing). */
function normalizeTradeTypeKey(key) {
  if (key == null || key === "") return key;
  const raw = String(key).toUpperCase();
  return LEGACY_TRADE_TYPE_ALIASES[raw] || raw;
}

function isPdfTradeTypeKey(key) {
  const k = String(key || "").toUpperCase();
  return k === "A" || k === "B" || k === "C"
    || TRADE_TYPE_LEGS.includes(k)
    || k === "AGGRESSIVE_SCALPING" || k === "DAY_TRADING" || k === "SWING_TRADING";
}

function isTradeTypeLeg(key) {
  const k = normalizeTradeTypeKey(String(key || "").toUpperCase());
  return TRADE_TYPE_LEGS.includes(k);
}

function getGen1DeprecationStats() {
  return Object.fromEntries(
    [..._gen1DeprecationCounts.entries()].map(([k, v]) => [k, { ...v }])
  );
}

function resetGen1DeprecationStats() {
  _gen1DeprecationCounts.clear();
  _gen1DeprecationLogCount = 0;
}

/** Tier abbrev for display / CSV (no deprecated component abbrevs). */
const STRATEGY_ABBREV = Object.freeze({
  SMART_MONEY_CONCEPTS: "AF",
  WYCKOFF: "AF",
  VOLUME_SPREAD_ANALYSIS: "AF",
  TREND_FOLLOWING: "TS",
  MARKET_STRUCTURE: "TS",
  AUCTION_MARKET_THEORY: "TS",
  MEAN_REVERSION: "MD",
  SUPPLY_AND_DEMAND: "MD",
  STATISTICAL_ARBITRAGE: "MD",
  BREAKOUT_RETEST: "BS",
  ICT_STYLE_TRADING: "BS",
  LIQUIDATION_SQUEEZE: "BS",
  GROK_AI_TRADING: "GA",
  ADAPTIVE_FUSION: "AF",
  TREND_SURGE: "TS",
  MEAN_DRIFT: "MD",
  BREAKOUT_STORM: "BS",
});

/** Abbrev → engine (resolved via normalizeStrategyKey for legacy SAC/TM/MR/BR). */
const ABBREV_TO_ENGINE = Object.freeze({
  AF: "SMART_MONEY_CONCEPTS",
  TS: "TREND_FOLLOWING",
  MD: "MEAN_REVERSION",
  BS: "BREAKOUT_RETEST",
  GA: "GROK_AI_TRADING",
  SAC: "SMART_MONEY_CONCEPTS",
  TM: "TREND_FOLLOWING",
  MR: "MEAN_REVERSION",
  BR: "BREAKOUT_RETEST",
});

function abbrevToEngine(abbrev) {
  if (!abbrev) return abbrev;
  const raw = String(abbrev).toUpperCase();
  const mapped = ABBREV_TO_ENGINE[raw];
  return mapped ? normalizeStrategyKey(mapped) : raw;
}

module.exports = {
  STRATEGY_MIGRATION_MAP,
  GEN1_STRATEGY_LITERALS,
  DEPRECATED_STRATEGY_ABBREVS,
  GEN1_STRATEGY_KEYS,
  LEGACY_TRADE_TYPE_ALIASES,
  TRADE_TYPE_LEGS,
  STRATEGY_ABBREV,
  ABBREV_TO_ENGINE,
  normalizeStrategyKey,
  ingressNormalizeStrategyKey,
  normalizeTradeTypeKey,
  isLegacyAlias,
  isGen1StrategyKey,
  isPdfTradeTypeKey,
  isTradeTypeLeg,
  abbrevToEngine,
  getGen1DeprecationStats,
  resetGen1DeprecationStats,
};
