/**
 * Trading Strategy Recap.pdf — SSOT for Konsep, Indicators, PDF trade types.
 * Keep in sync with fe-bot-trading/src/constants/strategyRecapCatalog.js
 *
 * `recapStatus`: implemented | partial | future
 * `runtimeTradeTypes`: what STRATEGY_SUPPORTED_TYPES actually allows (may drift from PDF — see recapNotes).
 */

const LIVE_RECAP_KEYS = [
  "AF_SMC", "AF_WYCKOFF", "AF_VSA",
  "TS_TF", "TS_MS", "TS_VP",
  "MD_MR", "MD_SD", "MD_SA",
  "BS_BR", "BS_ICT", "BS_LS",
];

const STRATEGY_RECAP_CATALOG = {
  AF_SMC: {
    pdfName: "Smart Money Concepts — SMC",
    concept:
      "Liquidity sweeps, BOS/CHoCH, displacement, order blocks, fair value gaps, premium/discount.",
    indicators: "Market structure, swing H/L, session H/L, volume, OI (partial), CVD (partial).",
    pdfTradeType: "Scalping, Intraday, Swing",
    runtimeTradeTypes: ["Scalping", "Intraday", "Swing"],
    recapStatus: "partial",
    recapNotes:
      "Sprint 14 factory reset: all 3 trade types (Scalping 5m/1h, Intraday 15m/4h, Swing 4h/1w) exposed in Advance backtest. Unproven legs are backtest-only (not auto-live) until 5-window walk-forward passes.",
  },
  AF_WYCKOFF: {
    pdfName: "Wyckoff Method",
    concept:
      "Accumulation, markup, distribution, markdown; spring and upthrust detection in trading ranges.",
    indicators: "Price, volume, range width, effort vs result (volume confirmation).",
    pdfTradeType: "Intraday, Swing",
    runtimeTradeTypes: ["Scalping", "Intraday", "Swing"],
    recapStatus: "partial",
    recapNotes:
      "Sprint 14 factory reset: all 3 trade types (Scalping 5m/1h, Intraday 15m/4h, Swing 4h/1w) exposed in Advance backtest. Unproven legs are backtest-only (not auto-live) until 5-window walk-forward passes.",
  },
  AF_VSA: {
    pdfName: "Volume Spread Analysis — VSA",
    concept: "Volume relative to spread and close — effort vs result conviction.",
    indicators: "Volume, candle spread, relative volume ratio.",
    pdfTradeType: "Intraday, Swing",
    runtimeTradeTypes: ["Scalping", "Intraday", "Swing"],
    recapStatus: "partial",
    recapNotes:
      "Sprint 14 factory reset: all 3 trade types (Scalping 5m/1h, Intraday 15m/4h, Swing 4h/1w) exposed in Advance backtest. Unproven legs are backtest-only (not auto-live) until 5-window walk-forward passes.",
  },
  TS_TF: {
    pdfName: "Trend Following",
    concept: "Follow confirmed trend direction after structure and momentum align.",
    indicators: "EMA/SMA stack, Donchian channel, ADX, ATR.",
    pdfTradeType: "Intraday, Swing",
    runtimeTradeTypes: ["Scalping", "Intraday", "Swing"],
    recapStatus: "implemented",
    recapNotes:
      "Sprint 14 factory reset: all 3 trade types (Scalping 5m/1h, Intraday 15m/4h, Swing 4h/1w) exposed in Advance backtest. Unproven legs are backtest-only (not auto-live) until 5-window walk-forward passes.",
  },
  TS_MS: {
    pdfName: "Dow Theory / Market Structure",
    concept: "Higher-high/higher-low (or lower-low/lower-high) swing structure pullbacks.",
    indicators: "Price structure, volume, multi-timeframe alignment.",
    pdfTradeType: "Swing, Position",
    runtimeTradeTypes: ["Scalping", "Intraday", "Swing"],
    recapStatus: "partial",
    recapNotes:
      "Sprint 14 factory reset: all 3 trade types (Scalping 5m/1h, Intraday 15m/4h, Swing 4h/1w) exposed in Advance backtest. Unproven legs are backtest-only (not auto-live) until 5-window walk-forward passes.",
  },
  TS_VP: {
    pdfName: "Auction Market Theory",
    concept: "Balance vs imbalance; trade from value-area edges and session auction.",
    indicators: "Session VWAP, value-area proxy (Market Profile partial).",
    pdfTradeType: "Intraday",
    runtimeTradeTypes: ["Scalping", "Intraday", "Swing"],
    recapStatus: "partial",
    recapNotes:
      "Sprint 14 factory reset: all 3 trade types (Scalping 5m/1h, Intraday 15m/4h, Swing 4h/1w) exposed in Advance backtest. Unproven legs are backtest-only (not auto-live) until 5-window walk-forward passes.",
  },
  MD_MR: {
    pdfName: "Mean Reversion",
    concept: "Price tends to revert toward mean / fair value after extension.",
    indicators: "VWAP, Bollinger Bands, RSI, z-score (entry-TF).",
    pdfTradeType: "Scalping, Intraday",
    runtimeTradeTypes: ["Scalping", "Intraday", "Swing"],
    recapStatus: "implemented",
    recapNotes:
      "Sprint 14 factory reset: all 3 trade types (Scalping 5m/1h, Intraday 15m/4h, Swing 4h/1w) exposed in Advance backtest. Unproven legs are backtest-only (not auto-live) until 5-window walk-forward passes.",
  },
  MD_SD: {
    pdfName: "Supply and Demand",
    concept: "Buyer/seller imbalance zones — demand/supply retest after displacement.",
    indicators: "OB/FVG-style zones, rejection wicks, volume (base-rally schematic partial).",
    pdfTradeType: "Intraday, Swing",
    runtimeTradeTypes: ["Scalping", "Intraday", "Swing"],
    recapStatus: "partial",
    recapNotes:
      "Sprint 14 factory reset: all 3 trade types (Scalping 5m/1h, Intraday 15m/4h, Swing 4h/1w) exposed in Advance backtest. Unproven legs are backtest-only (not auto-live) until 5-window walk-forward passes.",
  },
  MD_SA: {
    pdfName: "Statistical Arbitrage",
    concept:
      "PDF: cross-asset statistical mean reversion. v1: single-symbol z-score vs rolling mean (+ optional BTC residual).",
    indicators:
      "v1: z-score, rolling mean, optional benchmark residual — not full cointegration/correlation/spread pairs.",
    pdfTradeType: "Algo, Intraday, Swing",
    runtimeTradeTypes: ["Scalping", "Intraday", "Swing"],
    recapStatus: "partial",
    recapNotes:
      "Sprint 14 factory reset: all 3 trade types (Scalping 5m/1h, Intraday 15m/4h, Swing 4h/1w) exposed in Advance backtest. Unproven legs are backtest-only (not auto-live) until 5-window walk-forward passes.",
  },
  BS_BR: {
    pdfName: "Breakout Trading",
    concept:
      "Leave consolidation — breakout from range with volume confirmation; implementation adds retest gate.",
    indicators: "Volume, ATR, Bollinger width, range high/low.",
    pdfTradeType: "Scalping → Swing",
    runtimeTradeTypes: ["Scalping", "Intraday", "Swing"],
    recapStatus: "partial",
    recapNotes:
      "Sprint 14 factory reset: all 3 trade types (Scalping 5m/1h, Intraday 15m/4h, Swing 4h/1w) exposed in Advance backtest. Unproven legs are backtest-only (not auto-live) until 5-window walk-forward passes.",
  },
  BS_ICT: {
    pdfName: "ICT-style trading",
    concept: "Liquidity raid, market structure shift, FVG/OTE/kill-zone session entries (subset implemented).",
    indicators: "Session time (kill zones), prior session H/L, FVG, displacement.",
    pdfTradeType: "Especially Intraday",
    runtimeTradeTypes: ["Scalping", "Intraday", "Swing"],
    recapStatus: "partial",
    recapNotes:
      "Sprint 14 factory reset: all 3 trade types (Scalping 5m/1h, Intraday 15m/4h, Swing 4h/1w) exposed in Advance backtest. Unproven legs are backtest-only (not auto-live) until 5-window walk-forward passes.",
  },
  BS_LS: {
    pdfName: "Liquidation/Squeeze Trading",
    concept: "Trade forced liquidation / squeeze dislocations and funding extremes.",
    indicators: "Liquidation proxy (wick displacement), OI, funding rate (fail-open when unavailable).",
    pdfTradeType: "Scalping, Intraday",
    runtimeTradeTypes: ["Scalping", "Intraday", "Swing"],
    recapStatus: "partial",
    recapNotes:
      "Sprint 14 factory reset: all 3 trade types (Scalping 5m/1h, Intraday 15m/4h, Swing 4h/1w) exposed in Advance backtest. Unproven legs are backtest-only (not auto-live) until 5-window walk-forward passes.",
  },
};

function getRecapEntry(key) {
  return STRATEGY_RECAP_CATALOG[key] || null;
}

function formatPdfTradeType(key) {
  const e = getRecapEntry(key);
  return e?.pdfTradeType || null;
}

module.exports = {
  LIVE_RECAP_KEYS,
  STRATEGY_RECAP_CATALOG,
  getRecapEntry,
  formatPdfTradeType,
};
