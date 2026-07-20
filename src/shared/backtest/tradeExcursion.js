"use strict";

/**
 * Per-trade MFE/MAE tracking during backtest (intra-bar high/low).
 * Used by RealStrategyBacktestService multi- and single-position paths.
 */

function initPositionExcursions() {
  return { mfePrice: 0, maePrice: 0 };
}

function updatePositionExcursions(position, candle) {
  if (!position || !candle || !(position.entry > 0)) return;
  const entry = position.entry;
  if (position.mfePrice == null) position.mfePrice = 0;
  if (position.maePrice == null) position.maePrice = 0;

  if (position.side === "LONG") {
    const favorable = Math.max(0, (candle.high ?? entry) - entry);
    const adverse = Math.max(0, entry - (candle.low ?? entry));
    position.mfePrice = Math.max(position.mfePrice, favorable);
    position.maePrice = Math.max(position.maePrice, adverse);
  } else {
    const favorable = Math.max(0, entry - (candle.low ?? entry));
    const adverse = Math.max(0, (candle.high ?? entry) - entry);
    position.mfePrice = Math.max(position.mfePrice, favorable);
    position.maePrice = Math.max(position.maePrice, adverse);
  }
}

function round4(n) {
  return Number.isFinite(n) ? parseFloat(n.toFixed(4)) : null;
}

/**
 * @param {object} position — must have entry, side, mfePrice, maePrice
 * @param {number} exitPrice
 */
function computeExcursionFields(position, exitPrice) {
  const entry = position?.entry;
  if (!(entry > 0)) {
    return { mfe: null, mae: null, mfePercent: null, maePercent: null, exitEfficiency: null };
  }
  const mfe = position.mfePrice ?? 0;
  const mae = position.maePrice ?? 0;
  const mfePercent = round4((mfe / entry) * 100);
  const maePercent = round4((mae / entry) * 100);
  const realizedMove = position.side === "LONG"
    ? Math.max(0, exitPrice - entry)
    : Math.max(0, entry - exitPrice);
  const exitEfficiency = mfe > 0 ? round4(realizedMove / mfe) : null;
  return {
    mfe: round4(mfe),
    mae: round4(mae),
    mfePercent,
    maePercent,
    exitEfficiency,
  };
}

module.exports = {
  initPositionExcursions,
  updatePositionExcursions,
  computeExcursionFields,
};
