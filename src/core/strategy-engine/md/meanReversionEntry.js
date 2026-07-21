/**
 * Mean Reversion (MEAN_REVERSION) — standalone entry for MEAN_DRIFT.
 *
 * Pipeline: Component A (BB+RSI+VWAP) → ADX regime gate → OB/FVG precision.
 * Extracted from MeanReversionStrategy (Sprint 15 structure refactor).
 */

"use strict";

const { evaluateAdxRegimeGate } = require("../md/adxRegimeGate");
const { refineMdEntry, resolveMdTakeProfit } = require("../md/orderBlockFvg");
const { calcADX } = require("../../analytics-engine/indicators");

const DEFAULTS = {
  rsiPeriod: 14,
  bbPeriod: 20,
  minVolRatio: 0.7,
  bbStdDevA: 1.5,
  rsiOversoldA: 28,
  rsiOverboughtA: 72,
  bbStdDevB: 2.0,
  rsiOversoldB: 32,
  rsiOverboughtB: 68,
  mdAdxGateEnabled: true,
  mdObFvgEnabled: true,
  mdAdxPeriod: 14,
};

function calculateBollingerBands(closes, period = 20, stdDev = 2.0, endIdx) {
  if (!closes || closes.length < period) return null;

  const idx = endIdx != null ? endIdx : closes.length - 1;
  if (idx < period - 1 || idx >= closes.length) return null;

  const lookback = closes.slice(idx - period + 1, idx + 1);
  const mean = lookback.reduce((a, b) => a + b, 0) / period;

  const variance = lookback.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  const bandwidth = std * stdDev;

  return {
    middle: mean,
    upper: mean + bandwidth,
    lower: mean - bandwidth,
    bandwidth,
    std,
  };
}

function resolveAdx(indicators, lastIdx, config, adxCacheRef) {
  if (Array.isArray(indicators.adx) && indicators.adx[lastIdx] != null) {
    return indicators.adx[lastIdx];
  }
  const highs = indicators.highs;
  const lows = indicators.lows;
  const closes = indicators.closes;
  if (!highs || !lows || !closes || lastIdx < 28) return null;

  if (!adxCacheRef.cache || adxCacheRef.cache.closesRef !== closes) {
    adxCacheRef.cache = {
      closesRef: closes,
      adx: calcADX(highs, lows, closes, config.mdAdxPeriod ?? 14).adx,
    };
  }
  return adxCacheRef.cache.adx[lastIdx] ?? null;
}

/**
 * Main MEAN_REVERSION entry evaluation at lastIdx.
 *
 * @returns {{ signal: 'LONG'|'SHORT'|null, meta: object|null, bbLevels: object|null }}
 */
function evaluateMeanReversionEntry({
  indicators,
  lastIdx,
  config = {},
  defaults = {},
  adxCacheRef = { cache: null },
  ablation = null,
} = {}) {
  const cfg = { ...DEFAULTS, ...defaults, ...config };

  const _abl = (k) => {
    if (ablation && Object.prototype.hasOwnProperty.call(ablation, k)) ablation[k] += 1;
  };
  _abl("evaluated");

  if (lastIdx < 50) {
    _abl("rejWarmup");
    return { signal: null, meta: null, bbLevels: null };
  }

  const closes = indicators.closes || [];
  const rsiValues = indicators.rsi || [];
  const volumes = indicators.volumes || [];
  const highs = indicators.highs || [];
  const lows = indicators.lows || [];
  const opens = indicators.opens || [];

  const atr = indicators.atr?.[lastIdx];
  const volSMA = indicators.volSMA?.[lastIdx];
  if (!atr || !rsiValues[lastIdx] || !volSMA || volSMA <= 0) {
    _abl("rejIndicators");
    return { signal: null, meta: null, bbLevels: null };
  }

  const rsiNow = rsiValues[lastIdx];
  const close = closes[lastIdx];
  const volRatio = (volumes[lastIdx] || 0) / volSMA;

  if (volRatio < cfg.minVolRatio) {
    _abl("rejVolume");
    return { signal: null, meta: null, bbLevels: null };
  }

  const bbA = calculateBollingerBands(closes, cfg.bbPeriod, cfg.bbStdDevA, lastIdx);
  const bbB = calculateBollingerBands(closes, cfg.bbPeriod, cfg.bbStdDevB, lastIdx);
  if (!bbA || !bbB) {
    _abl("rejBb");
    return { signal: null, meta: null, bbLevels: null };
  }

  const vwap = indicators.vwap?.[lastIdx] ?? close;
  const bbLevels = { bbA, bbB, vwap };

  const isCompALong =
    rsiNow < cfg.rsiOversoldA &&
    close < bbA.lower &&
    close < vwap;

  const isCompAShort =
    rsiNow > cfg.rsiOverboughtA &&
    close > bbA.upper &&
    close > vwap;

  const isCompBLong =
    rsiNow < cfg.rsiOversoldB &&
    close < bbB.lower &&
    close < vwap;

  const isCompBShort =
    rsiNow > cfg.rsiOverboughtB &&
    close > bbB.upper &&
    close > vwap;

  let signal = null;
  let component = null;
  let confidence = 0;
  let reason = null;
  let bbForTp = null;

  if (isCompALong) {
    signal = "LONG"; component = "Scalping"; confidence = 65; bbForTp = bbA;
    reason = `Scalping: RSI ${rsiNow.toFixed(1)} < ${cfg.rsiOversoldA}, BB(1.5σ) touch, below VWAP`;
  } else if (isCompAShort) {
    signal = "SHORT"; component = "Scalping"; confidence = 65; bbForTp = bbA;
    reason = `Scalping: RSI ${rsiNow.toFixed(1)} > ${cfg.rsiOverboughtA}, BB(1.5σ) touch, above VWAP`;
  } else if (isCompBLong) {
    signal = "LONG"; component = "Intraday"; confidence = 60; bbForTp = bbB;
    reason = `Intraday: RSI ${rsiNow.toFixed(1)} < ${cfg.rsiOversoldB}, BB(2.0σ) touch, below VWAP`;
  } else if (isCompBShort) {
    signal = "SHORT"; component = "Intraday"; confidence = 60; bbForTp = bbB;
    reason = `Intraday: RSI ${rsiNow.toFixed(1)} > ${cfg.rsiOverboughtB}, BB(2.0σ) touch, above VWAP`;
  }

  if (!signal) {
    _abl("rejTrigger");
    return { signal: null, meta: null, bbLevels };
  }

  let adxGate = { allowed: true, regime: "unknown", confidenceMult: 1, reason: "ADX gate disabled", adx: null };
  if (cfg.mdAdxGateEnabled !== false) {
    const adxVal = resolveAdx(indicators, lastIdx, cfg, adxCacheRef);
    adxGate = evaluateAdxRegimeGate({ adx: adxVal, config: cfg });
    if (!adxGate.allowed) {
      _abl("rejAdxRegime");
      return { signal: null, meta: null, bbLevels };
    }
    confidence = Math.round(confidence * adxGate.confidenceMult);
    reason = `${reason} | ADX:${adxGate.regime}`;
  }

  let obFvg = {
    hasConfluence: false,
    confidenceMult: 1,
    reason: "OB/FVG disabled",
    nearestOb: null,
    nearestFvg: null,
    fvgs: { bullish: [], bearish: [] },
  };
  let tpTarget = { takeProfit: null, source: null, fvg: null };

  if (cfg.mdObFvgEnabled !== false) {
    obFvg = refineMdEntry({
      signal,
      price: close,
      atr,
      opens,
      highs,
      lows,
      closes,
      volumes,
      volSMA: indicators.volSMA,
      lastIdx,
      config: cfg,
    });
    confidence = Math.round(Math.min(100, confidence * obFvg.confidenceMult));
    reason = `${reason} | ${obFvg.hasConfluence ? "OB/FVG✓" : "OB/FVG~"}`;

    tpTarget = resolveMdTakeProfit({
      signal,
      entryPrice: close,
      fvgs: obFvg.fvgs,
      bbMiddle: bbForTp?.middle ?? null,
    });
  }

  const bbForLevels = bbForTp || bbA;
  const vwapDev = vwap > 0 ? ((close - vwap) / vwap) * 100 : null;
  const mrFields = {
    mrRsiValue: rsiNow ?? null,
    mrBbMidLevel: bbForLevels?.middle ?? null,
    mrBbUpperLevel: bbForLevels?.upper ?? null,
    mrBbLowerLevel: bbForLevels?.lower ?? null,
    mrVwapLevel: vwap ?? null,
    mrVwapDeviation: vwapDev,
    mrAdxRegime: adxGate.regime != null
      ? String(adxGate.regime).toUpperCase()
      : null,
  };

  const meta = {
    component,
    winningComponent: "MEAN_REVERSION",
    strategyLabel: "Mean Reversion",
    componentConfidence: confidence,
    marketCond: "MEAN_REVERT",
    reason,
    adxRegime: adxGate.regime,
    adx: adxGate.adx,
    hasObFvgConfluence: obFvg.hasConfluence,
    tpSource: tpTarget.source,
    tpOverride: tpTarget.takeProfit,
    nearestFvg: tpTarget.fvg || obFvg.nearestFvg,
    nearestOb: obFvg.nearestOb,
    _lastBBLevels: bbLevels,
    rsiValue: rsiNow,
    ...mrFields,
  };

  _abl("passed");
  return { signal, meta, bbLevels };
}

module.exports = {
  DEFAULTS,
  calculateBollingerBands,
  evaluateMeanReversionEntry,
};
