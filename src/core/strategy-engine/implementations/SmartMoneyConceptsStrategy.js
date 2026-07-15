/**
 * SmartMoneyConceptsStrategy.js — v2.0.0 (SMC: Smart Money Concepts)
 *
 * FOUNDRY Tier — 3 Trade Types, each on its own timeframe stack:
 *   Scalping  (type A) : Liquidity sweep + OB + CVD  | entry 1m, confirm 5m,  trend 15m
 *   Intraday  (type B) : CHoCH + OB + EMA trend      | entry 5m, confirm 15m, trend 4h
 *   Swing     (type C) : FVG + Displacement + P/D     | entry 4h, confirm 1d,  trend 1W
 *
 * All three types use the SAME SMC indicators (Liquidity, BOS, CHoCH, OB, FVG,
 * displacement, premium/discount). What differentiates them is the TIMEFRAME.
 * All three run CONCURRENTLY — up to 3 independent open trades simultaneously.
 *
 * References:
 *   FOUNDRY_SAC_COMPLETE_SPECIFICATION.md (2026-06-30)
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const { calcEMA, calcATR } = require("../../analytics-engine/indicators");
const {
  applySmcSessionFilter,
  resolveScalpingGateFlags,
  resolveSwingGateFlags,
  sweetSpotPts,
} = require("../smc/smcScalpGates");
const { normalizeSmcParams } = require("../smc/smcParamCompat");

const EPSILON = 1e-9;

// AF-SWING-V3: per-indicators-object ATR cache (fast/slow period arrays), so the
// ATR-ratio regime check reads O(1) per bar instead of recomputing full-array
// ATR on every bar (same WeakMap-memoization pattern as the TS_TF Donchian fix).
const _swingAtrCache = new WeakMap();

class SmartMoneyConceptsStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "SMART_MONEY_CONCEPTS",
      label: "Smart Money Concepts (SMC) v3.0",
      description:
        "Event-driven SMC sequence engine (v3.0): " +
        "sweep → CHoCH/MSS → displacement/FVG → mitigation → entry. " +
        "Causal, cross-bar structure replicates institutional market reading. " +
        "3 independent trade types: Scalping (5m/1h), Intraday (15m/4h), Swing (4h/1w). " +
        "HTF directional bias; smcUseSequenceEngine flag (default on) for fallback.",
      version: "3.0.0",
      enabled: true,
      ...config,
    });

    // ── Trade type TF configuration (each type runs on its own TF stack) ─────
    // Sprint 14 factory reset — genuine 3-rung ladder (matches backtest TYPE_TF):
    //   Scalping 5m/1h · Intraday 15m/4h · Swing 4h/1w.
    // NOTE: the 5m Scalping leg is NEW and unproven (5m SMC historically WR
    // ~28.6%, below coin-flip) → it is Advance-backtest-only and gated OUT of
    // real live trading by liveTradeTypeGate.js. The previously-live 15m cadence
    // now lives under the Intraday label (proven, live-eligible).
    this.TRADE_TYPE_TF_CONFIG = {
      Scalping: { entryTf: "5m",  confirmTf: "15m", trendTf: "1h" },
      Intraday: { entryTf: "15m", confirmTf: "1h",  trendTf: "4h" },
      Swing:    { entryTf: "4h",  confirmTf: "1d",  trendTf: "1w" },
    };

    // ── Sub-strategy RR/SL/TP multipliers (keyed by type name AND legacy letter) ─
    this.SUB_STRATEGIES = {
      Scalping: { name: "SMC_SCALP",    label: "Scalping",  slMultiplier: 1.0,  tpMultiplier: 4.5  },
      Intraday: { name: "SMC_INTRADAY", label: "Intraday",  slMultiplier: 1.2,  tpMultiplier: 2.16 },
      // PRD aspirational: SL 1.2×ATR / TP 4.0×ATR (RR ≈ 3.33). Live/backtest
      // Planned RR comes from typeOverrides.Swing (Sprint 13 fast-fail SSOT).
      Swing:    { name: "SMC_SWING",    label: "Swing",     slMultiplier: 1.2,  tpMultiplier: 4.0  },
      // Backward-compat aliases (old code that passes "A"/"B"/"C")
      A: { name: "SMC_SCALP",    label: "Scalping",  slMultiplier: 1.0,  tpMultiplier: 4.5  },
      B: { name: "SMC_INTRADAY", label: "Intraday",  slMultiplier: 1.2,  tpMultiplier: 2.16 },
      C: { name: "SMC_SWING",    label: "Swing",     slMultiplier: 1.2,  tpMultiplier: 4.0  },
    };

    // Legacy letter → type name
    this.COMPONENT_TO_TYPE = { A: "Scalping", B: "Intraday", C: "Swing" };

    this.config = normalizeSmcParams(this.config);

    this._lastSignalMeta = null;


    // start via resetAblation(); each gate increments its rejection count so ONE
    // run reports exactly which filter throttles trade frequency. getAblation()
    // returns the histogram for logging. Zero overhead when not being read.
    this._ablation = null;
  }


  resetAblation() {
    this._ablation = {
      seqCandidate: 0,   // bars with an FVG + mitigation (raw setup exists)
      rejByRejection: 0,
      rejByObRetest: 0,  // Sprint 13: OB retest/mitigation required (Scalp+Swing)
      seqSignal: 0,      // sequence produced a signal (passed rejection)
      rejByRegime: 0,    // rawA killed by HTF regime hard-block
      rejByChoch: 0,     // rawA killed by 5m CHoCH validation
      rejBySession: 0,   // Sprint 13: UTC session filter
      rejByFunding: 0,   // Sprint 13 Swing: extreme funding premium
      rejByConf: 0,      // rawA killed by confidence floor
      passed: 0,         // survived ALL gates → a tradeable Scalping signal
    };
  }
  getAblation() { return this._ablation; }
  _abl(key) { if (this._ablation) this._ablation[key]++; }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public interface (matches AdaptiveFusionStrategy for drop-in compatibility)
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Abstract method implementations (required by StrategyBase) ───────────────

  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 1.0, trend_strength = 0.1 } = marketConditions;

    // Scalping thrives in choppy/high-vol markets (sweeps happen in noise)
    let scoreA = 45;
    if (volatility > 1.5)         scoreA += 35;
    if (trend_strength < 0.15)    scoreA += 20;
    if (volatility < 0.5)         scoreA -= 30;

    // Intraday best in moderate trending conditions
    let scoreB = 65;
    if (trend_strength >= 0.2 && trend_strength < 0.6) scoreB += 20;
    if (volatility > 2.0)         scoreB -= 15;

    // Swing best in strong directional trends with clear structure
    let scoreC = 50;
    if (trend_strength >= 0.4)    scoreC += 35;
    if (volatility < 1.5)         scoreC += 15;
    if (volatility > 2.5)         scoreC -= 10;

    return [
      { key: "Scalping", label: "Scalping", score: this.clamp(scoreA, 0, 100) },
      { key: "Intraday", label: "Intraday", score: this.clamp(scoreB, 0, 100) },
      { key: "Swing",    label: "Swing",    score: this.clamp(scoreC, 0, 100) },
    ].sort((a, b) => b.score - a.score);
  }

  canActivate(balance) {
    if (balance < 20) {
      return { allowed: false, reason: `Insufficient capital: need min $20, have $${balance}` };
    }
    return { allowed: true, reason: "Smart Money Concepts strategy can activate" };
  }

  getTimeframeConfig() {
    // Default returns Intraday TF (primary trade type)
    return {
      interval:      "5m",
      higherTf:      "4h",
      checkInterval: 300000,
    };
  }

  /** Return TF config for a specific trade type ("Scalping"|"Intraday"|"Swing"|"A"|"B"|"C"). */
  getTradeTypeTfConfig(typeOrLetter) {
    const type = this.COMPONENT_TO_TYPE[typeOrLetter] || typeOrLetter;
    return this.TRADE_TYPE_TF_CONFIG[type] || null;
  }

  /** Map component letter or type name to display label. */
  getTradeTypeLabel(componentKey) {
    return this.COMPONENT_TO_TYPE[componentKey] || componentKey;
  }

  /** Returns all 3 trade type TF configs for the multi-TF backtest engine. */
  getAllTradeTypeTfConfigs() {
    return this.TRADE_TYPE_TF_CONFIG;
  }

  validateEntry(price, atr, volume, volSMA) {
    const atrPct   = (atr / price) * 100;
    const volRatio = volSMA > 0 ? volume / volSMA : 0;
    if (atrPct < 0.8 || atrPct > 5.0) {
      return { valid: false, reason: `ATR ${atrPct.toFixed(2)}% outside range (0.8–5%)` };
    }
    if (volRatio < 0.5) {
      return { valid: false, reason: `Volume ratio ${volRatio.toFixed(2)}× below threshold (0.5×)` };
    }
    return { valid: true, reason: "Entry conditions met" };
  }

  // ─────────────────────────────────────────────────────────────────────────────

  getRiskConfig() {
    return {
      riskPerTrade:       0.035,
      riskPerTradeStrong: 0.05,
      maxTradesPerDay:    8,
      cooldownAfterLoss:  60,
      maxConsecLoss:      3,
    };
  }

  getConfidenceWeights() {
    return {
      A: { sweep: 30, cvdAlign: 25, obZone: 25, volSurge: 20 },
      B: { choch: 30, trendAlign: 25, obStrength: 25, cvdAlign: 20 },
      C: { fvgQuality: 30, displacement: 25, obConfluence: 25, cvdAccum: 20 },
    };
  }

  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  /**
   * Sequence structural levels from the last detectSignalMulti (sweep/CHoCH/FVG/OB).
   * Used by CSV entryReasons formatter — see strategyReasonFormatters.formatSmcReasons.
   */
  getLastSequenceMeta() {
    return this._lastSequenceMeta || this._lastSignalMeta?.sequenceMeta || null;
  }

  calculateRiskConfig(entryPrice, atr, signal, component = "B", opts = {}) {
    const sub      = this.SUB_STRATEGIES[component] ?? this.SUB_STRATEGIES.B;
    const mul      = opts.strongTrendTPMult ?? 1.0;
    const isStrong = opts.marketCond === "STRONG_TREND" && mul > 1;


    // cfg.tpAtrMult via typeOverrides). Fee-drag lever: Scalping's 1.0×ATR SL
    // on 5m ≈ 0.28% of price, so the ~0.13% round-trip fee costs 0.42R per
    // trade and pushes breakeven WR from 18% to 30%. Widening the SL (with TP
    // scaled to keep RR) shrinks fee-R without touching entry logic.
    const slMultiplier = opts.slMultiplier ?? sub.slMultiplier;
    const tpMultiplier = opts.tpMultiplier ?? sub.tpMultiplier;

    const slDist = atr * slMultiplier;
    let   tpDist = atr * tpMultiplier;
    if (isStrong) tpDist *= mul;

    const stopLoss   = signal === "LONG" ? entryPrice - slDist : entryPrice + slDist;
    const takeProfit = signal === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;

    return {
      stopLoss:    parseFloat(stopLoss.toFixed(8)),
      takeProfit:  parseFloat(takeProfit.toFixed(8)),
      riskReward:  parseFloat((tpDist / slDist).toFixed(2)),
      slMultiplier,
      tpMultiplier: isStrong ? parseFloat((tpMultiplier * mul).toFixed(4)) : tpMultiplier,
      slDistance:  slDist,
      tpDistance:  tpDist,
      component,
      strongTrendTPApplied: isStrong,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SMC Indicator Helpers (all return scalar or null — pure functions)
  // ─────────────────────────────────────────────────────────────────────────────

  _calcCVD(closes, highs, lows, volumes, lastIdx, lookback = 14) {
    let cvd = 0;
    const start = Math.max(0, lastIdx - lookback + 1);
    for (let i = start; i <= lastIdx; i++) {
      const cl = closes[i] ?? 0;
      const hi = highs[i]  ?? cl;
      const lo = lows[i]   ?? cl;
      const range = Math.max(hi - lo, EPSILON);
      const dp = (cl - lo) / range; // 0=bottom, 1=top of bar
      cvd += (dp - 0.5) * (volumes[i] ?? 0);
    }
    return cvd;
  }

  _calcVWAP(closes, highs, lows, volumes, lastIdx, lookback = 14) {
    let sumTPV = 0, sumVol = 0;
    const start = Math.max(0, lastIdx - lookback + 1);
    for (let i = start; i <= lastIdx; i++) {
      const tp = ((highs[i] ?? 0) + (lows[i] ?? 0) + (closes[i] ?? 0)) / 3;
      const v = volumes[i] ?? 0;
      sumTPV += tp * v;
      sumVol += v;
    }
    return sumVol > 0 ? sumTPV / sumVol : (closes[lastIdx] ?? 0);
  }

  // Recent swing highs/lows (left-side only; right-side lookback = leftLook)
  _findRecentSwingHighs(highs, lastIdx, leftLook = 5, scanBars = 30) {
    const out = [];
    const scanStart = Math.max(leftLook, lastIdx - scanBars);
    for (let i = scanStart; i < lastIdx - leftLook; i++) {
      const h = highs[i];
      let ok = true;
      for (let j = Math.max(0, i - leftLook); j < i && ok; j++) {
        if (highs[j] >= h) ok = false;
      }
      if (ok) out.push({ idx: i, price: h });
    }
    return out;
  }

  _findRecentSwingLows(lows, lastIdx, leftLook = 5, scanBars = 30) {
    const out = [];
    const scanStart = Math.max(leftLook, lastIdx - scanBars);
    for (let i = scanStart; i < lastIdx - leftLook; i++) {
      const l = lows[i];
      let ok = true;
      for (let j = Math.max(0, i - leftLook); j < i && ok; j++) {
        if (lows[j] <= l) ok = false;
      }
      if (ok) out.push({ idx: i, price: l });
    }
    return out;
  }

  /**
   * Liquidity sweep: current bar wick exceeds swing level, close snaps back.
   * Bullish sweep → long opportunity (smart money swept lows, absorbed sellers).
   * Bearish sweep → short opportunity.
   */
  _detectSweep(closes, highs, lows, volumes, volSMA, lastIdx, config = {}) {
    const leftLook = config.smcSwingLookback ?? 5;  // keep at 5 (left-side comparison window)
    const scanBars = config.smcSweepScanBars ?? 50;  // 30 → 50 (scan further back for recent swing lows)
    const volMult  = config.smcSweepVolMult  ?? 1.1;

    if (lastIdx < leftLook + 3) return null;

    const cl  = closes[lastIdx];
    const hi  = highs[lastIdx];
    const lo  = lows[lastIdx];
    const vol = volumes[lastIdx] ?? 0;
    const vSMA = volSMA[lastIdx] ?? 1;
    const volSurge = vol > vSMA * volMult;

    const swingLows  = this._findRecentSwingLows(lows,  lastIdx, leftLook, scanBars);
    const swingHighs = this._findRecentSwingHighs(highs, lastIdx, leftLook, scanBars);

    // Bullish sweep: wick below nearest swing low, close recovers above it
    // Relaxed: require volSurge OR recent swing low (removed strict volSurge gate for 1m noise)
    if (swingLows.length > 0) {
      const nearest = swingLows[swingLows.length - 1].price;
      if (lo < nearest && cl > nearest && volSurge) {
        return { type: "bullish", level: nearest, volRatio: vol / vSMA, bars: lastIdx };
      }
    }

    // Bearish sweep: wick above nearest swing high, close falls below it
    if (swingHighs.length > 0) {
      const nearest = swingHighs[swingHighs.length - 1].price;
      if (hi > nearest && cl < nearest && volSurge) {
        return { type: "bearish", level: nearest, volRatio: vol / vSMA, bars: lastIdx };
      }
    }

    return null;
  }

  /**
   * Order Block: last reversal candle before a displacement move.
   * Bullish OB = last bearish candle before big bullish volume surge.
   * Bearish OB = last bullish candle before big bearish volume surge.
   * Returns OB bounds + whether current price is inside the zone.
   */
  _detectOrderBlock(closes, highs, lows, opens, volumes, volSMA, lastIdx, direction, config = {}) {
    const lookback  = config.smcOBLookback ?? 15;
    const dispMult  = config.smcOBDispMult ?? 1.8;

    if (lastIdx < lookback + 3) return null;

    const cl = closes[lastIdx];

    if (direction === "LONG") {
      for (let i = lastIdx - 2; i >= Math.max(1, lastIdx - lookback); i--) {
        const open = opens ? (opens[i] ?? closes[i - 1] ?? closes[i]) : closes[i];
        const isBearishOB = closes[i] < open;
        const nextVol = volumes[i + 1] ?? 0;
        const nextVSMA = volSMA[i + 1] ?? 1;
        const nextBull = closes[i + 1] > closes[i] && nextVol > nextVSMA * dispMult;
        if (isBearishOB && nextBull) {
          const obHigh = highs[i], obLow = lows[i];
          return {
            type: "bullish_OB", high: obHigh, low: obLow, idx: i,
            inZone: cl >= obLow * 0.999 && cl <= obHigh * 1.001,
            strength: nextVol / nextVSMA,
          };
        }
      }
    }

    if (direction === "SHORT") {
      for (let i = lastIdx - 2; i >= Math.max(1, lastIdx - lookback); i--) {
        const open = opens ? (opens[i] ?? closes[i - 1] ?? closes[i]) : closes[i];
        const isBullishOB = closes[i] > open;
        const nextVol = volumes[i + 1] ?? 0;
        const nextVSMA = volSMA[i + 1] ?? 1;
        const nextBear = closes[i + 1] < closes[i] && nextVol > nextVSMA * dispMult;
        if (isBullishOB && nextBear) {
          const obHigh = highs[i], obLow = lows[i];
          return {
            type: "bearish_OB", high: obHigh, low: obLow, idx: i,
            inZone: cl >= obLow * 0.999 && cl <= obHigh * 1.001,
            strength: nextVol / nextVSMA,
          };
        }
      }
    }

    return null;
  }

  /**
   * CHoCH (Change of Character):
   * Bullish CHoCH: market was making lower lows, then current close breaks above
   *   a prior swing high → structural reversal to bullish.
   * Bearish CHoCH: market was making higher highs, then close breaks below
   *   a prior swing low → structural reversal to bearish.
   */
  _detectCHoCH(closes, highs, lows, lastIdx, config = {}) {
    const lookback = config.smcChochLookback ?? 20;
    if (lastIdx < lookback * 2 + 2) return null;

    const half = Math.floor(lookback / 2);
    const cl = closes[lastIdx];

    // Slice older vs recent half of lookback
    const olderH = highs.slice(lastIdx - lookback, lastIdx - half);
    const olderL = lows.slice(lastIdx - lookback, lastIdx - half);
    const recentL = lows.slice(lastIdx - half, lastIdx);

    const prevSwingHigh = Math.max(...olderH);
    const prevSwingLow  = Math.min(...olderL);
    const recentLow     = Math.min(...recentL);

    // Bullish CHoCH: older period had lower lows (downtrend), now close > prev swing high
    if (recentLow < prevSwingLow * 1.005 && cl > prevSwingHigh) {
      return { type: "bullish", swingHigh: prevSwingHigh, prevLow: prevSwingLow };
    }

    const recentH = highs.slice(lastIdx - half, lastIdx);
    const prevSwingLowH = Math.min(...olderL);
    const recentHigh = Math.max(...recentH);

    // Bearish CHoCH: older period had higher highs (uptrend), now close < prev swing low
    if (recentHigh > prevSwingHigh * 0.995 && cl < prevSwingLowH) {
      return { type: "bearish", swingLow: prevSwingLowH, prevHigh: prevSwingHigh };
    }

    return null;
  }

  /**
   * FVG (Fair Value Gap): gap between three consecutive candles where
   * price is expected to return.
   * Bullish FVG: lows[i] > highs[i-2]  (gap above i-2's high)
   * Bearish FVG: highs[i] < lows[i-2]  (gap below i-2's low)
   * Returns most recent qualifying FVG that is still "open" (price hasn't filled it).
   */
  _detectFVG(closes, highs, lows, lastIdx, config = {}, opens = null) {


    // 0.3% gaps are meaningful on 1h, noise-level rare on 5m). Flag-gated.
    if (config.smcFvgAutoThreshold === true) {
      return this._detectFVGAuto(closes, highs, lows, lastIdx, config, opens);
    }
    const minGapPct = config.smcFvgMinGap  ?? 0.003;
    const scanBars  = config.smcFvgScanBars ?? 30;

    const cl = closes[lastIdx];
    const recentFVGs = [];

    for (let i = Math.max(2, lastIdx - scanBars); i <= lastIdx; i++) {
      const refClose = closes[i - 1] || closes[i] || 1;

      // Bullish FVG
      const bullGap = (lows[i] - highs[i - 2]) / refClose;
      if (bullGap > minGapPct) {
        const top = lows[i], bottom = highs[i - 2];
        const midpoint = (top + bottom) / 2;
        const filled = cl < bottom; // price already traded below gap bottom
        recentFVGs.push({ type: "bullish", top, bottom, midpoint, size: bullGap, idx: i, filled });
      }

      // Bearish FVG
      const bearGap = (lows[i - 2] - highs[i]) / refClose;
      if (bearGap > minGapPct) {
        const top = lows[i - 2], bottom = highs[i];
        const midpoint = (top + bottom) / 2;
        const filled = cl > top; // price already traded above gap top
        recentFVGs.push({ type: "bearish", top, bottom, midpoint, size: bearGap, idx: i, filled });
      }
    }

    // Return the most recent unfilled FVG for each direction
    const lastBull = [...recentFVGs].reverse().find(f => f.type === "bullish" && !f.filled);
    const lastBear = [...recentFVGs].reverse().find(f => f.type === "bearish" && !f.filled);

    return { bullish: lastBull || null, bearish: lastBear || null };
  }

  /**
   * A gap only counts when the middle candle's BODY displacement exceeds an
   * adaptive threshold (2× the running mean absolute body) — TF-relative, so
   * "significant imbalance" means the same thing on 5m and 4h. Gaps are also
   * invalidated causally (any later bar trading through the zone kills it),
   * instead of only checking the current close.
   *
   * The running body mean needs bars 1..lastIdx — recomputing per call would be
   * O(n²) across a backtest, so prefix sums are cached per candle-array (LRU).
   */
  _detectFVGAuto(closes, highs, lows, lastIdx, config = {}, opens = null) {
    const scanBars = config.smcFvgScanBars ?? 30;
    if (lastIdx < 2) return { bullish: null, bearish: null };

    // Incremental |body|% prefix: prefix[i] = Σ |bodyΔ(mid candle of bar i)|, i ≥ 1.
    if (!this._fvgBodyCaches) this._fvgBodyCaches = new Map();
    let bc = this._fvgBodyCaches.get(closes);
    if (!bc) {
      bc = { prefix: [0, 0], len: 1 }; // prefix[0] unused, prefix[1] = 0-start
      this._fvgBodyCaches.delete(closes);
      if (this._fvgBodyCaches.size >= 4) {
        this._fvgBodyCaches.delete(this._fvgBodyCaches.keys().next().value);
      }
      this._fvgBodyCaches.set(closes, bc);
    }
    for (let i = bc.len; i <= lastIdx; i++) {
      const midOpen = opens?.[i - 1] ?? closes[i - 2] ?? closes[i - 1];
      const midClose = closes[i - 1];
      const bodyDelta = Math.abs((midClose - midOpen) / Math.max(Math.abs(midOpen), EPSILON));
      bc.prefix[i] = (bc.prefix[i - 1] ?? 0) + bodyDelta;
    }
    if (lastIdx >= bc.len) bc.len = lastIdx + 1;

    const startIdx = Math.max(2, lastIdx - scanBars);
    let lastBull = null, lastBear = null;

    for (let i = lastIdx; i >= startIdx && (!lastBull || !lastBear); i--) {
      const midOpen = opens?.[i - 1] ?? closes[i - 2] ?? closes[i - 1];
      const midClose = closes[i - 1];
      const bodyDelta = (midClose - midOpen) / Math.max(Math.abs(midOpen), EPSILON);
      const threshold = ((bc.prefix[i] ?? 0) / Math.max(i, 1)) * 2;
      const ref = Math.max(Math.abs(midClose), EPSILON);

      if (!lastBull && lows[i] > highs[i - 2] && midClose > highs[i - 2] && bodyDelta > threshold) {
        const top = lows[i], bottom = highs[i - 2];
        let invalidated = false;
        for (let j = i + 1; j <= lastIdx; j++) {
          if (lows[j] < bottom) { invalidated = true; break; }
        }
        if (!invalidated) {
          lastBull = {
            type: "bullish", top, bottom, midpoint: (top + bottom) / 2,
            size: (top - bottom) / ref, idx: i, displacementIdx: i - 1, filled: false,
          };
        }
      }

      if (!lastBear && highs[i] < lows[i - 2] && midClose < lows[i - 2] && -bodyDelta > threshold) {
        const top = lows[i - 2], bottom = highs[i];
        let invalidated = false;
        // Full-fill invalidation (symmetric with bullish). The branch used the
        // reference indicator's DISPLAY rule (lower-edge touch kills the box),
        // but the mitigation entry requires price to be inside the zone — that
        // rule would make SHORT sequence entries structurally impossible.
        for (let j = i + 1; j <= lastIdx; j++) {
          if (highs[j] > top) { invalidated = true; break; }
        }
        if (!invalidated) {
          lastBear = {
            type: "bearish", top, bottom, midpoint: (top + bottom) / 2,
            size: (top - bottom) / ref, idx: i, displacementIdx: i - 1, filled: false,
          };
        }
      }
    }

    return { bullish: lastBull, bearish: lastBear };
  }

  /**
   * Displacement candle: high volume + wide range = conviction move.
   * Returns most recent displacement within scanBars.
   */
  _detectDisplacement(closes, highs, lows, volumes, volSMA, lastIdx, config = {}) {
    const scanBars = config.smcDispScanBars ?? 25;
    const volMult  = config.smcDispVolMult  ?? 2.0;
    const rangePct = config.smcDispRangePct ?? 0.012; // 1.2% min range

    for (let i = lastIdx; i >= Math.max(1, lastIdx - scanBars); i--) {
      const cl  = closes[i];
      const hi  = highs[i];
      const lo  = lows[i];
      const vol = volumes[i] ?? 0;
      const vSMA = volSMA[i] ?? 1;
      const range = (hi - lo) / (cl || 1);
      if (range > rangePct && vol > vSMA * volMult) {
        return {
          bullish: closes[i] > (closes[i - 1] ?? closes[i]),
          bearish: closes[i] < (closes[i - 1] ?? closes[i]),
          idx: i,
          barsAgo: lastIdx - i,
          range,
          volRatio: vol / vSMA,
        };
      }
    }
    return null;
  }

  // ═════════════════════════════════════════════════════════════════════════════

  // (ported from feature/smc-strategy-fix d144166, rewritten incremental)
  //
  // Real structure = confirmed pivots (internal size-5, swing size-50) whose
  // levels get CROSSED by a close — that produces BOS/CHoCH events, order
  // blocks, and a trailing swing range (premium/discount). The naive 10-bar
  // high/low comparison in _detectCHoCH fires constantly in chop; this engine
  // is the entry-quality upgrade for the sequence detector.
  //
  // PERFORMANCE CONTRACT: backtest engines call detectSignal once per bar with
  // a shared indicators object — a full O(n) rebuild per bar is the BS_BR
  // O(n²) hang class. The state machine only consumes bars FORWARD, so we
  // cache per candle-array (strategies are singletons → small LRU keyed by
  // the closes reference) and advance only the new bars on each call.
  // ═════════════════════════════════════════════════════════════════════════════

  _structConfigKey(config = {}) {
    return [
      config.smcInternalStructureSize ?? 5,
      config.smcSwingStructureSize ?? 50,
      String(config.smcOrderBlockFilter ?? "ATR").toUpperCase(),
      config.smcOrderBlockAtrLength ?? 200,
      String(config.smcOrderBlockMitigation ?? "HIGHLOW").toUpperCase(),
      config.smcInternalFilterConfluence === true ? 1 : 0,
    ].join("|");
  }

  _getStructureState(indicators, lastIdx, config = {}) {
    const { closes, highs, lows, opens } = indicators;
    if (!this._structCaches) this._structCaches = new Map();
    const cfgKey = this._structConfigKey(config);

    let cache = this._structCaches.get(closes);
    if (!cache || cache.cfgKey !== cfgKey || cache.lastIdx > lastIdx) {
      cache = this._initStructureCache(cfgKey, config);
      this._structCaches.delete(closes);
      // LRU: singletons serve concurrent jobs; keep the map tiny.
      if (this._structCaches.size >= 4) {
        this._structCaches.delete(this._structCaches.keys().next().value);
      }
      this._structCaches.set(closes, cache);
    }

    for (let bar = cache.lastIdx + 1; bar <= lastIdx; bar++) {
      this._structAdvanceBar(cache, bar, closes, highs, lows, opens, config);
    }
    cache.lastIdx = lastIdx;

    const t = cache.trailing;
    const range = t.top != null && t.bottom != null && t.top > t.bottom ? t.top - t.bottom : null;
    const premiumDiscount = range == null ? null : {
      top: t.top,
      bottom: t.bottom,
      eqMid: t.bottom + range * 0.5,
      premium: { low: t.bottom + range * 0.95, high: t.top },
      equilibrium: { low: t.bottom + range * 0.475, high: t.bottom + range * 0.525 },
      discount: { low: t.bottom, high: t.bottom + range * 0.05 },
    };
    return {
      events: cache.events,
      orderBlocks: cache.orderBlocks,
      pivots: cache.pivots,
      trailing: t,
      premiumDiscount,
    };
  }

  _initStructureCache(cfgKey, config = {}) {
    const makeState = (size, internal) => ({
      size, internal, leg: 0, trend: 0,
      high: { currentLevel: null, lastLevel: null, crossed: false, idx: -1, previousSeriesLevel: null },
      low: { currentLevel: null, lastLevel: null, crossed: false, idx: -1, previousSeriesLevel: null },
    });
    return {
      cfgKey,
      lastIdx: -1,
      swing: makeState(Math.max(2, config.smcSwingStructureSize ?? 50), false),
      internal: makeState(Math.max(1, config.smcInternalStructureSize ?? 5), true),
      events: [],
      orderBlocks: [],
      pivots: { internalHighs: [], internalLows: [], swingHighs: [], swingLows: [] },
      trailing: { top: null, bottom: null, barIndex: -1 },
      // parsed-price accumulators (volatility filter for OB zones)
      cumulativeTR: 0,
      atr: null,
      parsedHighs: [],
      parsedLows: [],
    };
  }

  _structAdvanceBar(cache, bar, closes, highs, lows, opens, config = {}) {
    const filter = String(config.smcOrderBlockFilter ?? "ATR").toUpperCase();
    const atrLength = Math.max(1, config.smcOrderBlockAtrLength ?? 200);
    const mitigationMode = String(config.smcOrderBlockMitigation ?? "HIGHLOW").toUpperCase();

    // Parsed prices: high-volatility bars contribute their opposite extreme so
    // OB zones don't anchor to spike wicks (reference-indicator behaviour).
    const hi = highs[bar] ?? 0;
    const lo = lows[bar] ?? hi;
    const prevClose = bar > 0 ? (closes[bar - 1] ?? lo) : lo;
    const tr = bar > 0
      ? Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose))
      : Math.max(hi - lo, 0);
    cache.cumulativeTR += tr;
    if (bar === atrLength - 1) cache.atr = cache.cumulativeTR / atrLength;
    else if (bar >= atrLength && cache.atr != null) cache.atr = ((cache.atr * (atrLength - 1)) + tr) / atrLength;
    const cumulativeMean = cache.cumulativeTR / Math.max(bar, 1);
    const measure = filter === "RANGE" ? cumulativeMean : (cache.atr ?? Infinity);
    const highVolatilityBar = (hi - lo) >= 2 * Math.max(measure, EPSILON);
    cache.parsedHighs[bar] = highVolatilityBar ? lows[bar] : highs[bar];
    cache.parsedLows[bar] = highVolatilityBar ? highs[bar] : lows[bar];

    const trailing = cache.trailing;
    if (trailing.top != null) trailing.top = Math.max(trailing.top, highs[bar] ?? trailing.top);
    if (trailing.bottom != null) trailing.bottom = Math.min(trailing.bottom, lows[bar] ?? trailing.bottom);

    const updateLegAndPivot = (state) => {
      const size = state.size;
      if (bar < size) return;
      const candidate = bar - size;
      let rightHighest = -Infinity;
      let rightLowest = Infinity;
      for (let j = candidate + 1; j <= bar; j++) {
        rightHighest = Math.max(rightHighest, highs[j] ?? -Infinity);
        rightLowest = Math.min(rightLowest, lows[j] ?? Infinity);
      }
      const newLegHigh = (highs[candidate] ?? -Infinity) > rightHighest;
      const newLegLow = (lows[candidate] ?? Infinity) < rightLowest;
      let nextLeg = state.leg;
      if (newLegHigh) nextLeg = 0;
      else if (newLegLow) nextLeg = 1;
      if (nextLeg === state.leg) return;

      if (nextLeg === 1) {
        const p = state.low;
        p.lastLevel = p.currentLevel;
        p.currentLevel = lows[candidate];
        p.crossed = false;
        p.idx = candidate;
        (state.internal ? cache.pivots.internalLows : cache.pivots.swingLows).push({
          idx: candidate, confirmedIdx: bar, price: p.currentLevel, type: "low",
        });
        if (!state.internal) {
          trailing.bottom = p.currentLevel;
          trailing.barIndex = candidate;
        }
      } else {
        const p = state.high;
        p.lastLevel = p.currentLevel;
        p.currentLevel = highs[candidate];
        p.crossed = false;
        p.idx = candidate;
        (state.internal ? cache.pivots.internalHighs : cache.pivots.swingHighs).push({
          idx: candidate, confirmedIdx: bar, price: p.currentLevel, type: "high",
        });
        if (!state.internal) {
          trailing.top = p.currentLevel;
          trailing.barIndex = candidate;
        }
      }
      state.leg = nextLeg;
    };

    const structureConfluenceOk = (direction) => {
      if (config.smcInternalFilterConfluence !== true) return true;
      const open = opens?.[bar] ?? closes[bar - 1] ?? closes[bar];
      const close = closes[bar];
      const upperWick = (highs[bar] ?? close) - Math.max(close, open);
      const lowerWick = Math.min(close, open) - (lows[bar] ?? close);
      return direction === "bullish" ? upperWick > lowerWick : upperWick < lowerWick;
    };

    const storeOrderBlock = (state, direction, pivot, event) => {
      if (pivot.idx < 0 || pivot.idx >= bar) return;
      let obIdx = pivot.idx;
      if (direction === "bullish") {
        let minValue = Infinity;
        for (let i = pivot.idx; i < bar; i++) {
          if ((cache.parsedLows[i] ?? Infinity) < minValue) { minValue = cache.parsedLows[i]; obIdx = i; }
        }
      } else {
        let maxValue = -Infinity;
        for (let i = pivot.idx; i < bar; i++) {
          if ((cache.parsedHighs[i] ?? -Infinity) > maxValue) { maxValue = cache.parsedHighs[i]; obIdx = i; }
        }
      }
      const ob = {
        type: direction === "bullish" ? "bullish_OB" : "bearish_OB",
        bias: direction,
        high: cache.parsedHighs[obIdx],
        low: cache.parsedLows[obIdx],
        idx: obIdx,
        createdIdx: bar,
        internal: state.internal,
      };
      cache.orderBlocks.unshift(ob);
      if (cache.orderBlocks.length > 200) cache.orderBlocks.pop();
      event.orderBlock = ob;
    };

    const processBreak = (state, direction, pivot) => {
      if (pivot.currentLevel == null || pivot.crossed || bar <= 0) return;
      const previousLevel = pivot.previousSeriesLevel ?? pivot.currentLevel;
      const crossed = direction === "bullish"
        ? closes[bar] > pivot.currentLevel && closes[bar - 1] <= previousLevel
        : closes[bar] < pivot.currentLevel && closes[bar - 1] >= previousLevel;
      if (!crossed) return;

      if (state.internal) {
        const swingPivot = direction === "bullish" ? cache.swing.high : cache.swing.low;
        if (swingPivot.currentLevel === pivot.currentLevel) return;
        if (!structureConfluenceOk(direction)) return;
      }

      const isChoch = direction === "bullish" ? state.trend === -1 : state.trend === 1;
      const event = {
        idx: bar,
        type: direction,
        tag: isChoch ? "CHOCH" : "BOS",
        level: pivot.currentLevel,
        pivotIdx: pivot.idx,
        internal: state.internal,
        previousTrend: state.trend,
      };
      cache.events.push(event);
      pivot.crossed = true;
      state.trend = direction === "bullish" ? 1 : -1;
      storeOrderBlock(state, direction, pivot, event);
    };

    updateLegAndPivot(cache.swing);
    updateLegAndPivot(cache.internal);

    processBreak(cache.internal, "bullish", cache.internal.high);
    processBreak(cache.internal, "bearish", cache.internal.low);
    processBreak(cache.swing, "bullish", cache.swing.high);
    processBreak(cache.swing, "bearish", cache.swing.low);

    // Mitigate (remove) order blocks the price has traded through.
    const bearSource = mitigationMode === "CLOSE" ? closes[bar] : highs[bar];
    const bullSource = mitigationMode === "CLOSE" ? closes[bar] : lows[bar];
    cache.orderBlocks = cache.orderBlocks.filter(ob => {
      if (ob.bias === "bearish") return !(bearSource > Math.max(ob.high, ob.low));
      return !(bullSource < Math.min(ob.high, ob.low));
    });

    for (const state of [cache.internal, cache.swing]) {
      state.high.previousSeriesLevel = state.high.currentLevel;
      state.low.previousSeriesLevel = state.low.currentLevel;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // EVENT-DRIVEN SMC SEQUENCE DETECTOR (v3.0)
  //
  // Real institutional SMC is a CAUSAL SEQUENCE across bars, not 3 independent
  // single-bar indicator checks. This detector backward-chains from the current
  // (mitigation) bar and verifies the full ordered sequence:
  //
  //   liquidity sweep  →  CHoCH/MSS  →  displacement (FVG)  →  mitigation  →  ENTRY
  //
  // It only does the expensive backward scan when the current bar is actually
  // sitting inside an unfilled FVG (mitigation) — so the vast majority of bars
  // exit cheaply. Returns { signal, meta } where meta carries the structural
  // levels (sweep extreme, FVG zone) + a 0-100 confidence score.
  // ═════════════════════════════════════════════════════════════════════════════

  _detectSMCSequence(indicators, lastIdx, config = {}) {
    config = normalizeSmcParams(config);
    const { closes, highs, lows, volumes, volSMA } = indicators;
    const opens = indicators.opens;
    const win = config.smcSeqWindow ?? 60;
    if (lastIdx < 25) return { signal: null, meta: null };

    const cl = closes[lastIdx];


    //   smcPivotStructure      — CHoCH from the pivot structure engine's events
    //                            instead of the naive 10-bar high/low compare
    //   smcPremiumDiscountGate — LONG only below equilibrium (discount half),
    //                            SHORT only above (premium half) of the trailing
    //                            swing range: don't buy expensive / sell cheap
    const usePivot = config.smcPivotStructure === true;
    const pdGate = config.smcPremiumDiscountGate === true;
    const structState = (usePivot || pdGate)
      ? this._getStructureState(indicators, lastIdx, config)
      : null;
    const structureType = String(config.smcStructureType ?? "internal").toLowerCase();

    // ── STEP 1: current bar must be mitigating an unfilled FVG ────────────────
    const fvgs = this._detectFVG(closes, highs, lows, lastIdx, config, indicators.opens);

    // Try LONG then SHORT; return the first valid completed sequence.
    for (const dir of ["LONG", "SHORT"]) {
      const isLong = dir === "LONG";
      const expectedType = isLong ? "bullish" : "bearish";
      const fvg = isLong ? fvgs.bullish : fvgs.bearish;
      if (!fvg) continue;

      // Mitigation: price returned into the FVG zone.
      //   LONG  → pullback into discount half [bottom .. midpoint]
      //   SHORT → pullback into premium half  [midpoint .. top]
      const inMitigation = isLong
        ? (cl >= fvg.bottom * 0.999 && cl <= fvg.midpoint * 1.002)
        : (cl <= fvg.top * 1.001    && cl >= fvg.midpoint * 0.998);
      if (!inMitigation) continue;
      this._abl("seqCandidate");


      // Root cause of nol-edge (CSV forensics): the mitigation check above enters
      // the moment CLOSE is anywhere inside the zone — it can't tell "price
      // BOUNCED off the level" (tradeable reversal) from "price is SLICING THROUGH
      // the level" (continuation → instant SL). WR sat exactly on the random-walk
      // line (29.2% @ RR2 vs 33.3% theoretical) = zero predictive edge.
      //
      // Fix: require the entry bar to show a rejection from the level —
      //   LONG  : wicked DOWN into discount, closed back UP (bullish), lower wick
      //           ≥ body (buyers defended the level), close not below zone bottom.
      //   SHORT : wicked UP into premium, closed back DOWN (bearish), upper wick
      //           ≥ body, close not above zone top.
      // Flag-gated (smcRejectionEntry, Scalping-only in backtest) → live unchanged.
      if (config.smcRejectionEntry === true && opens) {
        const op = opens[lastIdx] ?? cl;
        const hi = highs[lastIdx] ?? cl;
        const lo = lows[lastIdx] ?? cl;
        const body = Math.abs(cl - op);
        const wickRatio = config.smcRejectionWickRatio ?? 0.8; // wick ≥ 0.8× body
        if (isLong) {
          const lowerWick = Math.min(op, cl) - lo;
          const wickedIntoZone = lo <= fvg.midpoint;           // touched discount
          const closedBullish  = cl >= op;                     // rejected upward
          const heldZone       = cl >= fvg.bottom;             // not broken below
          const strongReject   = lowerWick >= body * wickRatio;
          if (!(wickedIntoZone && closedBullish && heldZone && strongReject)) { this._abl("rejByRejection"); continue; }
        } else {
          const upperWick = hi - Math.max(op, cl);
          const wickedIntoZone = hi >= fvg.midpoint;           // touched premium
          const closedBearish  = cl <= op;                     // rejected downward
          const heldZone       = cl <= fvg.top;                // not broken above
          const strongReject   = upperWick >= body * wickRatio;
          if (!(wickedIntoZone && closedBearish && heldZone && strongReject)) { this._abl("rejByRejection"); continue; }
        }
      }

      // Premium/discount gate on the trailing swing range. Uses HALVES, not the
      // reference indicator's 5% drawing bands — a 5%-of-range band as an entry
      // gate would starve the leg again (the atrMinMult lesson).
      if (pdGate && structState?.premiumDiscount) {
        const eqMid = structState.premiumDiscount.eqMid;
        if (isLong ? cl > eqMid : cl < eqMid) continue;
      }

      // The FVG is the footprint of the displacement leg. Its origin bar:
      const dispIdx = fvg.idx;

      // ── STEP 2: a CHoCH in our direction must precede the displacement ──────
      let chochIdx = -1;
      if (usePivot) {
        // Pivot-engine events are already accumulated — O(events) reverse scan.
        const events = structState.events;
        for (let e = events.length - 1; e >= 0; e--) {
          const ev = events[e];
          if (ev.idx > dispIdx) continue;
          if (ev.idx < dispIdx - win) break;
          if (ev.tag !== "CHOCH" || ev.type !== expectedType) continue;
          if (structureType === "both" || (structureType === "swing" ? !ev.internal : ev.internal)) {
            chochIdx = ev.idx;
            break;
          }
        }
      } else {
        for (let b = dispIdx; b >= Math.max(25, dispIdx - win); b--) {
          const choch = this._detectCHoCH(closes, highs, lows, b, config);
          if (choch && choch.type === expectedType) { chochIdx = b; break; }
        }
      }
      if (chochIdx < 0) continue;

      // ── STEP 3: a liquidity sweep must precede the CHoCH ────────────────────
      let sweepIdx = -1, sweepExtreme = null;
      for (let b = chochIdx; b >= Math.max(15, chochIdx - win); b--) {
        const sweep = this._detectSweep(closes, highs, lows, volumes, volSMA, b, config);
        if (sweep && sweep.type === expectedType) {
          sweepIdx = b;
          sweepExtreme = isLong ? lows[b] : highs[b];
          break;
        }
      }
      if (sweepIdx < 0) continue;

      // Order-block confluence: entering inside a live OB of our bias.
      let obZone = null;
      let obDistanceAbs = null;
      const liveObs = usePivot ? (structState.orderBlocks || []) : [];
      const matchingOb = liveObs.find(ob =>
        ob.bias === expectedType &&
        cl >= Math.min(ob.low, ob.high) && cl <= Math.max(ob.low, ob.high));
      const obConfluence = !!matchingOb;
      if (matchingOb) {
        obZone = { low: matchingOb.low, high: matchingOb.high, bias: matchingOb.bias };
        obDistanceAbs = 0;
      } else if (liveObs.length) {
        // Nearest same-bias OB distance (for CSV even when not inside)
        let best = Infinity;
        for (const ob of liveObs) {
          if (ob.bias !== expectedType) continue;
          const mid = (ob.low + ob.high) / 2;
          const d = Math.abs(cl - mid);
          if (d < best) {
            best = d;
            obZone = { low: ob.low, high: ob.high, bias: ob.bias };
            obDistanceAbs = d;
          }
        }
      }

      // Causal order guaranteed by construction: sweepIdx ≤ chochIdx ≤ dispIdx ≤ now.
      const isBreakoutBar = lastIdx <= dispIdx;
      const brokeThroughFvg = isLong ? cl > fvg.top * 1.001 : cl < fvg.bottom * 0.999;
      // ── Confidence score from the quality of each leg ──────────────────────
      const scored = this._scoreSequence(indicators, lastIdx, {
        isLong, fvg, dispIdx, chochIdx, sweepIdx, config, obConfluence,
        _isBreakoutBar: isBreakoutBar,
        _brokeThroughFvg: brokeThroughFvg,
      });

      return {
        signal: dir,
        meta: {
          sweepIdx, chochIdx, dispIdx, fvg, sweepExtreme,
          score: scored.score,
          obConfluence,
          obZone,
          obDistanceAbs,
          confidenceComponents: scored.components,
          premiumDiscount: structState?.premiumDiscount ?? null,
          // Stash for Scalping/Swing OB retest gate in detectSignalMulti
          _isBreakoutBar: isBreakoutBar,
          _brokeThroughFvg: brokeThroughFvg,
        },
      };
    }

    return { signal: null, meta: null };
  }

  /**
   * 0-100 confidence for a completed SMC sequence.
   * Returns { score, components } so trade/entryMeta/CSV can log the parts
   * (Sprint 13 — confidence 90–95 had WR ~25%; need component forensics).
   */
  _scoreSequence(indicators, lastIdx, ctx) {
    const { closes, highs, lows, volumes, volSMA } = indicators;
    const { isLong, fvg, dispIdx, chochIdx, sweepIdx } = ctx;
    let score = 40; // slightly lower base — quality bonuses must earn the rest

    // Sweep conviction: volume surge on the sweep bar
    const sVol = volumes[sweepIdx] ?? 0, sVSMA = volSMA[sweepIdx] ?? 1;
    const sweepVolRatio = sVSMA > 0 ? sVol / sVSMA : 1;
    // Sprint 13 inverted-confidence fix: extreme sweep volume (>2.5×) often
    // marks continuation stop-runs (high conf, low WR). Sweet-spot ~1.5×.
    const sweepPts = sweetSpotPts(sweepVolRatio, {
      peak: 1.5, inner: 0.35, outer: 1.8, maxPts: 14, floor: 2,
    });
    score += sweepPts;

    // Displacement strength: range of the FVG-origin bar
    const dRange = ((highs[dispIdx] ?? 0) - (lows[dispIdx] ?? 0)) / (closes[dispIdx] || 1);

    // Sprint 13: ATR-normalize by default (was flag-gated). Absolute % inflated
    // Swing 4h scores vs Scalping and rewarded chase bars. Opt-out: smcScoreAtrNorm=false.
    const useAtrNorm = ctx.config?.smcScoreAtrNorm !== false;
    let atrPct = 0;
    if (useAtrNorm) {
      let trSum = 0, n = 0;
      for (let b = Math.max(1, lastIdx - 13); b <= lastIdx; b++) {
        const prevClose = closes[b - 1] ?? closes[b] ?? 0;
        const tr = Math.max(
          (highs[b] ?? 0) - (lows[b] ?? 0),
          Math.abs((highs[b] ?? 0) - prevClose),
          Math.abs((lows[b] ?? 0) - prevClose),
        );
        trSum += tr; n++;
      }
      atrPct = n > 0 ? (trSum / n) / (closes[lastIdx] || 1) : 0;
    }

    let dispPts = 0;
    const dispAtrMult = atrPct > 0 ? dRange / atrPct : dRange / 0.01;
    if (useAtrNorm && atrPct > 0) {
      // Peak ~1.8×ATR displacement; >3×ATR is chase → taper
      dispPts = sweetSpotPts(dispAtrMult, {
        peak: 1.8, inner: 0.6, outer: 2.5, maxPts: 14, floor: 1,
      });
    } else {
      dispPts = Math.min(15, dRange * 600); // legacy absolute-% path
    }
    score += dispPts;

    // If the FVG-origin bar had below-average volume, the "displacement" may be noise.
    const dVol = volumes[dispIdx] ?? 0, dVSMA = volSMA[dispIdx] ?? 1;
    const dispVolRatio = dVSMA > 0 ? dVol / dVSMA : 1;
    if (dispVolRatio < 1.2) score -= 12; // penalise weak-volume displacement

    // FVG size — moderate imbalance preferred; huge gaps = volatile traps
    let fvgPts = 0;
    const fvgSize = fvg.size || 0;
    const fvgAtrMult = atrPct > 0 ? fvgSize / atrPct : fvgSize / 0.005;
    if (useAtrNorm && atrPct > 0) {
      fvgPts = sweetSpotPts(fvgAtrMult, {
        peak: 0.7, inner: 0.35, outer: 1.8, maxPts: 10, floor: 1,
      });
    } else {
      fvgPts = Math.min(10, fvgSize * 1500);
    }
    score += fvgPts;

    // Mitigation depth: deeper into the zone = better entry (NOT inverted).
    // Prior bug class: breakout bars scored via huge disp/FVG with depth≈0 yet
    // still cleared 75+ — now depth + OB carry more weight, extremes taper.
    const cl = closes[lastIdx];
    const depth = isLong
      ? (fvg.midpoint - cl) / Math.max(fvg.midpoint - fvg.bottom, 1e-9)
      : (cl - fvg.midpoint) / Math.max(fvg.top - fvg.midpoint, 1e-9);
    const depthClamped = Math.max(0, Math.min(1.2, depth));
    const depthPts = Math.round(Math.min(18, depthClamped * 18)); // was ×15, now ×18
    score += depthPts;

    // Reward recent sweeps (≤20 bars = setup is still "alive"), penalise very old ones.
    const sweepAge = lastIdx - sweepIdx;
    if      (sweepAge <= 20) score += 8;   // fresh: full bonus
    else if (sweepAge <= 40) score += 3;   // acceptable
    else                     score -= 8;   // stale: risk of whipsaw

    // OB confluence = institutional footprint (weighted up vs pre-fix +8)
    const obPts = ctx.obConfluence ? 12 : 0;
    if (ctx.obConfluence) score += 12;

    // Breakout / slice-through entries: high raw structure score, poor WR —
    // explicit penalty so race confidence stops preferring them.
    if (ctx._isBreakoutBar || ctx._brokeThroughFvg) score -= 15;

    // HTF alignment is applied later as a soft −15 in detectSignalMulti; record
    // the provisional contribution here (0 until the gate runs). Callers may
    // overwrite confidenceComponents.htfAlignment after the HTF filter.
    const components = {
      sweepStrength: parseFloat(sweepVolRatio.toFixed(4)),
      sweepPts: Math.round(sweepPts),
      fvgSize: parseFloat(fvgSize.toFixed(6)),
      fvgPts: Math.round(fvgPts),
      displacementPct: parseFloat((dRange * 100).toFixed(4)),
      dispPts: Math.round(dispPts),
      mitigationDepth: parseFloat(Math.max(0, depth).toFixed(4)),
      depthPts: Math.round(depthPts),
      obConfluence: !!ctx.obConfluence,
      obPts,
      htfAlignment: 0, // filled in detectSignalMulti after HTF gate
      scoreBase: 40,
      atrNorm: useAtrNorm,
    };

    return {
      score: Math.round(this.clamp(score, 0, 100)),
      components,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Component A — Scalping (Sweep + OB + CVD)  [LEGACY single-bar path]
  // ─────────────────────────────────────────────────────────────────────────────

  _detectSignalA(closes, highs, lows, volumes, volSMA, lastIdx, config = {}) {
    if (lastIdx < 30) return null;

    const sweep = this._detectSweep(closes, highs, lows, volumes, volSMA, lastIdx, config);
    if (!sweep) return null;

    const cvd = this._calcCVD(closes, highs, lows, volumes, lastIdx, config.vwapLookback ?? 14);

    if (sweep.type === "bullish" && cvd > 0) return "LONG";
    if (sweep.type === "bearish" && cvd < 0) return "SHORT";

    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Component B — Intraday (CHoCH + OB + EMA trend)
  // ─────────────────────────────────────────────────────────────────────────────

  _detectSignalB(closes, highs, lows, volumes, volSMA, emaFast, emaSlow, lastIdx, config = {}) {
    if (lastIdx < 40) return null;

    const choch = this._detectCHoCH(closes, highs, lows, lastIdx, config);
    if (!choch) return null;

    const fast = emaFast[lastIdx] ?? 0;
    const slow = emaSlow[lastIdx] ?? 0;

    if (choch.type === "bullish" && fast > slow) return "LONG";
    if (choch.type === "bearish" && fast < slow) return "SHORT";

    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Component C — Swing (FVG + Displacement + price in discount/premium zone)
  // ─────────────────────────────────────────────────────────────────────────────

  _detectSignalC(closes, highs, lows, volumes, volSMA, lastIdx, config = {}) {
    if (lastIdx < 30) return null;

    const cl = closes[lastIdx];
    const fvgs = this._detectFVG(closes, highs, lows, lastIdx, config);
    const disp = this._detectDisplacement(closes, highs, lows, volumes, volSMA, lastIdx, config);

    if (!disp) return null;

    // LONG: bullish displacement + bullish FVG exists + price in 25-50% FVG area (discount zone)
    if (disp.bullish && fvgs.bullish) {
      const fvg = fvgs.bullish;
      const fvg25 = fvg.bottom + 0.25 * (fvg.top - fvg.bottom);
      const fvg50 = fvg.bottom + 0.50 * (fvg.top - fvg.bottom);
      if (cl >= fvg25 * 0.998 && cl <= fvg50 * 1.002) return "LONG";
    }

    // SHORT: bearish displacement + bearish FVG exists + price in 50-75% FVG area (premium zone)
    if (disp.bearish && fvgs.bearish) {
      const fvg = fvgs.bearish;
      const fvg50 = fvg.top - 0.50 * (fvg.top - fvg.bottom);
      const fvg75 = fvg.top - 0.25 * (fvg.top - fvg.bottom);
      if (cl >= fvg50 * 0.998 && cl <= fvg75 * 1.002) return "SHORT";
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Confidence scoring
  // ─────────────────────────────────────────────────────────────────────────────

  _buildConfidenceContext(indicators, lastIdx, config, extraState = {}) {
    const { closes, highs, lows, volumes, volSMA, emaFast, emaSlow } = indicators;
    const opens = indicators.opens;
    const lookback = config.vwapLookback ?? 14;

    const cvd  = this._calcCVD(closes, highs, lows, volumes, lastIdx, lookback);
    const vwap = this._calcVWAP(closes, highs, lows, volumes, lastIdx, lookback);
    const cl   = closes[lastIdx];
    const maxCVD = (volumes[lastIdx] ?? 100) * lookback * 0.5;

    const sweep = this._detectSweep(closes, highs, lows, volumes, volSMA, lastIdx, config);
    const choch = this._detectCHoCH(closes, highs, lows, lastIdx, config);
    const fvgs  = this._detectFVG(closes, highs, lows, lastIdx, config);
    const disp  = this._detectDisplacement(closes, highs, lows, volumes, volSMA, lastIdx, config);
    const obL   = this._detectOrderBlock(closes, highs, lows, opens, volumes, volSMA, lastIdx, "LONG",  config);
    const obS   = this._detectOrderBlock(closes, highs, lows, opens, volumes, volSMA, lastIdx, "SHORT", config);

    const fast = (emaFast ?? [])[lastIdx] ?? 0;
    const slow = (emaSlow ?? [])[lastIdx] ?? 0;

    const vol = (volumes ?? [])[lastIdx] ?? 0;
    const vSMA = (volSMA ?? [])[lastIdx] ?? 1;

    return {
      close: cl, vwap, cvd, maxCVD,
      emaFast: fast, emaSlow: slow,
      volRatio: vol / Math.max(vSMA, EPSILON),
      sweep, choch, fvgBull: fvgs.bullish, fvgBear: fvgs.bearish, disp,
      obLong: obL, obShort: obS,
    };
  }

  _componentConfidence(key, dir, ctx) {
    if (!dir) return 0;
    const W = this.getConfidenceWeights()[key];
    if (!W) return 0;

    const { sweep, choch, fvgBull, fvgBear, disp, obLong, obShort, cvd, maxCVD, volRatio } = ctx;

    const cvdNorm = Math.min(Math.max(Math.abs(cvd) / Math.max(maxCVD, EPSILON), 0), 1);

    if (key === "A") {
      const hasSweep = sweep && (
        (dir === "LONG"  && sweep.type === "bullish") ||
        (dir === "SHORT" && sweep.type === "bearish")
      );
      const cvdAlign = (dir === "LONG" ? cvd > 0 : cvd < 0) ? W.cvdAlign * (0.5 + 0.5 * cvdNorm) : 0;
      const sweepScore = hasSweep ? W.sweep * Math.min(sweep.volRatio / 2.5, 1) : 0;
      const ob = dir === "LONG" ? obLong : obShort;
      const obScore = ob ? (ob.inZone ? W.obZone : W.obZone * 0.4) : 0;
      const volScore = W.volSurge * Math.min(Math.max((volRatio - 1) / 1.5, 0), 1);
      return Math.min(Math.round(sweepScore + cvdAlign + obScore + volScore), 100);
    }

    if (key === "B") {
      const hasChoch = choch && (
        (dir === "LONG"  && choch.type === "bullish") ||
        (dir === "SHORT" && choch.type === "bearish")
      );
      const { emaFast: fast, emaSlow: slow } = ctx;
      const trendOk = (dir === "LONG" ? fast > slow : fast < slow);
      const ob = dir === "LONG" ? obLong : obShort;
      const chochScore = hasChoch ? W.choch : 0;
      const trendScore = trendOk ? W.trendAlign : 0;
      const obScore    = ob ? W.obStrength * Math.min(ob.strength / 3, 1) : 0;
      const cvdScore   = (dir === "LONG" ? cvd > 0 : cvd < 0) ? W.cvdAlign * (0.5 + 0.5 * cvdNorm) : 0;
      return Math.min(Math.round(chochScore + trendScore + obScore + cvdScore), 100);
    }

    if (key === "C") {
      const fvg = dir === "LONG" ? fvgBull : fvgBear;
      const dispOk = disp && (dir === "LONG" ? disp.bullish : disp.bearish);
      const fvgScore  = fvg ? W.fvgQuality * Math.min(fvg.size / 0.01, 1) : 0;
      const dispScore = dispOk ? W.displacement * Math.min(disp.volRatio / 4, 1) : 0;
      const ob = dir === "LONG" ? obLong : obShort;
      const obConflScore = (fvg && ob) ? W.obConfluence : (fvg || ob ? W.obConfluence * 0.4 : 0);
      const cvdScore = (dir === "LONG" ? cvd > 0 : cvd < 0) ? W.cvdAccum * (0.5 + 0.5 * cvdNorm) : 0;
      return Math.min(Math.round(fvgScore + dispScore + obConflScore + cvdScore), 100);
    }

    return 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AF-SWING-V3: entry-TF ATR-ratio + RVOL + confidence-tier no-trade zone
  // (SWING_ENGINE_V3.md improvements 1/7/8/9/11 — regime filter, relative volume
  // filter, ATR expansion filter, adaptive sizing, consolidated no-trade zone).
  // Opt-in via typeOverrides.Swing.smcSwingV3Gate = true; fail-open (returns
  // "pass" state) when indicators lack the history needed, same convention as
  // the existing ADX gate. Does NOT touch the core FVG/displacement/OB entry
  // logic or confidence formula (_detectSignalC / _componentConfidence "C") —
  // those stay exactly as validated (AF_SMC Swing captures 97% planned RR).
  // ─────────────────────────────────────────────────────────────────────────────

  _getCachedATR(indicators, highs, lows, closes, period) {
    let cache = _swingAtrCache.get(indicators);
    if (!cache) { cache = {}; _swingAtrCache.set(indicators, cache); }
    if (!cache[period]) cache[period] = calcATR(highs, lows, closes, period);
    return cache[period];
  }

  /** ATR(fast)/ATR(slow) ratio at lastIdx. null when insufficient history (fail-open). */
  _calcSwingAtrRatio(indicators, lastIdx, fastPeriod = 14, slowPeriod = 100) {
    const { highs, lows, closes } = indicators;
    if (!highs || !lows || !closes || lastIdx < slowPeriod) return null;
    const atrFast = this._getCachedATR(indicators, highs, lows, closes, fastPeriod);
    const atrSlow = this._getCachedATR(indicators, highs, lows, closes, slowPeriod);
    const fastVal = atrFast[lastIdx];
    const slowVal = atrSlow[lastIdx];
    if (fastVal == null || slowVal == null || slowVal <= 0) return null;
    return fastVal / slowVal;
  }

  /**
   * Consolidated Swing No-Trade Zone. Returns { allow, sizeMultiplier, reason,
   * atrRatio, rvol } — never throws, fails open (allow:true, sizeMultiplier:1)
   * when required data is missing so an unconfigured/short-history run behaves
   * exactly like V3 disabled.
   */
  _evaluateSwingV3Gate(indicators, lastIdx, dir, confC, config = {}, typeOverride = {}) {
    if (!typeOverride?.smcSwingV3Gate) return { allow: true, sizeMultiplier: 1 };

    const { volumes, volSMA } = indicators;
    const minAtrRatio = typeOverride.smcSwingMinAtrRatio ?? 0.8;
    const extremeAtrRatio = typeOverride.smcSwingAtrExtremeRatio ?? 2.5;
    const minRvol = typeOverride.smcSwingMinRvol ?? 1.2;
    const noTradeRvol = typeOverride.smcSwingNoTradeRvol ?? 1.0;
    const minConfidence = typeOverride.smcSwingMinConfidenceV3 ?? 70;
    const reduceConfidence = typeOverride.smcSwingReduceConfidenceV3 ?? 60;

    // Improvement 1 (partial) — weekly/HTF regime must be a real trend, not
    // SIDEWAYS/UNKNOWN. Direction-alignment vs htfTrend is already enforced
    // upstream by smcHtfHardBlock/soft-penalty; this only blocks flat regimes.
    const htfTrend = config.htfTrend ?? null;
    if (htfTrend === "SIDEWAYS" || htfTrend === "UNKNOWN") {
      return { allow: false, sizeMultiplier: 0, reason: "regime_flat", htfTrend };
    }

    // Improvement 7 — Relative Volume filter.
    const vol = volumes?.[lastIdx] ?? null;
    const vSMA = volSMA?.[lastIdx] ?? null;
    const rvol = (vol != null && vSMA) ? vol / Math.max(vSMA, EPSILON) : null;
    if (rvol != null && rvol < noTradeRvol) {
      return { allow: false, sizeMultiplier: 0, reason: "rvol_too_low", rvol };
    }

    // Improvement 1 + 8 — ATR expansion filter (regime + extreme-size reduction).
    const atrRatio = this._calcSwingAtrRatio(indicators, lastIdx);
    if (atrRatio != null && atrRatio < minAtrRatio) {
      return { allow: false, sizeMultiplier: 0, reason: "atr_ratio_too_low", atrRatio };
    }

    // Improvement 11/12 — confidence no-trade zone + reduce-risk tier.
    if (confC < reduceConfidence) {
      return { allow: false, sizeMultiplier: 0, reason: "confidence_too_low", confC };
    }

    // Improvement 9 — adaptive sizing: full size once confident, reduced size
    // in the 60-69 "Reduce Risk" band, and RVOL <1.2 (below "Allow" but still
    // above the hard no-trade floor) also trims size rather than blocking.
    let sizeMultiplier = 1;
    if (confC < minConfidence) sizeMultiplier *= 0.5;
    if (rvol != null && rvol < minRvol) sizeMultiplier *= 0.75;
    if (atrRatio != null && atrRatio > extremeAtrRatio) sizeMultiplier *= 0.5;

    return { allow: true, sizeMultiplier, reason: "pass", atrRatio, rvol, confC };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Market regime helpers
  // ─────────────────────────────────────────────────────────────────────────────

  _getMarketCondition(config) {
    const vol = config.volatility ?? 1;
    const trend = config.trend_strength ?? 0;
    if (vol < 0.4 && trend < 0.1) return "DEAD_MARKET";
    if (trend >= 0.40) return "STRONG_TREND";
    if (vol >= 1.0)    return "VOLATILE";
    return "NORMAL";
  }

  _htfDirectionBlocked(dir, htfTrend, strict = false) {
    if (!htfTrend) return false;
    if (strict) {

      // HTF, SHORT needs BEARISH; SIDEWAYS/UNKNOWN = no entry either direction.
      // The legacy branch below is LONG-biased: LONG passes in SIDEWAYS while
      // SHORT is blocked unless BEARISH. Under smcHtfHardBlock that asymmetry
      // produced a 104-LONG book at 11.5% WR (SHORT with-trend book: 20.4%) —
      // LONGs sailed through every falling tape the 0.2% EMA-spread threshold
      // labeled SIDEWAYS.
      if (dir === "LONG")  return htfTrend !== "BULLISH";
      if (dir === "SHORT") return htfTrend !== "BEARISH";
      return false;
    }
    if (dir === "LONG"  && htfTrend === "BEARISH") return true;
    if (dir === "SHORT" && htfTrend !== "BEARISH")  return true;
    return false;
  }

  _detect5mChocH(indicators, lastIdx, config) {

    // Scalping entries are noisy (wick sweeps), but real reversals have swing
    // structure: supply level (swing high) above entry that price breaks below.
    // Gate requires swing high in recent window — blocks false-breakout LONGs.
    const { highs, lows, closes } = indicators;
    if (!highs || !lows || !closes || lastIdx < 20) return false;

    const window = 20;  // ~100 min of 5m candles
    const startIdx = Math.max(0, lastIdx - window);
    const endIdx = lastIdx + 1;

    // Find swing high in the window (exclude last 5 live candles)
    const windowHighs = highs.slice(startIdx, Math.max(startIdx, endIdx - 5));
    if (windowHighs.length === 0) return false;

    const swingHigh = Math.max(...windowHighs);
    const currentPrice = closes[lastIdx];

    // Supply exists if swing high is materially above current price (0.1%)
    // Real structure, not just "any high in candles" (which is always true).
    return swingHigh > currentPrice * 1.001;
  }


  _detectHTFRegime(indicators, config = {}, atIdx = null) {
    if (!indicators || !indicators.closes) return "SIDEWAYS";

    const closes = indicators.closes;
    if (closes.length < 21) return "SIDEWAYS";


    // the whole dataset. The old `closes.length - 1` read the END of the array
    // on every call — in backtest that is (a) look-ahead and (b) a constant:
    // the same regime label was returned for every bar of the run.
    const lastIdx = Number.isInteger(atIdx) ? Math.min(atIdx, closes.length - 1) : closes.length - 1;
    const { bullishThreshold = 0.004, bearishThreshold = -0.004, adxMinStrength = 22 } = config.regimeDetection || {};


    // during indicatorpass). Avoids O(n) recalc per bar. If not available, cache
    // the result in config so subsequent calls in same backtest bar don't recalc.
    let ema9 = indicators.ema9_Regime; // Cache key (per-bar pass)
    let ema21 = indicators.ema21_Regime;
    if (!ema9 || !ema21) {
      ema9  = calcEMA(closes, 9);
      ema21 = calcEMA(closes, 21);
      // Store back to indicators for current bar (avoid recalc if called again)
      if (indicators) {
        indicators.ema9_Regime = ema9;
        indicators.ema21_Regime = ema21;
      }
    }

    if (!ema9 || !ema21 || ema9.length === 0 || ema21.length === 0) return "SIDEWAYS";

    const lastClose = closes[lastIdx];

    // bar, not the array tail (same look-ahead bug as above).
    const ema9Last = ema9[lastIdx];
    const ema21Last = ema21[lastIdx];
    if (ema9Last == null || ema21Last == null) return "SIDEWAYS";

    const emaDiff = (ema9Last - ema21Last) / lastClose;

    // `?? 20` default made `adx > 22` unconditionally FALSE → this function
    // returned SIDEWAYS on every bar → regimeMappingStrict skipped 100% of
    // Intraday entries on every coin. Only apply the ADX gate when ADX data
    // actually exists.
    const adxVal = indicators.adx?.[lastIdx];
    const adxOk = adxVal == null ? true : adxVal > adxMinStrength;

    // BULLISH: EMA gap > threshold AND (ADX confirms, when available)
    if (emaDiff > bullishThreshold && adxOk) {
      return "BULLISH";
    }

    // BEARISH: EMA gap < negative threshold AND (ADX confirms, when available)
    if (emaDiff < bearishThreshold && adxOk) {
      return "BEARISH";
    }

    // Default: SIDEWAYS (weak trend)
    return "SIDEWAYS";
  }


  // Maps entry direction to market regime (BULLISH→LONG only, BEARISH→SHORT only, SIDEWAYS→skip)
  _applyRegimeDirectionMapping(rawSignal, regime, tradeType, config = {}) {
    // Only apply to Intraday leg (v3.1 uses full type names)
    if (tradeType !== "Intraday") return rawSignal;

    // If regime mapping is disabled, pass through
    if (config.regimeMappingStrict !== true) return rawSignal;

    if (regime === "BULLISH") {
      // In bullish regime, only accept LONG entries
      return rawSignal === "LONG" ? "LONG" : null;
    } else if (regime === "BEARISH") {
      // In bearish regime, only accept SHORT entries
      return rawSignal === "SHORT" ? "SHORT" : null;
    } else {
      // SIDEWAYS: skip Intraday entry entirely
      return null;
    }
  }


  // Root cause of the leg's missing edge: rawA (Scalping) and rawB (Intraday)
  // share the SAME raw signal from _detectSMCSequence — the only thing that
  // ever differentiated Scalping's profitability was its CHoCH structure gate
  // (_detect5mChocH/_detect5mMultiChoCH), which rawB never received. Giving
  // Intraday that EXACT same gate (tested 2026-07-07, entry-swap validation)
  // produced 100% trade-entry overlap with Scalping — not a second leg, just
  // Scalping's signal with a different exit. This gate reuses the same
  // swing-high/reversal-count logic but over a window scaled to Intraday's
  // actual holding duration (avg 3-8h at 15m ≈ 12-32 bars, vs Scalping's ~20/5
  // bars tuned for its own much shorter holds) so it filters on genuinely
  // slower structure instead of re-detecting Scalping's fast setups.
  _detectIntradayStructureConfirm(indicators, lastIdx, config = {}) {
    const { highs, lows, closes } = indicators;
    const window = config.intradayStructureWindow ?? 40;      // ~10h of 15m candles
    const multiWindow = config.intradayMultiWindow ?? 10;      // ~2.5h of 15m candles
    const reversalMin = config.intradayReversalMin ?? 3;
    const rangeThreshold = config.intradayRangeThreshold ?? 0.01; // 1%
    if (!highs || !lows || !closes || lastIdx < window) return false;

    // Range check: price must sit genuinely INSIDE a structural range (swing
    // high above AND swing low below, both beyond rangeThreshold) — an OR
    // check here is a near no-op (some 0.1%-away extreme exists in almost any
    // window of real price data, measured pass rate 93-100% on synthetic
    // data). Requiring BOTH sides at a real % distance is what actually
    // discriminates range/reversal structure from trending noise.
    const startIdx = Math.max(0, lastIdx - window);
    const endIdx = lastIdx + 1;
    const bodyEnd = Math.max(startIdx, endIdx - multiWindow);
    const windowHighs = highs.slice(startIdx, bodyEnd);
    const windowLows = lows.slice(startIdx, bodyEnd);
    if (windowHighs.length === 0 || windowLows.length === 0) return false;
    const swingHigh = Math.max(...windowHighs);
    const swingLow = Math.min(...windowLows);
    const currentPrice = closes[lastIdx];
    const hasSwingLevel = swingHigh > currentPrice * (1 + rangeThreshold)
      && currentPrice > swingLow * (1 - rangeThreshold);
    if (!hasSwingLevel) return false;

    // Multi-candle reversal count over the shorter recent window (structure,
    // not a single wick) — same reversal test as _detect5mMultiChoCH, wider window.
    const mStart = Math.max(0, lastIdx - multiWindow + 1);
    const mHighs = highs.slice(mStart, endIdx);
    const mLows = lows.slice(mStart, endIdx);
    if (mHighs.length < 3) return false;
    let reversalStrength = 0;
    for (let i = 1; i < mHighs.length; i++) {
      const isReversal = (mHighs[i] > mHighs[i - 1] && mLows[i] > mLows[i - 1]) ||
                          (mHighs[i] < mHighs[i - 1] && mLows[i] < mLows[i - 1]);
      if (isReversal) reversalStrength++;
    }
    return reversalStrength >= reversalMin;
  }


  // Requires sequential candle structure (2+ consecutive candles), not just a single wick
  _detect5mMultiChoCH(indicators, lastIdx, config = {}) {
    const { closes, highs, lows } = indicators;
    if (!closes || !highs || !lows || lastIdx < 5) return false;

    // Check last 5 candles for sequential structure
    const window = 5;
    const startIdx = Math.max(0, lastIdx - window + 1);
    const endIdx = lastIdx + 1;

    const windowCloses = closes.slice(startIdx, endIdx);
    const windowHighs = highs.slice(startIdx, endIdx);
    const windowLows = lows.slice(startIdx, endIdx);

    if (windowCloses.length < 3) return false;

    // Count consecutive candles showing trend reversal
    let reversalStrength = 0;
    for (let i = 1; i < windowHighs.length; i++) {
      const prevHigh = windowHighs[i - 1];
      const prevLow = windowLows[i - 1];
      const currHigh = windowHighs[i];
      const currLow = windowLows[i];

      // Reversal = opposite direction (up candle after down, or vice versa)
      const isReversal = (currHigh > prevHigh && currLow > prevLow) ||
                        (currHigh < prevHigh && currLow < prevLow);
      if (isReversal) reversalStrength++;
    }

    // Require at least 2 consecutive reversals = real structure, not wick noise
    return reversalStrength >= 2;
  }

  /**
   * AF-SCALP-28: Validate Scalping 5m entry-TF structure alignment.
   *
   * For Scalping (Component A) only — ensures 5m entry has COMPLETE SMC
   * structure before allowing entry:
   *   1. Sweep detected on 5m (liquidity consumed at recent low/high)
   *   2. CHoCH confirmed (2+ consecutive candles show reversal)
   *   3. Displacement underway (price moved away from sweep level by >0.5%)
   *   4. Direction correct (LONG: price > sweep level; SHORT: price < sweep level)
   *
   * This prevents entries during incomplete structure (e.g., sweep without CHoCH
   * yet) which often reverse immediately. Structure alignment between 5m entry
   * and 1h confirmation is the hallmark of institutional breakouts.
   */
  _validateScalpingEntryTFStructure(indicators, lastIdx, signal, config = {}) {
    const { closes, highs, lows, volumes, volSMA } = indicators;
    if (!closes || !highs || !lows || lastIdx < 30) return true; // Allow if insufficient data

    // Scalping 5m structure gate: ensure complete structure before entry
    // Checks: sweep + CHoCH + displacement (all on 5m entry TF)

    // 1. Detect recent sweep (liquidity consumed)
    const sweep = this._detectSweep(closes, highs, lows, volumes, volSMA, lastIdx, config);
    if (!sweep) return false;

    // Sweep must match signal direction
    const sweepOK = (sweep.type === "bullish" && signal === "LONG") ||
                    (sweep.type === "bearish" && signal === "SHORT");
    if (!sweepOK) return false;

    // 2. Verify CHoCH on 5m (at least 2 consecutive candles showing reversal)
    // This is checked via _detect5mMultiChoCH which requires sequential structure
    const chochOK = this._detect5mMultiChoCH(indicators, lastIdx, config);
    if (!chochOK) return false;

    // 3. Check displacement (price moved away from sweep level by minimum threshold)
    const currentPrice = closes[lastIdx];
    const sweepLevel = sweep.level;
    const displacementPct = Math.abs(currentPrice - sweepLevel) / sweepLevel;
    const minDisplacementPct = config.smcScalpingMinDisplacementPct ?? 0.003; // 0.3% minimum

    if (displacementPct < minDisplacementPct) return false;

    // 4. Displacement must be in correct direction
    const displaceOK = (signal === "LONG" && currentPrice > sweepLevel) ||
                       (signal === "SHORT" && currentPrice < sweepLevel);
    if (!displaceOK) return false;

    // All checks passed — 5m structure is complete and aligned
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // detectSignalMulti — per-component results + meta
  // ─────────────────────────────────────────────────────────────────────────────

  detectSignalMulti(indicators, lastIdx, config = {}) {
    config = normalizeSmcParams(config);
    const { closes, highs, lows, volumes, volSMA, emaFast, emaSlow } = indicators;
    const opens = indicators.opens;
    const htfTrend = config.htfTrend ?? null;
    const enabled  = config.smcEnabledComponents ?? ["A", "B", "C"];
    const minConfA = config.smcMinConfidenceA ?? 60;
    const minConfB = config.smcMinConfidenceB ?? 65;
    const minConfC = config.smcMinConfidenceC ?? 65;
    const minConf  = { A: minConfA, B: minConfB, C: minConfC };
    const marketCond = this._getMarketCondition(config);



    // 4h candles by the engine and passed as config.htfTrend) over the internal
    // entry-TF EMA/ADX proxy — the proxy reads 15m indicators whose EMA9-21 gap
    // almost never clears the 0.4% threshold, and its ADX gate was dead (see
    // _detectHTFRegime). The proxy remains as fallback for callers without HTF data.
    const htfRegime = (htfTrend === "BULLISH" || htfTrend === "BEARISH" || htfTrend === "SIDEWAYS")
      ? htfTrend
      : this._detectHTFRegime(indicators, config, lastIdx);

    // Primary keys are type names; A/B/C kept as backward-compat aliases
    const result = { Scalping: null, Intraday: null, Swing: null, A: null, B: null, C: null };

    if (marketCond === "DEAD_MARKET") {
      const confZ = { Scalping: 0, Intraday: 0, Swing: 0, A: 0, B: 0, C: 0 };
      result.meta = { confidence: confZ, aggregateConfidence: 0, marketCond };
      this._lastSignalMeta = result.meta;
      return result;
    }

    // ── Raw signal detection ─────────────────────────────────────────────────
    // ── EVENT-DRIVEN SEQUENCE ENGINE (v3.0, default ON) ──────────────────────
    // Replaces the three independent single-bar checks with one causal SMC
    // sequence (sweep → CHoCH → displacement/FVG → mitigation → entry). Each
    // trade type runs the SAME sequence on its own timeframe candles (Scalping
    // 5m, Intraday 15m/5m, Swing 4h) via the triple-TF harness. Set
    // smcUseSequenceEngine=false to fall back to the legacy single-bar logic.
    const useSequence = config.smcUseSequenceEngine !== false;

    const enabledNorm = enabled.map(k => this.COMPONENT_TO_TYPE[k] || k);
    const wantA = enabled.includes("A") || enabledNorm.includes("Scalping");
    const wantB = enabled.includes("B") || enabledNorm.includes("Intraday");
    const wantC = enabled.includes("C") || enabledNorm.includes("Swing");

    let rawA, rawB, rawC, confA, confB, confC;

    if (useSequence) {
      const seq = this._detectSMCSequence(indicators, lastIdx, config);
      const sig = seq.signal;
      const score = seq.meta?.score ?? 0;
      this._lastSequenceMeta = seq.meta; // structural levels for SL placement
      if (wantA && sig) this._abl("seqSignal");
      rawA = wantA ? sig : null; confA = rawA ? score : 0;
      rawB = wantB ? sig : null; confB = rawB ? score : 0;
      rawC = wantC ? sig : null; confC = rawC ? score : 0;
    } else {
      rawA = wantA ? this._detectSignalA(closes, highs, lows, volumes, volSMA, lastIdx, config) : null;
      rawB = wantB ? this._detectSignalB(closes, highs, lows, volumes, volSMA, emaFast, emaSlow, lastIdx, config) : null;
      rawC = wantC ? this._detectSignalC(closes, highs, lows, volumes, volSMA, lastIdx, config) : null;

      // ── Confidence scoring (legacy per-component) ──────────────────────────
      const ctx = this._buildConfidenceContext(indicators, lastIdx, config, { marketCond });
      confA = rawA ? this._componentConfidence("A", rawA, ctx) : 0;
      confB = rawB ? this._componentConfidence("B", rawB, ctx) : 0;
      confC = rawC ? this._componentConfidence("C", rawC, ctx) : 0;
    }

    const scalpGates = resolveScalpingGateFlags(config);
    const swingGates = resolveSwingGateFlags(config);

    // Sprint 13: UTC session filter (default on for Scalping via typeOverrides).
    // Blocks new Scalping entries during 21–23 UTC (hours 21,22). Fail-open when
    // no candle timestamp is available.
    if (rawA && scalpGates.smcSessionFilter) {
      const ts = config.candleTimestamp
        ?? indicators.timestamps?.[lastIdx]
        ?? indicators.time?.[lastIdx]
        ?? null;
      const sess = applySmcSessionFilter(ts, {
        enabled: true,
        blockHoursUtc: scalpGates.smcSessionBlockHoursUtc,
      });
      if (sess.blocked) {
        this._abl("rejBySession");
        rawA = null;
        confA = 0;
      }
    }

    // Sprint 13: OB/FVG retest gate — Scalping + Swing (fast-fail reduction).
    // Reject breakout / slice-through bars. If a same-bias OB is nearby
    // (≤1.5×ATR via obDistanceAbs), require price inside it (true OB retest).
    // Distant or absent OBs: FVG mitigation alone is enough.
    const applyObRetest = (raw, confKey) => {
      const seq = this._lastSequenceMeta;
      const atrNow = indicators.atr?.[lastIdx];
      const nearOb = seq?.obZone
        && atrNow > 0
        && seq.obDistanceAbs != null
        && seq.obDistanceAbs <= atrNow * 1.5;
      const failBreakout = !seq || seq._isBreakoutBar || seq._brokeThroughFvg;
      const failNearOb = nearOb && !seq.obConfluence;
      if (failBreakout || failNearOb) {
        this._abl("rejByObRetest");
        return { raw: null, conf: 0 };
      }
      return { raw, conf: confKey };
    };
    if (rawA && scalpGates.smcRequireObRetest) {
      const r = applyObRetest(rawA, confA);
      rawA = r.raw; confA = r.conf;
    }
    if (rawC && swingGates.smcRequireObRetest) {
      const r = applyObRetest(rawC, confC);
      rawC = r.raw; confC = r.conf;
    }


    // Intraday now uses regimeMappingStrict to map direction to regime:
    // BULLISH regime → only LONG entries allowed
    // BEARISH regime → only SHORT entries allowed
    // SIDEWAYS regime → skip Intraday entirely
    const typeOverrides = config.typeOverrides || {};
    if (rawB && typeOverrides.Intraday?.regimeMappingStrict === true) {
      const mappedB = this._applyRegimeDirectionMapping(rawB, htfRegime, "Intraday", config);
      if (!mappedB) {
        rawB = null;
        confB = 0;
      } else {
        rawB = mappedB;  // Direction remapped or passed through
      }
    }


    // above for root-cause rationale). Off by default — enable via
    // typeOverrides.Intraday.structureConfirmValidate.
    if (rawB && typeOverrides.Intraday?.structureConfirmValidate === true) {
      if (!this._detectIntradayStructureConfirm(indicators, lastIdx, { ...config, ...typeOverrides.Intraday })) {
        this._abl("rejByIntradayStructure");
        rawB = null;
        confB = 0;
      }
    }

    // ── Scalping (A) Entry TF Structure Validation (5m alignment with 1h) ──────
    // AF-SCALP-28: For Scalping only — validate that 5m entry-TF structure
    // (sweep + CHoCH + displacement) is complete before allowing entry. This
    // prevents entries during incomplete structure moves, which often reverse.
    // Disabled by default; enable via typeOverrides.Scalping.validateEntryTFStructure = true
    if (rawA && typeOverrides.Scalping?.validateEntryTFStructure === true) {
      if (!this._validateScalpingEntryTFStructure(indicators, lastIdx, rawA, config)) {
        rawA = null;
        confA = Math.max(0, confA - 30);  // Heavy penalty for invalid structure
      }
    }

    // ── HTF filter ───────────────────────────────────────────────────────────
    // Default: soft scoring penalty (−15 pts) — allows neutral HTF entries but
    // penalizes trading against HTF trend. AF-FIX-REGIME (Sprint 7, re-scoped
    // 2026-07-02): when the pair's tier mandates a regime filter (STABLE and
    // stricter — see PairClassifier PARAM_OVERRIDES.regimeFilterRequired), a
    // direction-conflicting signal is HARD-blocked instead, since letting a
    // penalized-but-still-passing signal through defeats "lebih selektif" on
    // exactly the pairs where regime risk matters most.

    // config (backtest A/B). CSV evidence: 8/11 Scalping losses were LONGs
    // opened during HTF downtrends that survived the −15 penalty — "buy the
    // discount" only works WITH the higher-timeframe trend, never against it.

    // needs BULLISH, SHORT needs BEARISH, SIDEWAYS = flat). The asymmetric hard
    // block it shipped with made results WORSE than the soft penalty: it kept
    // every knife-catching LONG in SIDEWAYS-labeled downtrends while banning
    // the with-trend SHORTs. tierOverrides.regimeFilterRequired keeps the
    // legacy asymmetric behaviour (live parity — that path is live on STABLE+).
    const strictAlign = config.smcHtfHardBlock === true;
    const hardRegimeBlock = config.tierOverrides?.regimeFilterRequired === true
      || strictAlign;
    let htfAlignPts = 0;
    if (hardRegimeBlock) {
      if (rawA && this._htfDirectionBlocked(rawA, htfTrend, strictAlign)) { this._abl("rejByRegime"); rawA = null; confA = 0; htfAlignPts = -100; }
      if (rawB && this._htfDirectionBlocked(rawB, htfTrend, strictAlign)) { rawB = null; confB = 0; }
      if (rawC && this._htfDirectionBlocked(rawC, htfTrend, strictAlign)) { rawC = null; confC = 0; }
      if (rawA) htfAlignPts = 10; // survived hard align
    } else {
      if (rawA && this._htfDirectionBlocked(rawA, htfTrend)) { confA = Math.max(0, confA - 15); htfAlignPts = -15; }
      else if (rawA) htfAlignPts = 5;
      if (rawB && this._htfDirectionBlocked(rawB, htfTrend)) confB = Math.max(0, confB - 15);
      if (rawC && this._htfDirectionBlocked(rawC, htfTrend)) confC = Math.max(0, confC - 15);
    }
    if (this._lastSequenceMeta?.confidenceComponents) {
      this._lastSequenceMeta.confidenceComponents.htfAlignment = htfAlignPts;
    }


    // CSV showed false-breakout LONGs (wick sweeps) contaminating 5m entry set.
    // Gate: require BOTH swing high structure AND multi-candle sequence (not just 1-candle wick).

    // Validates entry causal context — single swing high insufficient, needs confirmation.
    // scalpingChochValidateMode "light" (opt-in, default "strict"): require EITHER
    // condition instead of BOTH. Untested hypothesis from a v3.1 doc proposal —
    // relaxing gates has previously recovered volume without hurting WR (rejection-
    // wick gate OFF: 43 vs 8 trades, same WR) but that precedent is for a DIFFERENT
    // gate; this one needs its own A/B before it becomes default (see
    // scripts/smc-scalping-choch-light-ab.js).
    if (rawA && config.scalpingChochValidate !== false) {
      const hasSwingHigh = this._detect5mChocH(indicators, lastIdx, config);
      const hasMultiStructure = this._detect5mMultiChoCH(indicators, lastIdx, config);
      const isLight = config.scalpingChochValidateMode === "light";
      const passes = isLight ? (hasSwingHigh || hasMultiStructure) : (hasSwingHigh && hasMultiStructure);
      if (!passes) {
        this._abl("rejByChoch");
        rawA = null;
        confA = 0;
      }
    }

    // ── Gate: check confidence vs min threshold ─────────────────────────────
    // AF-FIX-VOTING (Sprint 7, re-scoped 2026-07-02): tierOverrides.votingThresholdOverride
    // (0-1 scale, e.g. STABLE=0.60, VOLATILE=0.78) raises the effective per-component
    // confidence floor for stricter-tier pairs — stronger consensus required on
    // lower-liquidity coins, matching the FE's applyPairTierOverrides contract.
    const votingFloor = config.tierOverrides?.votingThresholdOverride;
    const votingMinConf = (typeof votingFloor === "number" && votingFloor > 0)
      ? Math.max(minConf.A, minConf.B, minConf.C, Math.round(votingFloor * 100))
      : null;

    // votingFloor resolved to max(60,65,65,60)=65 and starved the 5m leg,
    // whose score distribution peaks exactly in the 60-65 band. Intraday/Swing
    // keep the stricter raised floor.
    const effMinConf = votingMinConf != null
      ? { A: minConf.A, B: Math.max(minConf.B, votingMinConf), C: Math.max(minConf.C, votingMinConf) }
      : minConf;


    // 12mo CSV forensics: conf>=75 flips Scalping from netPF 0.90 to 1.18; LONG
    // is the weaker side (PF 0.74 vs SHORT 1.01) — SHORT>=75/LONG>=80 measured
    // netPF 1.35 (n=28, WR 46.4%). rawA here is the side string ("LONG"/"SHORT").
    const scalpMinConfLong = config.smcMinConfidenceALong ?? effMinConf.A;
    const scalpMinConfShort = config.smcMinConfidenceAShort ?? effMinConf.A;
    const effMinConfA = rawA === "LONG" ? scalpMinConfLong : scalpMinConfShort;


    // Entry-TF ADX chop gate (per-component, opt-in via typeOverrides[type].minAdx).
    // indicators.adx is only populated when the backtest engine computes it for
    // AF_SMC (see RealStrategyBacktestService) — without that wiring this is a
    // no-op (adxVal undefined → gate skipped), same fail-open default as before.
    const adxVal = indicators.adx?.[lastIdx];
    const passesAdx = (minAdx) => {
      if (!minAdx || adxVal == null) return true;
      return adxVal >= minAdx;
    };
    if (rawA && !passesAdx(typeOverrides.Scalping?.minAdx)) { rawA = null; confA = 0; }
    if (rawB && !passesAdx(typeOverrides.Intraday?.minAdx)) { rawB = null; confB = 0; }
    if (rawC && !passesAdx(typeOverrides.Swing?.minAdx)) { rawC = null; confC = 0; }

    if (rawA) { if (confA >= effMinConfA) this._abl("passed"); else this._abl("rejByConf"); }
    const sigScalping = (rawA && confA >= effMinConfA) ? rawA : null;
    const sigIntraday = (rawB && confB >= effMinConf.B) ? rawB : null;
    let sigSwing      = (rawC && confC >= effMinConf.C) ? rawC : null;

    // AF-SWING-V3: opt-in no-trade zone + adaptive sizing (typeOverrides.Swing.smcSwingV3Gate).
    // Disabled by default — behavior identical to pre-V3 when the flag is unset.
    const swingV3 = sigSwing
      ? this._evaluateSwingV3Gate(indicators, lastIdx, sigSwing, confC, config, typeOverrides.Swing)
      : { allow: true, sizeMultiplier: 1 };
    if (sigSwing && !swingV3.allow) sigSwing = null;

    // Set both type names and legacy letter aliases
    result.Scalping = sigScalping; result.A = sigScalping;
    result.Intraday = sigIntraday; result.B = sigIntraday;
    result.Swing    = sigSwing;    result.C = sigSwing;

    const aggVotes = [sigScalping, sigIntraday, sigSwing].filter(Boolean);
    const aggConf  = aggVotes.length > 0
      ? [confA, confB, confC].filter(c => c > 0).reduce((a, b) => a + b, 0) / Math.max(aggVotes.length, 1)
      : 0;

    result.meta = {
      confidence: { Scalping: confA, Intraday: confB, Swing: confC, A: confA, B: confB, C: confC },
      aggregateConfidence: Math.round(aggConf),
      // Always set — Market Cond = entry-TF vol/trend bucket (≠ dailyRegime).
      marketCond: marketCond || "NORMAL",
      swingV3: sigSwing ? swingV3 : undefined,
      // Surface sequence structural meta for CSV entryReasons (was dead field).
      // Hard-gate caveat: sweep+CHoCH+FVG are prerequisites — labels nearly identical
      // across AF_SMC trades; only FVG direction + obConfluence typically vary.
      sequenceMeta: this._lastSequenceMeta || null,
      confidenceComponents: this._lastSequenceMeta?.confidenceComponents || null,
    };
    this._lastSignalMeta = result.meta;
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // detectSignal — voting path (compatible with single-position BotEngine)
  // ─────────────────────────────────────────────────────────────────────────────

  detectSignal(indicators, lastIdx, config = {}) {
    const multi = this.detectSignalMulti(indicators, lastIdx, config);
    const minVotes = config.smcMinVotes ?? 1;
    const minAgg   = config.smcMinAggregateConfidence ?? 0;

    const signals = [multi.Scalping, multi.Intraday, multi.Swing].filter(Boolean);
    const long  = signals.filter(s => s === "LONG").length;
    const short = signals.filter(s => s === "SHORT").length;
    const total = long + short;

    if (total < minVotes) return null;
    if (long > 0 && short > 0) return null; // conflict

    const dir = long > 0 ? "LONG" : "SHORT";
    const agg = multi.meta?.aggregateConfidence ?? 0;
    if (minAgg > 0 && agg < minAgg) return null;

    return dir;
  }

  // Kept for backward compat with fee-edge-guards tests
  _resolveSignalConflict(signals = {}, htfTrend = null, opts = {}) {
    const minVotes = opts.minVotes ?? 2;
    const rejectOnDissent = opts.rejectOnDissent !== false;

    const dirs = Object.values(signals).filter(Boolean);
    const long  = dirs.filter(d => d === "LONG").length;
    const short = dirs.filter(d => d === "SHORT").length;

    if (rejectOnDissent && long > 0 && short > 0) return null;
    const total = rejectOnDissent ? (long > 0 ? long : short) : dirs.length;
    if (total < minVotes) return null;

    const dir = long >= short ? "LONG" : "SHORT";
    if (htfTrend && this._htfDirectionBlocked(dir, htfTrend)) return null;
    return dir;
  }
}

module.exports = SmartMoneyConceptsStrategy;
