/**
 * Round-trip fee estimation (entry + exit notional).
 * Pure — BotEngine._estimateFee / dry-run / backtest parity.
 */

/**
 * @param {number} entryPrice
 * @param {number} exitPrice
 * @param {number} size
 * @param {{ feeRate?: number, entryMode?: string, makerFeeRate?: number }} [opts]
 */
function estimateRoundTripFee(entryPrice, exitPrice, size, opts = {}) {
  const sz = Math.abs(size);
  const takerRate = opts.feeRate ?? 0.0006;
  // FEE-02: entry uses maker when entryMode="maker" (limit post-only);
  // exit (SL/TP) is always market → taker.
  const entryRate = opts.entryMode === "maker"
    ? (opts.makerFeeRate ?? 0.0002)
    : takerRate;
  return Math.abs(entryPrice) * sz * entryRate + Math.abs(exitPrice) * sz * takerRate;
}

module.exports = { estimateRoundTripFee };
