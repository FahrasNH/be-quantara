"use strict";

/**
 * Temporary strategy-leg availability gates.
 *
 * liveTradeTypeGate.js answers whether a leg may place real-money orders.
 * This module answers whether a strategy leg should exist in any runtime
 * surface, including backtest and dry-run.
 */

const TRADE_TYPE_ALIASES = Object.freeze({
  A: "Scalping",
  B: "Intraday",
  C: "Swing",
  SCALP: "Scalping",
  SCALPING: "Scalping",
  INTRADAY: "Intraday",
  SWING: "Swing",
});

// Keep the natural risk budget stable when a leg is shelved. A disabled leg
// must disappear from execution/data fetching, but it must not silently donate
// its risk share to the remaining legs.
const NATURAL_TRADE_TYPE_ORDER = Object.freeze(["Scalping", "Intraday", "Swing"]);

// AMT Scalping is negative net of fees in the validated BTC replay. Keep the
// switch hard-closed across backtest, dry-run, and live until revalidated.
const AMT_SCALPING_SHELVED = true;

function normalizeTradeType(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return TRADE_TYPE_ALIASES[raw.toUpperCase()] || null;
}

/** Resolve the leg from explicit type fields or the runtime timeframe. */
function resolveTradeType(config = {}) {
  const candidates = [
    config.tradeType,
    config.tradeTypeName,
    config.type,
    ...(Array.isArray(config.activeComponents) ? config.activeComponents : []),
    ...(Array.isArray(config.enabledComponents) ? config.enabledComponents : []),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeTradeType(candidate);
    if (normalized) return normalized;
  }

  const timeframe = String(
    config.entryTf || config.interval || config.entryTimeframe || "",
  ).trim().toLowerCase();
  if (["1m", "3m", "5m"].includes(timeframe)) return "Scalping";
  if (["15m", "30m", "1h", "2h"].includes(timeframe)) return "Intraday";
  if (["4h", "6h", "8h", "12h", "1d", "3d", "1w"].includes(timeframe)) return "Swing";
  return null;
}

function isAmtScalpingShelved(config = {}) {
  return AMT_SCALPING_SHELVED && resolveTradeType(config) === "Scalping";
}

function isAmtStrategyKey(strategyKey) {
  return new Set([
    "AUCTION_MARKET_THEORY",
    "AMT",
    "TS_VP",
    "VOLUME_PROFILE",
  ]).has(String(strategyKey || "").trim().toUpperCase());
}

/** Remove disabled AMT legs before candles are fetched or a leg is executed. */
function filterDisabledTradeTypes(strategyKey, typeOrder) {
  if (!Array.isArray(typeOrder) || !isAmtStrategyKey(strategyKey)) return typeOrder;
  return typeOrder.filter((type) => normalizeTradeType(type) !== "Scalping");
}

/**
 * Resolve the denominator used by the per-type risk ladder.
 *
 * AMT deliberately has only Intraday + Swing in its executable catalog, but
 * its combined risk cap was calibrated against the original 3-leg ladder.
 * Keep Scalping in that denominator while leaving it absent from execution.
 */
function resolveNaturalRiskTypeOrder(strategyKey, requestedOrder) {
  if (isAmtStrategyKey(strategyKey)) return [...NATURAL_TRADE_TYPE_ORDER];
  if (Array.isArray(requestedOrder) && requestedOrder.length) return [...requestedOrder];
  return [...NATURAL_TRADE_TYPE_ORDER];
}

module.exports = {
  AMT_SCALPING_SHELVED,
  NATURAL_TRADE_TYPE_ORDER,
  normalizeTradeType,
  resolveTradeType,
  isAmtScalpingShelved,
  isAmtStrategyKey,
  filterDisabledTradeTypes,
  resolveNaturalRiskTypeOrder,
};
