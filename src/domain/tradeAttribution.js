/**
 * ─────────────────────────────────────────────────────────────────────────────
 * tradeAttribution.js — Atribusi strategi per-trade (Multi-Strategy per Coin)
 *
 * Pure function: membangun metadata atribusi yang dipersist bersama tiap trade
 * sehingga setiap entry bisa ditelusuri ke strategi yang memfire-nya, lengkap
 * dengan harga SL/TP aktual dan multiplier-nya (AC-04).
 *
 * slMultiplier/tpMultiplier diturunkan dari jarak SL/TP terhadap ATR agar akurat
 * lintas-strategi — termasuk saat ADAPTIVE_FUSION / BREAKOUT_RETEST meng-override
 * jarak per-komponen (bukan sekadar atrMultiplier statis).
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const round4 = (v) => (Number.isFinite(v) ? parseFloat(v.toFixed(4)) : null);

/**
 * Gen2 umbrella abbrevs (STRATEGY_ABBREV write path: AF/TS/MD/BS).
 * Gen1 abbrevs SAC/TM/MR/BR are NOT listed here — they resolve via
 * normalizeStrategyKey → STRATEGY_MIGRATION_MAP (SSOT for legacy aliases).
 */
const STRATEGY_ABBREV_TO_KEY = {
  AF: "AF_SMC",
  TS: "TS_TF",
  MD: "MD_MR",
  BS: "BS_BR",
};

/**
 * Resolve the canonical key that must be persisted on `trades.strategy_name`.
 * Prefer race winning component / firedByStrategy over umbrella engine keys.
 *
 * Historical gap: rows without indicators.winningComponent|firedByStrategy can
 * only be normalized to the umbrella engine (e.g. ADAPTIVE_FUSION → AF_SMC) —
 * per-racer identity is lost for those rows.
 *
 * @param {Object} [p]
 * @param {string} [p.strategyName] — explicit attribution key (preferred)
 * @param {string} [p.configKey]    — bot/engine strategyKey fallback
 * @param {object} [p.indicators]   — entry snapshot (winningComponent / firedByStrategy)
 * @returns {string|null}
 */
function resolvePersistedStrategyKey({ strategyName, configKey, indicators } = {}) {
  const ind = indicators && typeof indicators === "object" ? indicators : {};
  const candidates = [
    ind.winningComponent,
    ind.firedByStrategy,
    strategyName,
    configKey,
    ind.strategy,
  ];

  let { normalizeStrategyKey } = {};
  try {
    ({ normalizeStrategyKey } = require("../config/strategies"));
  } catch {
    normalizeStrategyKey = (k) => k;
  }

  for (const c of candidates) {
    if (c == null || c === "") continue;
    const raw = String(c).trim();
    const fromAbbrev = STRATEGY_ABBREV_TO_KEY[raw.toUpperCase()];
    const mapped = fromAbbrev || raw;
    const normalized = normalizeStrategyKey(mapped);
    if (normalized) return String(normalized).toUpperCase();
  }
  return null;
}

/**
 * @param {Object} p
 * @param {string} p.strategyKey  — strategi yang memfire trade ini
 * @param {string} [p.strategyLabel] — human label (e.g. winning TS racer)
 * @param {number} p.sl           — harga stop-loss aktual
 * @param {number} p.tp           — harga take-profit aktual
 * @param {number} p.slDist       — jarak SL dari entry (price units)
 * @param {number} p.tpDist       — jarak TP dari entry (price units)
 * @param {number} p.atr          — ATR saat entry (untuk menurunkan multiplier)
 * @returns {{firedByStrategy: string|null, strategyLabel: string|null, slPrice: number|null, tpPrice: number|null, slMultiplier: number|null, tpMultiplier: number|null}}
 */
function buildTradeAttribution({ strategyKey, strategyLabel, sl, tp, slDist, tpDist, atr }) {
  return {
    firedByStrategy: strategyKey ?? null,
    strategyLabel: strategyLabel ?? null,
    slPrice: round4(sl),
    tpPrice: round4(tp),
    slMultiplier: atr ? round4(slDist / atr) : null,
    tpMultiplier: atr ? round4(tpDist / atr) : null,
  };
}

module.exports = { buildTradeAttribution, resolvePersistedStrategyKey, STRATEGY_ABBREV_TO_KEY };
