/**
 * Intrabar SL/TP hit evaluation (BUG-TP-INTRABAR).
 * Pure — used by BotEngine._checkOpenPositions and unit tests.
 */

/**
 * @param {{ side: string, sl?: number, tp?: number }} pos
 * @param {number} price monitor / last price
 * @param {number} [barHigh]
 * @param {number} [barLow]
 * @returns {{ hitSL: boolean, hitTP: boolean, isTP: boolean, sl: number, tp: number }}
 */
function evaluateSlTpHit(pos, price, barHigh, barLow) {
  const px = Number(price);
  const hi = Number.isFinite(barHigh) ? barHigh : px;
  const lo = Number.isFinite(barLow) ? barLow : px;
  const sl = Number(pos.sl);
  const tp = Number(pos.tp);
  const hasSL = Number.isFinite(sl) && sl > 0;
  const hasTP = Number.isFinite(tp) && tp > 0;
  const hitSL = hasSL && (pos.side === "LONG"
    ? (lo <= sl || px <= sl)
    : (hi >= sl || px >= sl));
  const hitTP = hasTP && (pos.side === "LONG"
    ? (hi >= tp || px >= tp)
    : (lo <= tp || px <= tp));
  return { hitSL, hitTP, isTP: hitTP && !hitSL, sl, tp };
}

module.exports = { evaluateSlTpHit };
