/**
 * simulator.js — Shared trade simulator for backtests
 *
 * Single source of truth for SL/TP exit + P&L simulation. Previously this exact
 * function was copy-pasted (byte-identical) into 4 strategy backtest scripts;
 * it now lives here so it can be unit-tested (see test/Simulator.test.js) and
 * fixed in one place.
 *
 * Model: intrabar using each candle's high/low (realistic — catches wick
 * touches). When a single bar spans BOTH stop and target, SL is checked first
 * (conservative worst-case assumption). Exits fill exactly at the SL/TP level.
 *
 * P&L is per-unit price difference (size is applied by the caller):
 *   LONG  win/loss = exit - entry
 *   SHORT win/loss = entry - exit
 *
 * @param {Array<{high:number,low:number,close:number}>} candles
 * @param {number} entryIdx  index of the entry bar (entry = candles[entryIdx].close)
 * @param {"LONG"|"SHORT"} direction
 * @param {{stopLoss:number, takeProfit:number}} riskCfg
 * @returns {{entry:number, exit:number, pnl:number, exitBar:number, reason:"SL"|"TP"|"Timeout"}}
 */
function simulateTrade(candles, entryIdx, direction, riskCfg) {
  const entry = candles[entryIdx].close;
  const sl    = riskCfg.stopLoss;
  const tp    = riskCfg.takeProfit;

  for (let i = entryIdx + 1; i < candles.length; i++) {
    const { high, low } = candles[i];

    if (direction === "LONG") {
      if (low  <= sl) return { entry, exit: sl, pnl: sl - entry, exitBar: i, reason: "SL" };
      if (high >= tp) return { entry, exit: tp, pnl: tp - entry, exitBar: i, reason: "TP" };
    } else {
      if (high >= sl) return { entry, exit: sl, pnl: entry - sl, exitBar: i, reason: "SL" };
      if (low  <= tp) return { entry, exit: tp, pnl: entry - tp, exitBar: i, reason: "TP" };
    }
  }

  // Timed out — close at last bar
  const exit = candles[candles.length - 1].close;
  const pnl  = direction === "LONG" ? exit - entry : entry - exit;
  return { entry, exit, pnl, exitBar: candles.length - 1, reason: "Timeout" };
}

module.exports = { simulateTrade };
