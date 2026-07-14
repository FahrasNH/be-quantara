/**
 * BreakoutTradingStrategy.js — Professional Breakout Trading (consolidation → breakout → retest)
 *
 * Philosophy: "Trade high-probability breakouts that emerge FROM consolidation,
 *              confirmed by a RETEST"
 *   1. CONSOLIDATION — Bollinger Band Width squeeze (volatility contracts)
 *   2. BREAKOUT      — close leaves the 20-bar high/low range with volume
 *   3. RETEST        — price returns to the broken level and is rejected → enter
 *
 * Indicators: Bollinger Band Width (squeeze), Volume (spike), ATR (stops),
 *             range high/low (support/resistance levels).
 * Trade type: Scalping → Swing (multi-TF, driven by getTimeframeConfig).
 *
 * Persisted strategy key stays "BREAKOUT_RETEST" / umbrella "BS_BR" (DB + tier +
 * entitlement compatibility) — only the file/class was renamed from
 * BreakoutRetestStrategy to reflect the broader "Breakout Trading" method.
 *
 * Best for: VAULT tier (exclusive 4th strategy)
 *        SL/TP recalibrated from 4yr BTC backtest: SL 1.7×ATR, TP 3.2×ATR → RR ~1:1.9
 *        (was 1.4/5.5 → 1:4 — a target 0/40 trades ever reached in 4 years).
 */

const StrategyBase = require("../base/StrategyBase");

class BreakoutTradingStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "BREAKOUT_RETEST",
      label: "Breakout Trading Strategy",
      description:
        "Trades breakouts that emerge from a Bollinger Band Width squeeze " +
        "(consolidation), confirmed by volume and a RETEST of the broken level. " +
        "Risk-to-reward ~1:2 with wide invalidation. Works in any market condition.",
      version: "2.5.0",
      enabled: true,
      ...config,
    });

    this.config = {
      ...this.config,           // preserve name/label/version from StrategyBase
      // Level detection (4h timeframe)
      lookbackBars: 20,        // High/low of last 20 candles = S&R level
      // Sprint 14: fee drag — 1.3× was too loose (freq 2–3.7/wk vs PRD ≤2)
      volumeMultiplier: 1.5,   // Breakout needs ≥1.5× volume SMA20
      retestWindow: 6,         // Retest must occur within N bars of breakout
      minRetestBars: 2,        // Reject same/next-bar chase; need real pullback
      minRejectionWickRatio: 0.35, // Rejection wick ≥ 35% of candle range

      // ── Consolidation gate (Bollinger Band Width squeeze) — v2.5 ─────────
      // Sprint 14: tighten from 0.9→0.75 to cut over-trading / fee bleed.
      bbPeriod: 20,            // Bollinger Band SMA period
      bbStdDev: 2.0,           // Band multiplier (±2σ)
      squeezeLookback: 10,     // Bars of BB-width history to compare against
      squeezeThreshold: 0.75,  // Squeeze if current width ≤ 0.75× avg prior width
      requireConsolidation: true, // Set false to disable the gate (legacy behaviour)

      // Risk management (VAULT tier)
      // SL calibration: raised from 0.5 → 1.5×ATR after diagnostic proved 0.5×ATR
      // sits inside normal bar noise (avg SL 268 < avg H-L range 535 on 15m BTC).
      // At 0.5×ATR, ~50% of bars breach SL on the next wick → 0% win rate.
      // v2.4 recalibration (4yr BTC VAULT backtest, 40 unique trades):
      //   - 0/40 trades EVER reached the 5.5×ATR full TP in 4 years → 4:1 target
      //     is empirically unreachable; runners always died at trail/SL first.
      //   - 27/40 (67.5%) never touched +1R before full SL (-127 net) while the
      //     13 that did were ALL profitable (+83 net) → stop too tight for
      //     post-breakout retest noise, not a trailing problem.
      //   Fix: widen SL 1.4→1.7×ATR (room for retest noise) + lower TP 5.5→3.2×ATR
      //   → RR ≈ 1:1.9 (reachable). Walk-forward validation still required.
      riskPerTrade: 0.02,
      slMultiplier: 1.7,
      tpMultiplier: 3.2,

      // Position management — PRD ≤2 trades/week; hard daily cap cuts fee churn
      maxTradesPerDay: 2,
      minCapital: 100,         // Minimum $100 to trade
      leverage: 1,             // Conservative leverage for VAULT
    };

    // State per simbol agar singleton aman dipakai banyak bot
    this._breakoutStates = new Map();
    this._lastSignalMeta = null;
  }

  _stateKey(config = {}) {
    return (config.symbol || "default").toUpperCase();
  }

  _getBreakoutState(config = {}) {
    const key = this._stateKey(config);
    if (!this._breakoutStates.has(key)) {
      this._breakoutStates.set(key, {
        direction: null,
        breakoutLevel: null,
        breakoutBar: null,
        confirmed: false,
        squeezeWidthPct: null,
        avgPriorWidthPct: null,
        breakoutVolumeRatio: null,
        consolidationBars: null,
        breakoutCandleAtr: null,
      });
    }
    return this._breakoutStates.get(key);
  }

  /**
   * Detect support/resistance levels.
   * S&R sejati = high tertinggi / low terendah pada lookback (BUKAN close), karena
   * level diuji oleh wick, bukan harga penutupan. (Fix #1)
   * Backward-compatible: bila `lows` tak diberikan, fallback pakai `highs` sbg closes.
   * Returns { resistance, support, midpoint, range }
   */
  detectLevels(highs, lows = null) {
    const hi = highs || [];
    const lo = lows || highs || [];
    if (hi.length < this.config.lookbackBars || lo.length < this.config.lookbackBars) return null;

    const hiLB = hi.slice(-this.config.lookbackBars);
    const loLB = lo.slice(-this.config.lookbackBars);
    const resistance = Math.max(...hiLB);  // Highest HIGH
    const support = Math.min(...loLB);     // Lowest LOW
    const midpoint = (resistance + support) / 2;

    return { resistance, support, midpoint, range: resistance - support };
  }

  /**
   * Bollinger Band Width% = (upper − lower) / middle, computed from the `period`
   * closes ENDING at endIdx. Returns null on insufficient data / zero mean.
   */
  _bbWidthPctAt(closes, endIdx, period) {
    if (endIdx + 1 < period) return null;
    const seg = closes.slice(endIdx - period + 1, endIdx + 1);
    const mean = seg.reduce((a, b) => a + b, 0) / period;
    if (mean === 0) return null;
    const variance = seg.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    return (2 * this.config.bbStdDev * std) / mean; // (mean+kσ) − (mean−kσ) = 2kσ, over mean
  }

  /**
   * Consolidation check via Bollinger Band Width squeeze.
   * Squeeze = current BB width% is contracted below `squeezeThreshold`× its own
   * average over the previous `squeezeLookback` bars → volatility is coiling,
   * a real pre-breakout condition. Pass the closes UP TO the pre-breakout bar
   * (i.e. exclude the breakout candle, which itself expands the bands).
   * Returns { squeeze, widthPct, avgPriorWidthPct }.
   */
  checkConsolidation(closes) {
    const period = this.config.bbPeriod;
    const lb = this.config.squeezeLookback;
    if (!closes || closes.length < period + lb) {
      return { squeeze: false, widthPct: null, avgPriorWidthPct: null };
    }

    const n = closes.length;
    const curr = this._bbWidthPctAt(closes, n - 1, period);
    if (curr == null) return { squeeze: false, widthPct: null, avgPriorWidthPct: null };

    let sum = 0, cnt = 0;
    for (let k = 2; k <= lb + 1; k++) {
      const w = this._bbWidthPctAt(closes, n - k, period);
      if (w != null) { sum += w; cnt++; }
    }
    const avgPrior = cnt ? sum / cnt : null;
    if (avgPrior == null) return { squeeze: false, widthPct: curr, avgPriorWidthPct: null };

    const squeeze = curr <= avgPrior * this.config.squeezeThreshold;
    return { squeeze, widthPct: curr, avgPriorWidthPct: avgPrior };
  }

  /**
   * Check if price breaks above resistance with volume
   */
  checkLongBreakout(closes, volumes, volSMA, resistance) {
    const closeCurr = closes[closes.length - 1];
    const closePrev = closes[closes.length - 2];
    const volCurr = volumes[volumes.length - 1];
    const volRatio = volSMA > 0 ? volCurr / volSMA : 0;

    // Breakout: Previous close <= resistance, current close > resistance
    const isBreakout = closePrev <= resistance && closeCurr > resistance;
    const hasVolume = volRatio >= this.config.volumeMultiplier;

    if (isBreakout && hasVolume) {
      return {
        valid: true,
        level: resistance,
        entryZone: [resistance, resistance + (closeCurr - resistance) * 0.5],
        reason: `Bullish breakout above ${resistance.toFixed(2)} with ${volRatio.toFixed(2)}× volume`,
      };
    }

    return { valid: false };
  }

  /**
   * Check if price breaks below support with volume
   */
  checkShortBreakout(closes, volumes, volSMA, support) {
    const closeCurr = closes[closes.length - 1];
    const closePrev = closes[closes.length - 2];
    const volCurr = volumes[volumes.length - 1];
    const volRatio = volSMA > 0 ? volCurr / volSMA : 0;

    // Breakout: Previous close >= support, current close < support
    const isBreakout = closePrev >= support && closeCurr < support;
    const hasVolume = volRatio >= this.config.volumeMultiplier;

    if (isBreakout && hasVolume) {
      return {
        valid: true,
        level: support,
        entryZone: [support, support - (support - closeCurr) * 0.5],
        reason: `Bearish breakout below ${support.toFixed(2)} with ${volRatio.toFixed(2)}× volume`,
      };
    }

    return { valid: false };
  }

  // Toleransi "sentuhan" retest: bar harus kembali ke ±RETEST_TOUCH_TOL dari level.
  static get RETEST_TOUCH_TOL() { return 0.003; } // 0.3%

  /**
   * Sprint 14: reject superficial 1-wick taps.
   * True retest = pullback TO level + rejection wick in breakout direction + close confirm.
   */
  checkRetestEntry(closes, direction, breakoutLevel, lows = null, highs = null, opens = null) {
    const n         = closes.length;
    const closeCurr = closes[n - 1];
    const openCurr  = (opens && opens[n - 1] != null) ? opens[n - 1] : closeCurr;
    const lowCurr   = (lows  && lows[n - 1]  != null) ? lows[n - 1]  : closeCurr;
    const highCurr  = (highs && highs[n - 1] != null) ? highs[n - 1] : closeCurr;
    const tol       = BreakoutTradingStrategy.RETEST_TOUCH_TOL;
    const range     = Math.max(highCurr - lowCurr, 1e-12);
    const minWick   = this.config.minRejectionWickRatio ?? 0.35;

    if (direction === "LONG") {
      const touchedLevel = lowCurr <= breakoutLevel * (1 + tol);
      const closedAbove  = closeCurr > breakoutLevel;
      const lowerWick    = Math.min(closeCurr, openCurr) - lowCurr;
      const wickRatio    = lowerWick / range;
      const hasRejection = wickRatio >= minWick;
      if (touchedLevel && closedAbove && hasRejection) {
        const retestDepth = Math.max(0, breakoutLevel - lowCurr);
        return {
          valid: true,
          entry: closeCurr,
          rejectionWickPct: wickRatio,
          retestDepth,
          reason: `Retest LONG: low ${lowCurr.toFixed(2)} menyentuh ${breakoutLevel.toFixed(2)}, ` +
            `rejection wick ${(wickRatio * 100).toFixed(0)}%, close ${closeCurr.toFixed(2)}`,
        };
      }
    } else if (direction === "SHORT") {
      const touchedLevel = highCurr >= breakoutLevel * (1 - tol);
      const closedBelow  = closeCurr < breakoutLevel;
      const upperWick    = highCurr - Math.max(closeCurr, openCurr);
      const wickRatio    = upperWick / range;
      const hasRejection = wickRatio >= minWick;
      if (touchedLevel && closedBelow && hasRejection) {
        const retestDepth = Math.max(0, highCurr - breakoutLevel);
        return {
          valid: true,
          entry: closeCurr,
          rejectionWickPct: wickRatio,
          retestDepth,
          reason: `Retest SHORT: high ${highCurr.toFixed(2)} menyentuh ${breakoutLevel.toFixed(2)}, ` +
            `rejection wick ${(wickRatio * 100).toFixed(0)}%, close ${closeCurr.toFixed(2)}`,
        };
      }
    }

    return { valid: false };
  }

  /**
   * Sprint 14: quality-scored confidence (was flat 65 — race-to-confirm dead).
   * Inputs are setup quality, not circular hard-gates.
   */
  _scoreConfidence({
    squeezeWidthPct,
    avgPriorWidthPct,
    volumeRatio,
    rejectionWickPct,
    barsSinceBreakout,
    retestDepthAtr,
  } = {}) {
    let score = 48;
    if (avgPriorWidthPct > 0 && squeezeWidthPct != null) {
      const squeezeRatio = squeezeWidthPct / avgPriorWidthPct;
      // Deeper squeeze → higher score (0.75 threshold; 0.5 is excellent)
      if (squeezeRatio <= 0.5) score += 18;
      else if (squeezeRatio <= 0.65) score += 14;
      else if (squeezeRatio <= 0.75) score += 10;
      else if (squeezeRatio <= 0.9) score += 4;
    }
    if (volumeRatio != null) {
      if (volumeRatio >= 2.0) score += 14;
      else if (volumeRatio >= 1.5) score += 10;
      else if (volumeRatio >= 1.3) score += 5;
    }
    if (rejectionWickPct != null) {
      if (rejectionWickPct >= 0.55) score += 12;
      else if (rejectionWickPct >= 0.4) score += 8;
      else if (rejectionWickPct >= 0.35) score += 4;
    }
    // Prefer 2–4 bar retests (true pullback); 1-bar chase is rejected elsewhere
    if (barsSinceBreakout === 2 || barsSinceBreakout === 3) score += 8;
    else if (barsSinceBreakout === 4 || barsSinceBreakout === 5) score += 5;
    else if (barsSinceBreakout >= 6) score += 2;

    if (retestDepthAtr != null) {
      if (retestDepthAtr >= 0.15 && retestDepthAtr <= 0.8) score += 6;
      else if (retestDepthAtr > 0.8) score += 2; // deep retest — still valid but riskier
    }
    return Math.max(40, Math.min(95, Math.round(score)));
  }

  _classifyMarketCond(squeezeWidthPct, avgPriorWidthPct, atrPct) {
    if (avgPriorWidthPct > 0 && squeezeWidthPct != null) {
      const ratio = squeezeWidthPct / avgPriorWidthPct;
      if (ratio <= 0.75) return "SQUEEZE_BREAKOUT";
      if (ratio <= 0.95) return "TIGHT_RANGE";
    }
    if (atrPct != null) {
      if (atrPct < 0.4) return "LOW_VOL";
      if (atrPct > 2.5) return "HIGH_VOL";
    }
    return "NORMAL";
  }

  /**
   * Main signal detection (VAULT tier)
   * 1. Detect levels (20-bar high/low)
   * 2. Verify CONSOLIDATION (Bollinger Band Width squeeze) before the breakout
   * 3. Detect breakout (with volume)
   * 4. Enter on retest (not on breakout spike)
   */
  detectSignal(indicators, lastIdx, config = {}) {
    if (lastIdx < 30) return null;

    // Slice a SMALL window ending at the current bar so every helper (which
    // indexes off array.length-1) reads `lastIdx` as "current". Helpers only
    // need the last ~31 bars: detectLevels (lookbackBars=20), checkConsolidation
    // (bbPeriod=20 + squeezeLookback=10), breakout/retest (last 1-2 bars).
    // Copying the FULL prefix per bar was O(n²) — on 15m/365d (~35k bars) that's
    // ~2B element copies → event-loop block → poll timeout (same class as the
    // MD_MR O(n²) bug fixed in 01a0d63).
    const WINDOW = Math.max(
      this.config.lookbackBars + 1,
      this.config.bbPeriod + this.config.squeezeLookback + 2,
      40,
    );
    const start = Math.max(0, lastIdx + 1 - WINDOW);
    const closes = (indicators.closes || []).slice(start, lastIdx + 1);
    const volumes = (indicators.volumes || []).slice(start, lastIdx + 1);
    const highs = (indicators.highs || []).slice(start, lastIdx + 1);
    const lows  = (indicators.lows  || []).slice(start, lastIdx + 1);
    const opens = (indicators.opens || []).slice(start, lastIdx + 1);
    const volSMA = indicators.volSMA?.[lastIdx] || 0;
    const atr = indicators.atr?.[lastIdx];

    if (!atr || closes.length < this.config.lookbackBars) return null;

    // Step 1: Detect S&R levels dari HIGH/LOW sebelum bar saat ini (jangan ikutkan
    // bar breakout itu sendiri). Fallback ke closes bila high/low tak tersedia. (Fix #1)
    const highsBefore = (highs.length ? highs : closes).slice(0, -1);
    const lowsBefore  = (lows.length  ? lows  : closes).slice(0, -1);
    const levels = this.detectLevels(highsBefore, lowsBefore);
    if (!levels) return null;

    const { resistance, support } = levels;

    const state = this._getBreakoutState(config);

    // Step 2: Consolidation gate — measure the BB-width squeeze on the closes UP
    // TO the pre-breakout bar (exclude the current candle, which expands the bands).
    // Only arm a fresh breakout if the market was coiling; a retest already in
    // progress (state.direction set on a prior bar) is NOT re-gated here.
    const consol = this.checkConsolidation(closes.slice(0, -1));
    const consolidationOK = !this.config.requireConsolidation || consol.squeeze;

    const volCurr = volumes[volumes.length - 1] || 0;
    const volRatioNow = volSMA > 0 ? volCurr / volSMA : 0;
    const breakoutBarRange = highs.length && lows.length
      ? Math.abs(highs[highs.length - 1] - lows[lows.length - 1])
      : 0;
    const breakoutCandleAtr = atr > 0 ? breakoutBarRange / atr : null;

    // Estimate consolidation length: consecutive bars where width was ≤ threshold×avg
    let consolidationBars = 0;
    if (consol.squeeze && consol.avgPriorWidthPct != null) {
      consolidationBars = this.config.squeezeLookback;
    }

    // Step 3: Check for LONG breakout (only arm when it exits a squeeze)
    const longBreakout = this.checkLongBreakout(closes, volumes, volSMA, resistance);
    if (longBreakout.valid && consolidationOK) {
      state.direction = "LONG";
      state.breakoutLevel = resistance;
      state.breakoutBar = lastIdx;
      state.confirmed = false;
      state.squeezeWidthPct = consol.widthPct;
      state.avgPriorWidthPct = consol.avgPriorWidthPct;
      state.breakoutVolumeRatio = volRatioNow;
      state.consolidationBars = consolidationBars;
      state.breakoutCandleAtr = breakoutCandleAtr;
    }

    // Step 4: Check for SHORT breakout (only arm when it exits a squeeze)
    const shortBreakout = this.checkShortBreakout(closes, volumes, volSMA, support);
    if (shortBreakout.valid && consolidationOK) {
      state.direction = "SHORT";
      state.breakoutLevel = support;
      state.breakoutBar = lastIdx;
      state.confirmed = false;
      state.squeezeWidthPct = consol.widthPct;
      state.avgPriorWidthPct = consol.avgPriorWidthPct;
      state.breakoutVolumeRatio = volRatioNow;
      state.consolidationBars = consolidationBars;
      state.breakoutCandleAtr = breakoutCandleAtr;
    }

    // Step 5: Wait for RETEST entry (not immediate breakout)
    // Only check for retest if breakout was detected on a PREVIOUS bar
    if (state.direction && state.breakoutBar != null && state.breakoutBar < lastIdx) {
      const barsSinceBreakout = lastIdx - state.breakoutBar;
      const minBars = this.config.minRetestBars ?? 2;

      // Expire stale breakouts: if the retest hasn't come within the window,
      // the level is no longer relevant — drop it to avoid entries on old levels.
      if (barsSinceBreakout > this.config.retestWindow) {
        this.resetBreakoutState(config);
        return null;
      }

      // Reject breakout-chase / 1-bar superficial pullback (Sprint 14)
      if (barsSinceBreakout < minBars) {
        return null;
      }

      const retestCheck = this.checkRetestEntry(
        closes,
        state.direction,
        state.breakoutLevel,
        lows,
        highs,
        opens.length ? opens : null
      );

      if (retestCheck.valid) {
        const signal = state.direction;
        const retestDepthAtr = atr > 0 && retestCheck.retestDepth != null
          ? retestCheck.retestDepth / atr
          : null;
        const atrPct = (atr / closes[closes.length - 1]) * 100;
        const confidence = this._scoreConfidence({
          squeezeWidthPct: state.squeezeWidthPct,
          avgPriorWidthPct: state.avgPriorWidthPct,
          volumeRatio: state.breakoutVolumeRatio,
          rejectionWickPct: retestCheck.rejectionWickPct,
          barsSinceBreakout,
          retestDepthAtr,
        });
        const marketCond = this._classifyMarketCond(
          state.squeezeWidthPct,
          state.avgPriorWidthPct,
          atrPct
        );
        const bbSqueezeWidthAtr = atr > 0 && state.squeezeWidthPct != null
          ? (state.squeezeWidthPct * closes[closes.length - 1]) / atr
          : null;

        // Hard-gate 3-phase: BB Squeeze → Range Breakout → Retest Confirmation.
        this._lastSignalMeta = {
          component: "BS_BR",
          winningComponent: "BS_BR",
          strategyLabel: "Breakout Trading",
          bbSqueeze: true,
          rangeBreakout: true,
          retestConfirmation: true,
          consolidationConfirmed: true,
          breakoutConfirmed: true,
          retestConfirmed: true,
          direction: signal,
          breakoutLevel: state.breakoutLevel,
          squeezeWidthPct: state.squeezeWidthPct,
          avgPriorWidthPct: state.avgPriorWidthPct,
          componentConfidence: confidence,
          confidence: confidence / 100,
          marketCond,
          reason: retestCheck.reason,
          // Sprint 14 BS_BR enrichment (WinPredictor / CSV)
          bbWidth: state.squeezeWidthPct,
          bbSqueezeWidthAtr,
          breakoutVolumeRatio: state.breakoutVolumeRatio,
          volumeRatio: state.breakoutVolumeRatio,
          retestDepthAtr,
          rejectionWickPct: retestCheck.rejectionWickPct,
          consolidationBars: state.consolidationBars,
          breakoutCandleAtr: state.breakoutCandleAtr,
          barsSinceBreakout,
        };
        this.resetBreakoutState(config);
        return signal;
      }
    }

    return null;
  }

  /**
   * Calculate SL/TP based on ATR
   * For VAULT: 1.7x ATR SL, 3.2x ATR TP = ~1:1.9 RR (v2.4 recalibration)
   */
  calculateRiskConfig(entryPrice, atr, signal) {
    const slDist = atr * this.config.slMultiplier;
    const tpDist = atr * this.config.tpMultiplier;

    let stopLoss, takeProfit;

    if (signal === "LONG") {
      stopLoss = entryPrice - slDist;
      takeProfit = entryPrice + tpDist;
    } else {
      stopLoss = entryPrice + slDist;
      takeProfit = entryPrice - tpDist;
    }

    return {
      stopLoss: parseFloat(stopLoss.toFixed(8)),
      takeProfit: parseFloat(takeProfit.toFixed(8)),
      riskReward: parseFloat((tpDist / slDist).toFixed(2)),
      slDistance: slDist,
      tpDistance: tpDist,
      slMultiplier: this.config.slMultiplier,
      tpMultiplier: this.config.tpMultiplier,
    };
  }

  /**
   * Validate entry conditions
   */
  validateEntry(price, atr, volume, volSMA) {
    const atrPct = (atr / price) * 100;
    const volRatio = volSMA > 0 ? volume / volSMA : 0;

    // ATR should be in healthy range
    if (atrPct < 0.2 || atrPct > 5.0) {
      return {
        valid: false,
        reason: `ATR ${atrPct.toFixed(2)}% outside healthy range (0.2-5%)`,
      };
    }

    // Volume should be above SMA
    if (volRatio < 0.8) {
      return {
        valid: false,
        reason: `Volume ${volRatio.toFixed(2)}× below threshold (0.8×)`,
      };
    }

    return { valid: true, reason: "Entry conditions met" };
  }

  /**
   * Rank strategy by market conditions
   */
  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 0, trendStrength = 0 } = marketConditions;

    // Breakout strategy prefers:
    // - Medium-high volatility (1-3%)
    // - Clear trend structure
    let score = 50;

    if (volatility >= 0.5 && volatility <= 3) score += 15;
    if (trendStrength >= 0.5) score += 15;

    return this.clamp(score, 0, 100);
  }

  /**
   * Check if strategy can activate
   */
  canActivate(balance, htfTrend, volatility) {
    if (balance < this.config.minCapital) {
      return {
        allowed: false,
        reason: `Balance $${balance} below minimum $${this.config.minCapital}`,
      };
    }

    return { allowed: true, reason: "Strategy ready" };
  }

  /**
   * Entry-context meta for CSV entryReasons (BB Squeeze / Range Breakout / Retest).
   * Set only when detectSignal returns a fill; otherwise null.
   */
  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  /**
   * Get current breakout state
   */
  getBreakoutState(config = {}) {
    return { ...this._getBreakoutState(config) };
  }

  /**
   * Reset breakout state (after trade closes)
   */
  resetBreakoutState(config = {}) {
    this._breakoutStates.delete(this._stateKey(config));
  }

  /**
   * Get risk configuration
   */
  getRiskConfig() {
    return {
      riskPerTrade: this.config.riskPerTrade,
      maxRiskPerTrade: 0.04,  // Never exceed 4%
      maxDailyLossPct: 0.08,  // Stop if lose 8% per day
      maxTradesPerDay: this.config.maxTradesPerDay,
      cooldownAfterLoss: 5,   // 5 min cooldown after loss
      maxConsecLoss: 3,       // Stop if 3 consecutive losses
      leverage: this.config.leverage,
    };
  }

  /**
   * Get timeframe configuration
   */
  getTimeframeConfig() {
    return {
      interval: "15m",         // Check every 15 min
      higherTf: "4h",          // Use 4h for level detection
      checkInterval: 900000,   // 15 minutes in ms
    };
  }

  /**
   * Get configuration
   */
  getConfig() {
    return this.config;
  }

  /**
   * Update configuration (for testing)
   */
  setConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }
}

module.exports = BreakoutTradingStrategy;
