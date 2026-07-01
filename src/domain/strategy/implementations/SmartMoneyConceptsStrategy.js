/**
 * SmartMoneyConceptsStrategy.js — v2.0.0 (SAC: Smart Money Concepts)
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
 *   SAC-FIX-05 / SAC-FIX-06 / SAC-FIX-07 / SAC-FIX-08
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");

const EPSILON = 1e-9;

class SmartMoneyConceptsStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "SMART_MONEY_CONCEPTS",
      label: "Smart Money Concepts (SAC)",
      description:
        "3-component SMC strategy: Scalping (sweep+OB+CVD), " +
        "Intraday (CHoCH+OB+trend), Swing (FVG+displacement+premium/discount). " +
        "Votes on directional confluence; blocks counter-HTF entries.",
      version: "1.0.0",
      enabled: true,
      ...config,
    });

    // ── Trade type TF configuration (each type runs on its own TF stack) ─────
    this.TRADE_TYPE_TF_CONFIG = {
      Scalping: { entryTf: "5m",  confirmTf: "15m", trendTf: "1h" },  // v3.0: 1m→5m for SMC sequence
      Intraday: { entryTf: "15m", confirmTf: "1h",  trendTf: "4h" },  // v3.0: 5m→15m entry
      Swing:    { entryTf: "4h",  confirmTf: "1d",  trendTf: "1w" },
    };

    // ── Sub-strategy RR/SL/TP multipliers (keyed by type name AND legacy letter) ─
    this.SUB_STRATEGIES = {
      Scalping: { name: "SAC_SCALP",    label: "Scalping",  slMultiplier: 0.8,  tpMultiplier: 1.5  },
      Intraday: { name: "SAC_INTRADAY", label: "Intraday",  slMultiplier: 1.2,  tpMultiplier: 2.16 },
      Swing:    { name: "SAC_SWING",    label: "Swing",     slMultiplier: 1.5,  tpMultiplier: 4.0  },
      // Backward-compat aliases (old code that passes "A"/"B"/"C")
      A: { name: "SAC_SCALP",    label: "Scalping",  slMultiplier: 0.8,  tpMultiplier: 1.5  },
      B: { name: "SAC_INTRADAY", label: "Intraday",  slMultiplier: 1.2,  tpMultiplier: 2.16 },
      C: { name: "SAC_SWING",    label: "Swing",     slMultiplier: 1.5,  tpMultiplier: 4.0  },
    };

    // Legacy letter → type name
    this.COMPONENT_TO_TYPE = { A: "Scalping", B: "Intraday", C: "Swing" };

    this._lastSignalMeta = null;
  }

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
      riskPerTrade:       0.005,
      riskPerTradeStrong: 0.01,
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

  calculateRiskConfig(entryPrice, atr, signal, component = "B", opts = {}) {
    const sub      = this.SUB_STRATEGIES[component] ?? this.SUB_STRATEGIES.B;
    const mul      = opts.strongTrendTPMult ?? 1.0;
    const isStrong = opts.marketCond === "STRONG_TREND" && mul > 1;

    const slDist = atr * sub.slMultiplier;
    let   tpDist = atr * sub.tpMultiplier;
    if (isStrong) tpDist *= mul;

    const stopLoss   = signal === "LONG" ? entryPrice - slDist : entryPrice + slDist;
    const takeProfit = signal === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;

    return {
      stopLoss:    parseFloat(stopLoss.toFixed(8)),
      takeProfit:  parseFloat(takeProfit.toFixed(8)),
      riskReward:  parseFloat((tpDist / slDist).toFixed(2)),
      slMultiplier: sub.slMultiplier,
      tpMultiplier: isStrong ? parseFloat((sub.tpMultiplier * mul).toFixed(4)) : sub.tpMultiplier,
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
    const leftLook = config.sacSwingLookback ?? 5;  // keep at 5 (left-side comparison window)
    const scanBars = config.sacSweepScanBars ?? 50;  // 30 → 50 (scan further back for recent swing lows)
    const volMult  = config.sacSweepVolMult  ?? 1.1;

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
    const lookback  = config.sacOBLookback ?? 15;
    const dispMult  = config.sacOBDispMult ?? 1.8;

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
    const lookback = config.sacChochLookback ?? 20;
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
  _detectFVG(closes, highs, lows, lastIdx, config = {}) {
    const minGapPct = config.sacFvgMinGap  ?? 0.003;
    const scanBars  = config.sacFvgScanBars ?? 30;

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
   * Displacement candle: high volume + wide range = conviction move.
   * Returns most recent displacement within scanBars.
   */
  _detectDisplacement(closes, highs, lows, volumes, volSMA, lastIdx, config = {}) {
    const scanBars = config.sacDispScanBars ?? 25;
    const volMult  = config.sacDispVolMult  ?? 2.0;
    const rangePct = config.sacDispRangePct ?? 0.012; // 1.2% min range

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
    const { closes, highs, lows, volumes, volSMA } = indicators;
    const win = config.sacSeqWindow ?? 60;
    if (lastIdx < 25) return { signal: null, meta: null };

    const cl = closes[lastIdx];

    // ── STEP 1: current bar must be mitigating an unfilled FVG ────────────────
    const fvgs = this._detectFVG(closes, highs, lows, lastIdx, config);

    // Try LONG then SHORT; return the first valid completed sequence.
    for (const dir of ["LONG", "SHORT"]) {
      const isLong = dir === "LONG";
      const fvg = isLong ? fvgs.bullish : fvgs.bearish;
      if (!fvg) continue;

      // Mitigation: price returned into the FVG zone.
      //   LONG  → pullback into discount half [bottom .. midpoint]
      //   SHORT → pullback into premium half  [midpoint .. top]
      const inMitigation = isLong
        ? (cl >= fvg.bottom * 0.999 && cl <= fvg.midpoint * 1.002)
        : (cl <= fvg.top * 1.001    && cl >= fvg.midpoint * 0.998);
      if (!inMitigation) continue;

      // The FVG is the footprint of the displacement leg. Its origin bar:
      const dispIdx = fvg.idx;

      // ── STEP 2: a CHoCH in our direction must precede the displacement ──────
      let chochIdx = -1;
      for (let b = dispIdx; b >= Math.max(25, dispIdx - win); b--) {
        const choch = this._detectCHoCH(closes, highs, lows, b, config);
        if (choch && choch.type === (isLong ? "bullish" : "bearish")) { chochIdx = b; break; }
      }
      if (chochIdx < 0) continue;

      // ── STEP 3: a liquidity sweep must precede the CHoCH ────────────────────
      let sweepIdx = -1, sweepExtreme = null;
      for (let b = chochIdx; b >= Math.max(15, chochIdx - win); b--) {
        const sweep = this._detectSweep(closes, highs, lows, volumes, volSMA, b, config);
        if (sweep && sweep.type === (isLong ? "bullish" : "bearish")) {
          sweepIdx = b;
          sweepExtreme = isLong ? lows[b] : highs[b];
          break;
        }
      }
      if (sweepIdx < 0) continue;

      // Causal order guaranteed by construction: sweepIdx ≤ chochIdx ≤ dispIdx ≤ now.
      // ── Confidence score from the quality of each leg ──────────────────────
      const score = this._scoreSequence(indicators, lastIdx, {
        isLong, fvg, dispIdx, chochIdx, sweepIdx, config,
      });

      return {
        signal: dir,
        meta: { sweepIdx, chochIdx, dispIdx, fvg, sweepExtreme, score },
      };
    }

    return { signal: null, meta: null };
  }

  /** 0-100 confidence for a completed SMC sequence. */
  _scoreSequence(indicators, lastIdx, ctx) {
    const { closes, highs, lows, volumes, volSMA } = indicators;
    const { isLong, fvg, dispIdx, sweepIdx } = ctx;
    let score = 45;

    // Sweep conviction: volume surge on the sweep bar
    const sVol = volumes[sweepIdx] ?? 0, sVSMA = volSMA[sweepIdx] ?? 1;
    const sweepVolRatio = sVSMA > 0 ? sVol / sVSMA : 1;
    score += Math.min(15, (sweepVolRatio - 1) * 15);

    // Displacement strength: range of the FVG-origin bar
    const dRange = ((highs[dispIdx] ?? 0) - (lows[dispIdx] ?? 0)) / (closes[dispIdx] || 1);
    score += Math.min(15, dRange * 600); // ~2.5% range → +15

    // FVG size (bigger imbalance = stronger)
    score += Math.min(10, (fvg.size || 0) * 1500); // 0.67% gap → +10

    // Mitigation depth: deeper into the zone = better entry
    const cl = closes[lastIdx];
    const depth = isLong
      ? (fvg.midpoint - cl) / Math.max(fvg.midpoint - fvg.bottom, 1e-9)
      : (cl - fvg.midpoint) / Math.max(fvg.top - fvg.midpoint, 1e-9);
    score += Math.max(0, Math.min(15, depth * 15));

    return Math.round(this.clamp(score, 0, 100));
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

  _htfDirectionBlocked(dir, htfTrend) {
    if (!htfTrend) return false;
    if (dir === "LONG"  && htfTrend === "BEARISH") return true;
    if (dir === "SHORT" && htfTrend !== "BEARISH")  return true;
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // detectSignalMulti — per-component results + meta
  // ─────────────────────────────────────────────────────────────────────────────

  detectSignalMulti(indicators, lastIdx, config = {}) {
    const { closes, highs, lows, volumes, volSMA, emaFast, emaSlow } = indicators;
    const opens = indicators.opens;
    const htfTrend = config.htfTrend ?? null;
    const enabled  = config.sacEnabledComponents ?? ["A", "B", "C"];
    const minConfA = config.sacMinConfidenceA ?? 60;
    const minConfB = config.sacMinConfidenceB ?? 65;
    const minConfC = config.sacMinConfidenceC ?? 65;
    const minConf  = { A: minConfA, B: minConfB, C: minConfC };
    const marketCond = this._getMarketCondition(config);

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
    // sacUseSequenceEngine=false to fall back to the legacy single-bar logic.
    const useSequence = config.sacUseSequenceEngine !== false;

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

    // ── HTF filter: soft scoring penalty (−15 pts) instead of hard block ────
    // Allows neutral HTF entries, but penalizes entries against HTF trend
    if (rawA && this._htfDirectionBlocked(rawA, htfTrend)) confA = Math.max(0, confA - 15);
    if (rawB && this._htfDirectionBlocked(rawB, htfTrend)) confB = Math.max(0, confB - 15);
    if (rawC && this._htfDirectionBlocked(rawC, htfTrend)) confC = Math.max(0, confC - 15);

    // ── Gate: check confidence vs min threshold ─────────────────────────────
    const sigScalping = (rawA && confA >= minConf.A) ? rawA : null;
    const sigIntraday = (rawB && confB >= minConf.B) ? rawB : null;
    const sigSwing    = (rawC && confC >= minConf.C) ? rawC : null;

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
      marketCond,
    };
    this._lastSignalMeta = result.meta;
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // detectSignal — voting path (compatible with single-position BotEngine)
  // ─────────────────────────────────────────────────────────────────────────────

  detectSignal(indicators, lastIdx, config = {}) {
    const multi = this.detectSignalMulti(indicators, lastIdx, config);
    const minVotes = config.sacMinVotes ?? 1;
    const minAgg   = config.sacMinAggregateConfidence ?? 0;

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
