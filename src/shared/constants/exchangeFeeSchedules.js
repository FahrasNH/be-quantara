/**
 * SSOT fee schedules for backtest cost modeling by candle venue.
 *
 * Rates are retail (non-VIP) USDT-M futures defaults as of mid-2026 docs —
 * not VIP/market-maker tiers. Funding is a conservative typical perpetual
 * cost model (~0.01%/8h), not a live funding-rate feed.
 *
 * Used by RealStrategyBacktestService + Advance candle-exchange override so
 * fee assumptions track the OHLCV source, not a Bitget-only hardcode.
 */

"use strict";

const SUPPORTED_EXCHANGES = ["bitget", "okx", "binance"];

/**
 * @typedef {Object} ExchangeFeeSchedule
 * @property {string} exchange
 * @property {string} label
 * @property {number} takerFeeRate  - per side (fraction of notional)
 * @property {number} makerFeeRate  - per side
 * @property {number} fundingRate8h - typical funding accrual rate per 8h
 * @property {string} notes
 */

/** @type {Record<string, ExchangeFeeSchedule>} */
const FEE_SCHEDULES = Object.freeze({
  bitget: Object.freeze({
    exchange: "bitget",
    label: "Bitget",
    takerFeeRate: 0.0006, // 0.06%/side — Bitget USDT-M retail taker
    makerFeeRate: 0.0002, // 0.02%/side
    fundingRate8h: 0.0001, // ~0.01%/8h conservative model
    notes: "Bitget USDT-M futures retail default (non-VIP). Roundtrip taker ≈ 0.12%.",
  }),
  okx: Object.freeze({
    exchange: "okx",
    label: "OKX",
    takerFeeRate: 0.0005, // 0.05%/side — OKX swap retail taker
    makerFeeRate: 0.0002, // 0.02%/side
    fundingRate8h: 0.0001,
    notes: "OKX USDT-margined swap retail default (non-VIP). Roundtrip taker ≈ 0.10%.",
  }),
  binance: Object.freeze({
    exchange: "binance",
    label: "Binance",
    takerFeeRate: 0.0004, // 0.04%/side — Binance USDT-M retail taker
    makerFeeRate: 0.0002, // 0.02%/side
    fundingRate8h: 0.0001,
    notes: "Binance USDT-M futures retail default (non-VIP). Roundtrip taker ≈ 0.08%.",
  }),
});

const DEFAULT_EXCHANGE = "bitget";

/**
 * Normalize exchange id; unsupported → null.
 * @param {string} [exchangeType]
 * @returns {string|null}
 */
function normalizeExchangeType(exchangeType) {
  const type = String(exchangeType || "").toLowerCase().trim();
  return SUPPORTED_EXCHANGES.includes(type) ? type : null;
}

/**
 * Resolve fee schedule for an exchange. Falls back to Bitget (historical default).
 * @param {string} [exchangeType]
 * @returns {ExchangeFeeSchedule}
 */
function resolveFeeSchedule(exchangeType) {
  const type = normalizeExchangeType(exchangeType) || DEFAULT_EXCHANGE;
  return FEE_SCHEDULES[type];
}

/**
 * Roundtrip taker fee fraction (entry+exit), for UI labels.
 * @param {string} [exchangeType]
 * @returns {number}
 */
function roundtripTakerFee(exchangeType) {
  const s = resolveFeeSchedule(exchangeType);
  return s.takerFeeRate * 2;
}

module.exports = {
  SUPPORTED_EXCHANGES,
  FEE_SCHEDULES,
  DEFAULT_EXCHANGE,
  normalizeExchangeType,
  resolveFeeSchedule,
  roundtripTakerFee,
};
