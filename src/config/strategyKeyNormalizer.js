/**
 * strategyKeyNormalizer.js — Anti-Corruption Layer (ACL) for strategy keys.
 *
 * CONVENTION (Gen2-only internal):
 *   Internal code MUST use Gen2 canonical keys: AF_SMC, TS_TF, MD_MR, BS_BR,
 *   race components (AF_WYCKOFF, TS_MS, …), umbrellas (ADAPTIVE_FUSION,
 *   TREND_SURGE, MEAN_DRIFT, BREAKOUT_STORM), GROK_AI_TRADING.
 *
 *   Gen1 legacy keys (SMART_MONEY_CONCEPTS, TREND_FOLLOWING, MEAN_REVERSION,
 *   BREAKOUT_RETEST, SAC, TF, TM, MR, BR) are accepted ONLY at ingress via
 *   normalizeStrategyKey() / ingressNormalizeStrategyKey().
 *
 *   PDF trade-type keys (A/B/C → AGGRESSIVE_SCALPING/DAY_TRADING/SWING_TRADING)
 *   are a SEPARATE axis — use normalizeTradeTypeKey(), not strategy migration.
 *
 *   Do NOT add Gen1 literals outside this file. Guardrail: test/gen1-literal-guard.test.js
 */

/** Gen1 descriptor / abbrev → Gen2 canonical engine or component key. */
const STRATEGY_MIGRATION_MAP = Object.freeze({
  ADAPTIVE_FUSION: "AF_SMC",
  SAC: "AF_SMC",
  SMART_MONEY_CONCEPTS: "AF_SMC",
  TREND_FOLLOWING: "TS_TF",
  TREND_SURGE: "TS_TF",
  TF: "TS_TF",
  TM: "TS_TF",
  MEAN_REVERSION: "MD_MR",
  MEAN_DRIFT: "MD_MR",
  MR: "MD_MR",
  BREAKOUT_RETEST: "BS_BR",
  BREAKOUT_STORM: "BS_BR",
  BR: "BS_BR",
});

/** Gen1 strategy literals — used by guardrail test (must match STRATEGY_MIGRATION_MAP sources). */
const GEN1_STRATEGY_LITERALS = Object.freeze([
  "SMART_MONEY_CONCEPTS",
  "TREND_FOLLOWING",
  "MEAN_REVERSION",
  "BREAKOUT_RETEST",
  "SAC",
  "TF",
  "TM",
  "MR",
  "BR",
]);

/** PDF trade-type presets — NOT strategy keys; separate ingress axis. */
const LEGACY_TRADE_TYPE_ALIASES = Object.freeze({
  A: "AGGRESSIVE_SCALPING",
  B: "DAY_TRADING",
  C: "SWING_TRADING",
});

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
      `[strategyKey ACL] Gen1 deprecation: "${rawKey}" → "${canonicalKey}"${src}${mode}`
    );
  }
}

/**
 * Normalize a strategy key (Gen1 → Gen2). Identity / component keys pass through.
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

/** Ingress boundary helper — always logs Gen1 with caller context. */
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

/** Normalize PDF trade-type key (A/B/C legacy → AGGRESSIVE_SCALPING / DAY_TRADING / SWING_TRADING). */
function normalizeTradeTypeKey(key) {
  if (key == null || key === "") return key;
  const raw = String(key).toUpperCase();
  return LEGACY_TRADE_TYPE_ALIASES[raw] || raw;
}

function isPdfTradeTypeKey(key) {
  const k = String(key || "").toUpperCase();
  return k === "A" || k === "B" || k === "C"
    || k === "AGGRESSIVE_SCALPING" || k === "DAY_TRADING" || k === "SWING_TRADING";
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

/** Gen2 abbrev for display / CSV (no Gen1 abbrevs). */
const STRATEGY_ABBREV = Object.freeze({
  AF_SMC: "AF",
  AF_WYCKOFF: "AF",
  AF_VSA: "AF",
  TS_TF: "TS",
  TS_MS: "TS",
  TS_VP: "TS",
  MD_MR: "MD",
  MD_SD: "MD",
  MD_SA: "MD",
  BS_BR: "BS",
  BS_ICT: "BS",
  BS_LS: "BS",
  GROK_AI_TRADING: "GA",
  ADAPTIVE_FUSION: "AF",
  TREND_SURGE: "TS",
  MEAN_DRIFT: "MD",
  BREAKOUT_STORM: "BS",
});

/** Abbrev → engine (Gen2 + chart legacy SAC/TM/MR/BR resolved via normalizeStrategyKey). */
const ABBREV_TO_ENGINE = Object.freeze({
  AF: "AF_SMC",
  TS: "TS_TF",
  MD: "MD_MR",
  BS: "BS_BR",
  GA: "GROK_AI_TRADING",
  SAC: "AF_SMC",
  TM: "TS_TF",
  MR: "MD_MR",
  BR: "BS_BR",
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
  GEN1_STRATEGY_KEYS,
  LEGACY_TRADE_TYPE_ALIASES,
  STRATEGY_ABBREV,
  ABBREV_TO_ENGINE,
  normalizeStrategyKey,
  ingressNormalizeStrategyKey,
  normalizeTradeTypeKey,
  isLegacyAlias,
  isGen1StrategyKey,
  isPdfTradeTypeKey,
  abbrevToEngine,
  getGen1DeprecationStats,
  resetGen1DeprecationStats,
};
