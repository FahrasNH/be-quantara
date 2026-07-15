/**
 * MeanReversionStrategy.js — Mean Drift (MD_MR): Layered Mean Reversion
 *
 * Pipeline (MD-SUB-01 / MD-SUB-02 / MD-SUB-03):
 *   Component A — Mean Reversion (BB + RSI + VWAP) generates LONG/SHORT
 *   Component B — Auction Market Theory ADX regime gate approve/block
 *   Component C — Order Block + FVG refine entry confidence & TP target
 *
 * Trade types (Component A dual legs):
 *   Scalping: 5m, RSI<28/>72, BB(20, 1.5σ), hold 5-15min, RR 1:2.5
 *   Intraday: 15m, RSI<32/>68, BB(20, 2.0σ), hold 30-90min, RR 1:2
 *
 * Shared gates: Vol SMA, ADX balance/transition, optional OB/FVG confluence.
 */

const StrategyBase = require("../base/StrategyBase");
const { evaluateAdxRegimeGate } = require("../md/adxRegimeGate");
const { refineMdEntry, resolveMdTakeProfit } = require("../md/orderBlockFvg");
const { calcADX } = require("../../analytics-engine/indicators");

class MeanReversionStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "MEAN_REVERSION",
      label: "Mean Reversion (Mean Drift - MD_MR)",
      description:
        "Layered mean reversion: BB+RSI entry → ADX regime gate → OB/FVG precision. " +
        "Scalping (5m): RSI<28, BB(1.5σ). Intraday (15m): RSI<32, BB(2.0σ). " +
        "Optimal for MINT tier. RR 1:2.5 (Scalping), 1:2 (Intraday).",
      version: "3.0.0",
      enabled: true,
      ...config,
    });

    this.config = {
      ...this.config,
      // ═══ SHARED SETTINGS ═════════════════════════════════════════════════
      rsiPeriod: 14,
      bbPeriod: 20,
      volSMAPeriod: 20,
      minVolRatio: 0.7,
      atrMult: 1.4,
      leverage: 1.0,
      riskPerTrade: 0.008,    // 0.8% per trade (split 0.4% A + 0.4% B)

      // ═══ COMPONENT A: SCALPING (5m) ════════════════════════════════════
      bbStdDevA: 1.5,
      rsiOversoldA: 28,
      rsiOverboughtA: 72,
      tpMultiplierA: 2.5,
      holdMinutesA: 15,
      trailingStopAtrMultA: 0.3,

      // ═══ COMPONENT A: INTRADAY (15m) ════════════════════════════════════
      bbStdDevB: 2.0,
      rsiOversoldB: 32,
      rsiOverboughtB: 68,
      tpMultiplierB: 2.0,
      holdMinutesB: 90,
      trailingStopAtrMultB: 0,

      // ═══ COMPONENT B: ADX REGIME GATE (MD-SUB-01) ═══════════════════════
      mdAdxBalanceMax: 20,
      mdAdxImbalanceMin: 25,
      mdAdxTransitionConfidenceMult: 0.75,
      mdAdxGateEnabled: true,

      // ═══ COMPONENT C: OB/FVG PRECISION (MD-SUB-02) ══════════════════════
      mdObFvgEnabled: true,
      mdConfluenceAtrMult: 0.5,
      mdNoConfluenceConfidenceMult: 0.7,
      mdWithConfluenceConfidenceBoost: 1.1,
      mdFvgScanBars: 30,
      mdFvgMinGapPct: 0.002,
      mdObLookback: 20,
      mdObDispMult: 1.5,

      // Position management
      maxTradesPerDay: 5,
      minVotes: 1,
      maxConcurrentTrades: 3,
    };

    this._lastBBLevels = null;
    this._adxCache = null; // { closesRef, adx[] } — avoid O(n²) recalc in backtests
  }

  /**
   * Calculate Bollinger Bands
   * Returns: { middle, upper, lower, bandwidth, std }
   */
  calculateBollingerBands(closes, period = 20, stdDev = 2.0) {
    if (!closes || closes.length < period) return null;

    const lookback = closes.slice(-period);
    const mean = lookback.reduce((a, b) => a + b, 0) / period;

    const variance = lookback.reduce((sum, val) => {
      return sum + Math.pow(val - mean, 2);
    }, 0) / period;

    const std = Math.sqrt(variance);
    const bandwidth = std * stdDev;

    return {
      middle: mean,
      upper: mean + bandwidth,
      lower: mean - bandwidth,
      bandwidth: bandwidth,
      std: std,
    };
  }

  /**
   * Resolve ADX at lastIdx — prefer precomputed indicators.adx, else compute once.
   */
  _resolveAdx(indicators, lastIdx, config = {}) {
    if (Array.isArray(indicators.adx) && indicators.adx[lastIdx] != null) {
      return indicators.adx[lastIdx];
    }
    const highs = indicators.highs;
    const lows = indicators.lows;
    const closes = indicators.closes;
    if (!highs || !lows || !closes || lastIdx < 28) return null;

    // Cache per closes array reference (backtest reuses same arrays)
    if (!this._adxCache || this._adxCache.closesRef !== closes) {
      this._adxCache = {
        closesRef: closes,
        adx: calcADX(highs, lows, closes, config.mdAdxPeriod ?? 14).adx,
      };
    }
    return this._adxCache.adx[lastIdx] ?? null;
  }

  /**
   * Main signal detection — A → B → C layered pipeline.
   */
  detectSignal(indicators, lastIdx, config = {}) {
    // Need ≥50 bars for stable indicators (20-period BB + 14-period RSI)
    if (lastIdx < 50) return null;

    const closes = indicators.closes || [];
    const rsiValues = indicators.rsi || [];
    const volumes = indicators.volumes || [];
    const highs = indicators.highs || [];
    const lows = indicators.lows || [];
    const opens = indicators.opens || [];

    const atr = indicators.atr?.[lastIdx];
    const volSMA = indicators.volSMA?.[lastIdx];
    if (!atr || !rsiValues[lastIdx] || !volSMA || volSMA <= 0) return null;

    const rsiNow = rsiValues[lastIdx];
    const close = closes[lastIdx];
    const volRatio = (volumes[lastIdx] || 0) / volSMA;

    // Volume gate — reject dead markets
    if (volRatio < this.config.minVolRatio) return null;

    const bbA = this.calculateBollingerBands(closes, this.config.bbPeriod, this.config.bbStdDevA);
    const bbB = this.calculateBollingerBands(closes, this.config.bbPeriod, this.config.bbStdDevB);
    if (!bbA || !bbB) return null;

    const vwap = indicators.vwap?.[lastIdx] ?? close;
    this._lastBBLevels = { bbA, bbB, vwap };

    // ═══ COMPONENT A: BB + RSI + VWAP ═════════════════════════════════════
    const isCompALong =
      rsiNow < this.config.rsiOversoldA &&
      close < bbA.lower &&
      close < vwap;

    const isCompAShort =
      rsiNow > this.config.rsiOverboughtA &&
      close > bbA.upper &&
      close > vwap;

    const isCompBLong =
      rsiNow < this.config.rsiOversoldB &&
      close < bbB.lower &&
      close < vwap;

    const isCompBShort =
      rsiNow > this.config.rsiOverboughtB &&
      close > bbB.upper &&
      close > vwap;

    let signal = null, component = null, confidence = 0, reason = null;
    let bbForTp = null;
    if (isCompALong) {
      signal = "LONG"; component = "Scalping"; confidence = 65; bbForTp = bbA;
      reason = `Scalping: RSI ${rsiNow.toFixed(1)} < ${this.config.rsiOversoldA}, BB(1.5σ) touch, below VWAP`;
    } else if (isCompAShort) {
      signal = "SHORT"; component = "Scalping"; confidence = 65; bbForTp = bbA;
      reason = `Scalping: RSI ${rsiNow.toFixed(1)} > ${this.config.rsiOverboughtA}, BB(1.5σ) touch, above VWAP`;
    } else if (isCompBLong) {
      signal = "LONG"; component = "Intraday"; confidence = 60; bbForTp = bbB;
      reason = `Intraday: RSI ${rsiNow.toFixed(1)} < ${this.config.rsiOversoldB}, BB(2.0σ) touch, below VWAP`;
    } else if (isCompBShort) {
      signal = "SHORT"; component = "Intraday"; confidence = 60; bbForTp = bbB;
      reason = `Intraday: RSI ${rsiNow.toFixed(1)} > ${this.config.rsiOverboughtB}, BB(2.0σ) touch, above VWAP`;
    }

    if (!signal) { this._lastSignalMeta = null; return null; }

    const merged = { ...this.config, ...config };

    // ═══ COMPONENT B: ADX REGIME GATE ═════════════════════════════════════
    let adxGate = { allowed: true, regime: "unknown", confidenceMult: 1, reason: "ADX gate disabled", adx: null };
    if (merged.mdAdxGateEnabled !== false) {
      const adxVal = this._resolveAdx(indicators, lastIdx, merged);
      adxGate = evaluateAdxRegimeGate({ adx: adxVal, config: merged });
      if (!adxGate.allowed) {
        this._lastSignalMeta = null;
        return null;
      }
      confidence = Math.round(confidence * adxGate.confidenceMult);
      reason = `${reason} | ADX:${adxGate.regime}`;
    }

    // ═══ COMPONENT C: OB/FVG ENTRY + TP PRECISION ═════════════════════════
    let obFvg = {
      hasConfluence: false,
      confidenceMult: 1,
      reason: "OB/FVG disabled",
      nearestOb: null,
      nearestFvg: null,
      fvgs: { bullish: [], bearish: [] },
    };
    let tpTarget = { takeProfit: null, source: null, fvg: null };

    if (merged.mdObFvgEnabled !== false) {
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
        config: merged,
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
    // Sprint 15: flat mr* ML fields
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
    this._lastSignalMeta = {
      component,
      winningComponent: "MD_MR",
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
      _lastBBLevels: this._lastBBLevels,
      rsiValue: rsiNow,
      ...mrFields,
    };
    return signal;
  }

  /** Component/context of the most recent detectSignal (real-engine + live parity). */
  getLastSignalMeta() {
    return this._lastSignalMeta || null;
  }

  /**
   * Calculate SL/TP based on component and ATR.
   * When Component C set a FVG/BB-middle TP override, use it if it still
   * clears a minimum RR floor (0.8× default RR); otherwise keep RR TP.
   */
  calculateRiskConfig(entryPrice, atr, signal, component = null, _opts = {}) {
    const comp = component || (typeof signal === "object" ? signal.component : null) || "Intraday";
    const isComponentA = comp === "Scalping" || comp === "A";
    const side = typeof signal === "object" ? signal.signal : signal;

    const slDist = atr * this.config.atrMult;
    const tpMultiplier = isComponentA ? this.config.tpMultiplierA : this.config.tpMultiplierB;
    let tpDist = slDist * tpMultiplier;
    let tpSource = "rr";

    const meta = this._lastSignalMeta;
    if (meta?.tpOverride != null && Number.isFinite(meta.tpOverride)) {
      const overrideDist = Math.abs(meta.tpOverride - entryPrice);
      // Accept override when it is at least 50% of the RR target (realistic liquidity)
      // and still beyond SL distance (positive expectancy vs fees).
      if (overrideDist >= slDist * 0.5 && overrideDist >= tpDist * 0.5) {
        tpDist = overrideDist;
        tpSource = meta.tpSource || "override";
      }
    }

    let stopLoss, takeProfit;
    if (side === "LONG") {
      stopLoss = entryPrice - slDist;
      takeProfit = entryPrice + tpDist;
    } else {
      stopLoss = entryPrice + slDist;
      takeProfit = entryPrice - tpDist;
    }

    // If override was accepted and points the right way, snap TP exactly
    if (tpSource !== "rr" && meta?.tpOverride != null) {
      const ok =
        (side === "LONG" && meta.tpOverride > entryPrice) ||
        (side === "SHORT" && meta.tpOverride < entryPrice);
      if (ok) takeProfit = meta.tpOverride;
    }

    return {
      stopLoss: parseFloat(stopLoss.toFixed(8)),
      takeProfit: parseFloat(takeProfit.toFixed(8)),
      riskReward: parseFloat((tpDist / slDist).toFixed(2)),
      slDistance: slDist,
      tpDistance: tpDist,
      component: isComponentA ? "Scalping" : "Intraday",
      holdMinutes: isComponentA ? this.config.holdMinutesA : this.config.holdMinutesB,
      trailingStopMult: isComponentA ? this.config.trailingStopAtrMultA : this.config.trailingStopAtrMultB,
      tpSource,
    };
  }

  /**
   * Validate market condition
   * Mean reversion works best in choppy/sideways (weak trend)
   */
  validateMarketCondition(volatility = 0, trendStrength = 0) {
    const atrPct = volatility;

    if (atrPct < 0.5) {
      return { valid: false, reason: `Market too dead (ATR ${atrPct.toFixed(2)}% < 0.5%)` };
    }

    if (atrPct > 6) {
      return { valid: false, reason: `Market too volatile (ATR ${atrPct.toFixed(2)}% > 6%)` };
    }

    if (trendStrength > 0.7) {
      return { valid: false, reason: `Market too trending (strength ${trendStrength.toFixed(2)} > 0.7), use trend strategy` };
    }

    if (trendStrength < 0.2) {
      return { valid: true, reason: "Choppy market - IDEAL for mean reversion" };
    }

    return { valid: true, reason: "Market suitable for mean reversion" };
  }

  /**
   * Rank strategy by market conditions
   */
  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 0, trendStrength = 0 } = marketConditions;

    let score = 50;

    if (trendStrength < 0.3) score += 30;
    else if (trendStrength < 0.5) score += 15;
    else if (trendStrength > 0.7) score -= 30;

    if (volatility >= 1.0 && volatility <= 4.0) score += 20;
    else if (volatility > 5) score -= 15;
    else if (volatility < 0.5) score -= 15;

    return this.clamp(score, 0, 100);
  }

  getRiskConfig() {
    return {
      riskPerTrade: this.config.riskPerTrade,
      maxRiskPerTrade: 0.02,
      maxDailyLossPct: 0.05,
      maxTradesPerDay: this.config.maxTradesPerDay,
      cooldownAfterLoss: 15,
      maxConsecLoss: 2,
      leverage: this.config.leverage,
    };
  }

  getTimeframeConfig() {
    return {
      interval: "5m",
      higherTf: null,
      checkInterval: 300000,
      components: [
        { id: "A", interval: "5m", holdMinutes: 15 },
        { id: "B", interval: "15m", holdMinutes: 90 },
      ],
    };
  }

  validateEntry(price, atr, volume, volSMA) {
    if (!price || !atr) return { valid: true, reason: "Data tidak lengkap — lewati gate" };
    const atrPct   = (atr / price) * 100;
    const volRatio = volSMA > 0 ? volume / volSMA : 1;
    if (atrPct < 0.15 || atrPct > 4.0) {
      return { valid: false, reason: `ATR ${atrPct.toFixed(2)}% di luar rentang sehat (0.15–4.0%)` };
    }
    if (volRatio < 0.5) {
      return { valid: false, reason: `Volume ${volRatio.toFixed(2)}× di bawah ambang (0.5×)` };
    }
    return { valid: true, reason: "Entry conditions met" };
  }

  getConfig() {
    return this.config;
  }

  setConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }
}

module.exports = MeanReversionStrategy;
