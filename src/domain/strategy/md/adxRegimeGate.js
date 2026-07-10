/**
 * Auction Market Theory regime gate for Mean Drift (MD-SUB-01).
 *
 * Component B — NOT an entry signal. Classifies entry-TF ADX(14) into:
 *   balance    (ADX < 20)  → MR allowed at full confidence
 *   transition (20–25)     → MR allowed with reduced confidence
 *   imbalance  (ADX ≥ 25)  → MR blocked (trending / auction imbalance)
 *
 * Complements the existing HTF EMA regime filter (`htfRegimeFilter.js`) —
 * this gate measures local trend strength on the entry timeframe.
 */

"use strict";

const DEFAULTS = {
  adxPeriod: 14,
  balanceMax: 20,      // ADX < balanceMax → balance
  imbalanceMin: 25,    // ADX >= imbalanceMin → imbalance
  transitionConfidenceMult: 0.75,
};

/**
 * @param {number|null|undefined} adx
 * @param {object} [opts]
 * @returns {'balance'|'transition'|'imbalance'|'unknown'}
 */
function classifyAdxRegime(adx, opts = {}) {
  const balanceMax = opts.balanceMax ?? DEFAULTS.balanceMax;
  const imbalanceMin = opts.imbalanceMin ?? DEFAULTS.imbalanceMin;
  if (adx == null || !Number.isFinite(adx)) return "unknown";
  if (adx < balanceMax) return "balance";
  if (adx >= imbalanceMin) return "imbalance";
  return "transition";
}

/**
 * Pre-entry gate for MD BB+RSI signals.
 *
 * Fail-open when ADX is unavailable (warmup / missing series) so existing
 * bots keep trading until indicators are populated — same pattern as AF chop gate.
 *
 * @param {object} params
 * @param {number|null|undefined} params.adx
 * @param {object} [params.config]
 * @returns {{
 *   allowed: boolean,
 *   regime: string,
 *   confidenceMult: number,
 *   reason: string,
 *   adx: number|null,
 * }}
 */
function evaluateAdxRegimeGate({ adx, config = {} } = {}) {
  const balanceMax = config.mdAdxBalanceMax ?? config.adxBalanceMax ?? DEFAULTS.balanceMax;
  const imbalanceMin = config.mdAdxImbalanceMin ?? config.adxImbalanceMin ?? DEFAULTS.imbalanceMin;
  const transitionMult =
    config.mdAdxTransitionConfidenceMult ??
    config.adxTransitionConfidenceMult ??
    DEFAULTS.transitionConfidenceMult;

  const regime = classifyAdxRegime(adx, { balanceMax, imbalanceMin });
  const adxVal = adx == null || !Number.isFinite(adx) ? null : adx;

  if (regime === "unknown") {
    return {
      allowed: true,
      regime,
      confidenceMult: 1,
      reason: "ADX unavailable — fail-open (warmup / missing series)",
      adx: adxVal,
    };
  }

  if (regime === "imbalance") {
    return {
      allowed: false,
      regime,
      confidenceMult: 0,
      reason: `ADX ${adxVal.toFixed(1)} ≥ ${imbalanceMin} — imbalance/trending; MR blocked`,
      adx: adxVal,
    };
  }

  if (regime === "transition") {
    return {
      allowed: true,
      regime,
      confidenceMult: transitionMult,
      reason: `ADX ${adxVal.toFixed(1)} in transition (${balanceMax}–${imbalanceMin}) — MR allowed at reduced confidence`,
      adx: adxVal,
    };
  }

  return {
    allowed: true,
    regime: "balance",
    confidenceMult: 1,
    reason: `ADX ${adxVal.toFixed(1)} < ${balanceMax} — balance; MR ideal`,
    adx: adxVal,
  };
}

module.exports = {
  DEFAULTS,
  classifyAdxRegime,
  evaluateAdxRegimeGate,
};
