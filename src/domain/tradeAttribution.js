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

module.exports = { buildTradeAttribution };
