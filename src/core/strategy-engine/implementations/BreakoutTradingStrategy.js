/**
 * BreakoutTradingStrategy.js — Professional Breakout Trading (consolidation → breakout → retest)
 *
 * Philosophy (v2.6 / Sprint 14 QA):
 *   Trade breakouts that have REAL volatility + a TRUE retest (not dry squeezes).
 *   1. VOLATILITY FLOOR — BB width ≥ min + ATR% ≥ min (super-tight = stop-hunt)
 *   2. BREAKOUT         — close leaves the 20-bar high/low range with volume
 *   3. RETEST           — wait ≥4h pullback to level + rejection wick → enter
 *
 * Indicators: Bollinger Band Width, Volume, ATR, range high/low (S&R).
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
        "Trades breakouts with healthy volatility (BB width / ATR floors), " +
        "confirmed by volume and a TRUE RETEST of the broken level (≥4h wait). " +
        "Risk-to-reward ~1:2 with structure-aware invalidation.",
      version: "2.6.0",
      enabled: true,
      ...config,
    });

    this.config = {
      ...this.config,           // preserve name/label/version from StrategyBase
      // Level detection (4h timeframe)
      lookbackBars: 20,        // High/low of last 20 candles = S&R level
      // Sprint 14: fee drag — keep 1.5×; cap exhaustion volume (WF sweet spot ≤3.55)
      volumeMultiplier: 1.5,   // Breakout needs ≥1.5× volume SMA20
      maxVolumeRatio: 3.55,    // >3.55× = exhaustion; WR collapses (WF finding)
      // 15m bars: PRD retest sequence is 4h–24h — prior minRetestBars=2 (~30m) was breakout-chase
      retestWindow: 96,        // Allow retest up to 24h after breakout (96×15m)
      minRetestBars: 16,       // Minimum 4h wait before retest entry is valid
      minRejectionWickRatio: 0.5, // Rejection wick ≥ 50% of candle range (Sprint 14: <0.5 = 5.9% WR)
      minRetestDepthAtr: 0.17, // Wick must pierce back into the level (Sprint 14 lower band)
      maxRetestDepthAtr: 0.72, // Deeper than 0.72×ATR = failed retest (17.6% WR)
      minDisplacementAtr: 0.30, // After breakout, price must move away before return
      // Sprint 14: block tightest squeezes — COILED (0/8 WR) + SQUEEZE (16.7% WR) + dry
      blockedMarketConds: ["COILED_BREAKOUT", "SQUEEZE_BREAKOUT", "DRY_SQUEEZE"],

      // ── Volatility gate (BB Width + ATR) — v2.6 REVERSED from squeeze ─────
      // QA 63-trade / 5-window: tightest BB width WR 6.2%; widest WR 43.8%.
      // Super-tight crypto "squeeze" = dry liquidity / stop-hunt, not coil energy.
      bbPeriod: 20,
      bbStdDev: 2.0,
      squeezeLookback: 10,     // Kept for width history / enrichment metrics
      // Legacy relative squeeze (disabled by default; requireConsolidation uses floors)
      squeezeThreshold: 0.75,
      minBbWidthPct: 0.0076,   // Absolute BB width floor (reject driest 25%)
      minAtrPct: 0.25,         // ATR as % of price (~270 on BTC≈100k)
      requireConsolidation: true,

      // Risk management (VAULT tier)
      // v2.4: SL 1.7×ATR + TP 3.2×ATR → RR ≈ 1:1.9
      riskPerTrade: 0.02,
      slMultiplier: 1.7,
      tpMultiplier: 3.2,       // Fallback ATR TP only (no structural target meta)
      // Sprint 14 P0.1-REVISI: SL must stay WIDE. Structure may only WIDEN the stop,
      // never tighten it below this ATR floor (old 0.5×ATR floor → 1.05×ATR median
      // stops hit by 1-candle noise; 0/35 clean −1.0R stops).
      minSlAtrFloor: 1.5,
      // Sprint 14 P0.6: hard cap on planned R:R. PRD BS_BR = 1.9; engine used to
      // stretch TP (median 3.42×ATR) to fake RR up to 6.40 while SL stayed tight —
      // worst combo (RR 3.65–6.4 → 20% WR). TP anchors to structure, RR ≤ this cap.
      maxPlannedRR: 2.5,
      // RR slippage fix: prefer full TP; if user enables partial, cap first take to 33%
      preferredTpMode: "full",
      slPlusPartial1Pct: 0.33,

      // Position management — PRD ≤2 trades/week; hard daily cap cuts fee churn
      maxTradesPerDay: 2,
      minCapital: 100,
      leverage: 1,
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
        maxAwayAtr: 0,
        retestExtreme: null,
        // Consolidation range height at breakout time → measured-move TP target (P0.6)
        rangeHeight: null,
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
   * Volatility / consolidation gate (v2.6).
   * QA reversed the old squeeze-seeking gate: require BB width ≥ minBbWidthPct
   * and (when atr/price given) ATR% ≥ minAtrPct. Relative "squeeze" is still
   * computed for enrichment / confidence but is NOT the pass condition.
   * Returns { squeeze, volatilityOk, widthPct, avgPriorWidthPct }.
   */
  checkConsolidation(closes, atr = null, price = null) {
    const period = this.config.bbPeriod;
    const lb = this.config.squeezeLookback;
    if (!closes || closes.length < period + lb) {
      return { squeeze: false, volatilityOk: false, widthPct: null, avgPriorWidthPct: null };
    }

    const n = closes.length;
    const curr = this._bbWidthPctAt(closes, n - 1, period);
    if (curr == null) {
      return { squeeze: false, volatilityOk: false, widthPct: null, avgPriorWidthPct: null };
    }

    let sum = 0, cnt = 0;
    for (let k = 2; k <= lb + 1; k++) {
      const w = this._bbWidthPctAt(closes, n - k, period);
      if (w != null) { sum += w; cnt++; }
    }
    const avgPrior = cnt ? sum / cnt : null;

    // Legacy relative squeeze metric (enrichment / confidence only)
    const squeeze = avgPrior != null
      ? curr <= avgPrior * this.config.squeezeThreshold
      : false;

    const minBb = this.config.minBbWidthPct ?? 0.0076;
    const widthOk = curr >= minBb;

    let atrOk = true;
    if (atr != null && price != null && price > 0) {
      const atrPct = (atr / price) * 100;
      atrOk = atrPct >= (this.config.minAtrPct ?? 0.25);
    }

    return {
      squeeze,
      volatilityOk: widthOk && atrOk,
      widthPct: curr,
      avgPriorWidthPct: avgPrior,
    };
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
    const maxVol = this.config.maxVolumeRatio;
    const notExhausted = maxVol == null || volRatio <= maxVol;

    if (isBreakout && hasVolume && notExhausted) {
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
    const maxVol = this.config.maxVolumeRatio;
    const notExhausted = maxVol == null || volRatio <= maxVol;

    if (isBreakout && hasVolume && notExhausted) {
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
   * True retest = pullback TO level + rejection wick in breakout direction + close confirm.
   * Sprint 14 QA: also require meaningful wick depth into the level (minRetestDepthAtr).
   */
  checkRetestEntry(closes, direction, breakoutLevel, lows = null, highs = null, opens = null, atr = null) {
    const n         = closes.length;
    const closeCurr = closes[n - 1];
    const openCurr  = (opens && opens[n - 1] != null) ? opens[n - 1] : closeCurr;
    const lowCurr   = (lows  && lows[n - 1]  != null) ? lows[n - 1]  : closeCurr;
    const highCurr  = (highs && highs[n - 1] != null) ? highs[n - 1] : closeCurr;
    const tol       = BreakoutTradingStrategy.RETEST_TOUCH_TOL;
    const range     = Math.max(highCurr - lowCurr, 1e-12);
    const minWick   = this.config.minRejectionWickRatio ?? 0.5;
    const minDepth  = this.config.minRetestDepthAtr ?? 0.17;
    const maxDepth  = this.config.maxRetestDepthAtr ?? 0.72;

    if (direction === "LONG") {
      const touchedLevel = lowCurr <= breakoutLevel * (1 + tol);
      const closedAbove  = closeCurr > breakoutLevel;
      const lowerWick    = Math.min(closeCurr, openCurr) - lowCurr;
      const wickRatio    = lowerWick / range;
      const hasRejection = wickRatio >= minWick;
      const retestDepth = Math.max(0, breakoutLevel - lowCurr);
      // Sprint 14: retest depth must land inside [minDepth, maxDepth]×ATR.
      // Shallow (<0.17 ATR = breakout-candle chase) and deep (>0.72 ATR = failed retest)
      // are the worst performers, so no "piercing" bypass anymore.
      const depthOk = (atr == null || atr <= 0)
        ? true
        : (retestDepth / atr) >= minDepth && (retestDepth / atr) <= maxDepth;
      if (touchedLevel && closedAbove && hasRejection && depthOk) {
        return {
          valid: true,
          entry: closeCurr,
          rejectionWickPct: wickRatio,
          retestDepth,
          retestExtreme: lowCurr,
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
      const retestDepth = Math.max(0, highCurr - breakoutLevel);
      const depthOk = (atr == null || atr <= 0)
        ? true
        : (retestDepth / atr) >= minDepth && (retestDepth / atr) <= maxDepth;
      if (touchedLevel && closedBelow && hasRejection && depthOk) {
        return {
          valid: true,
          entry: closeCurr,
          rejectionWickPct: wickRatio,
          retestDepth,
          retestExtreme: highCurr,
          reason: `Retest SHORT: high ${highCurr.toFixed(2)} menyentuh ${breakoutLevel.toFixed(2)}, ` +
            `rejection wick ${(wickRatio * 100).toFixed(0)}%, close ${closeCurr.toFixed(2)}`,
        };
      }
    }

    return { valid: false };
  }

  /**
   * Quality-scored confidence.
   *
   * Sprint 14 (Bug 3) ROOT CAUSE — gating-induced saturation, NOT a hardcode:
   * confidence is computed BEFORE the P0.2–P0.4 gates run, and those gates only
   * admit already-high-quality setups (wick ≥0.5, depth in band, ≥16-bar wait,
   * volume ≥1.5, healthy BB width). With the old base 48 + large additive steps,
   * the bonus sum overshot the 95 ceiling for virtually every survivor → all 47
   * trades clamped to a flat 95 (std 0), killing race-to-confirm meritocracy.
   *
   * FIX: rescaled so the survivor population still DISCRIMINATES. Bonuses are
   * finer-grained and the max realistic sum for a typical survivor lands ~85–92
   * (only an all-maxed rare setup touches the 95 ceiling), restoring an ~80–95
   * spread with non-zero variance. Confidence is scoring only — NOT a hard gate.
   */
  _scoreConfidence({
    squeezeWidthPct,
    avgPriorWidthPct,
    volumeRatio,
    rejectionWickPct,
    barsSinceBreakout,
    retestDepthAtr,
  } = {}) {
    let score = 60;
    if (squeezeWidthPct != null) {
      // Wider / healthier BB → higher score (inverse of old squeeze bonus)
      if (squeezeWidthPct >= 0.0103) score += 10;
      else if (squeezeWidthPct >= 0.0076) score += 6;
      else if (squeezeWidthPct >= 0.0057) score += 2;
      // below 0.0057: no bonus (dry liquidity zone)
    }
    if (volumeRatio != null) {
      // Graded across the whole passing band so volume actually differentiates.
      if (volumeRatio >= 3.0) score += 8;
      else if (volumeRatio >= 2.5) score += 7;
      else if (volumeRatio >= 2.0) score += 6;
      else if (volumeRatio >= 1.7) score += 4;
      else if (volumeRatio >= 1.5) score += 3;
      else if (volumeRatio >= 1.3) score += 1;
    }
    if (rejectionWickPct != null) {
      // Post-gate wick is already ≥0.5; grade the magnitude ABOVE the floor.
      if (rejectionWickPct >= 0.70) score += 8;
      else if (rejectionWickPct >= 0.60) score += 6;
      else if (rejectionWickPct >= 0.55) score += 4;
      else if (rejectionWickPct >= 0.50) score += 2;
      else if (rejectionWickPct >= 0.40) score += 1;
    }
    // Prefer longer waits (true pullback); 16–32 bars ≈ 4–8h on 15m
    if (barsSinceBreakout != null) {
      if (barsSinceBreakout >= 16 && barsSinceBreakout <= 32) score += 6;
      else if (barsSinceBreakout >= 33 && barsSinceBreakout <= 48) score += 5;
      else if (barsSinceBreakout >= 49 && barsSinceBreakout <= 64) score += 3;
      else if (barsSinceBreakout >= 8) score += 2;
    }
    if (retestDepthAtr != null) {
      // Reward mid-band depth (cleanest retests); band edges score lower.
      if (retestDepthAtr >= 0.30 && retestDepthAtr <= 0.55) score += 6;
      else if (retestDepthAtr >= 0.17 && retestDepthAtr <= 0.72) score += 3;
      else if (retestDepthAtr > 0.72) score += 1;
    }
    return Math.max(50, Math.min(95, Math.round(score)));
  }

  _classifyMarketCond(squeezeWidthPct, avgPriorWidthPct, atrPct) {
    if (squeezeWidthPct != null) {
      if (squeezeWidthPct < 0.0076) return "DRY_SQUEEZE";
      if (avgPriorWidthPct > 0) {
        const ratio = squeezeWidthPct / avgPriorWidthPct;
        if (ratio <= 0.75 && squeezeWidthPct >= 0.0076) return "COILED_BREAKOUT";
        // Sprint 14: mild compression (0.75–0.90×) still underperforms (16.7% WR)
        if (ratio > 0.75 && ratio <= 0.90 && squeezeWidthPct >= 0.0076) return "SQUEEZE_BREAKOUT";
      }
      if (squeezeWidthPct >= 0.0103) return "EXPANDED_RANGE";
    }
    if (atrPct != null) {
      if (atrPct < 0.4) return "LOW_VOL";
      if (atrPct > 2.5) return "HIGH_VOL";
    }
    return "NORMAL";
  }

  /**
   * Count how many consecutive bars — ending at the bar just BEFORE the breakout
   * bar — stayed contained within the detected range [support, resistance]
   * (with a small ~0.3% tolerance). Gives a REAL consolidation length instead of
   * a constant, so downstream analytics see genuine per-trade variance.
   */
  _countConsolidationBars(closes, highs, lows, resistance, support) {
    const hi = highs && highs.length ? highs : (closes || []);
    const lo = lows && lows.length ? lows : (closes || []);
    const n = Math.min(hi.length, lo.length);
    if (n < 2 || resistance == null || support == null) return 0;
    const tol = BreakoutTradingStrategy.RETEST_TOUCH_TOL; // 0.3%
    const upper = resistance * (1 + tol);
    const lower = support * (1 - tol);
    const maxCount = 50;
    let count = 0;
    // n-1 is the breakout bar itself; start one bar earlier and walk backwards.
    for (let i = n - 2; i >= 0 && count < maxCount; i--) {
      if (hi[i] <= upper && lo[i] >= lower) count++;
      else break;
    }
    return count;
  }

  /**
   * Main signal detection (VAULT tier)
   * 1. Detect levels (20-bar high/low)
   * 2. Verify VOLATILITY FLOOR (BB width + ATR%) before the breakout
   * 3. Detect breakout (with volume, not exhaustion)
   * 4. Wait ≥ minRetestBars, require displacement, then enter on true retest
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
      this.config.retestWindow + 5,
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

    // Step 2: Volatility floor on closes UP TO the pre-breakout bar
    const priceForAtr = closes[closes.length - 2] || closes[closes.length - 1];
    const consol = this.checkConsolidation(closes.slice(0, -1), atr, priceForAtr);
    const consolidationOK = !this.config.requireConsolidation || consol.volatilityOk;

    const volCurr = volumes[volumes.length - 1] || 0;
    const volRatioNow = volSMA > 0 ? volCurr / volSMA : 0;
    const breakoutBarRange = highs.length && lows.length
      ? Math.abs(highs[highs.length - 1] - lows[lows.length - 1])
      : 0;
    const breakoutCandleAtr = atr > 0 ? breakoutBarRange / atr : null;

    // Real consolidation length (consecutive bars contained in the range before the
    // breakout bar) — replaces the old constant squeezeLookback (zero variance).
    const consolidationBars = this._countConsolidationBars(closes, highs, lows, resistance, support);

    // Step 3: Check for LONG breakout (only arm when volatility floor passes)
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
      state.maxAwayAtr = 0;
      state.retestExtreme = null;
      state.rangeHeight = levels.range;
    }

    // Step 4: Check for SHORT breakout
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
      state.maxAwayAtr = 0;
      state.retestExtreme = null;
      state.rangeHeight = levels.range;
    }

    // Step 5: Wait for TRUE RETEST entry (not immediate / 1–2 bar chase)
    if (state.direction && state.breakoutBar != null && state.breakoutBar < lastIdx) {
      const barsSinceBreakout = lastIdx - state.breakoutBar;
      const minBars = this.config.minRetestBars ?? 16;

      if (barsSinceBreakout > this.config.retestWindow) {
        this.resetBreakoutState(config);
        return null;
      }

      // Track post-breakout displacement away from the level
      const highCurr = highs.length ? highs[highs.length - 1] : closes[closes.length - 1];
      const lowCurr  = lows.length  ? lows[lows.length - 1]  : closes[closes.length - 1];
      if (atr > 0 && state.breakoutLevel != null) {
        if (state.direction === "LONG") {
          const away = Math.max(0, highCurr - state.breakoutLevel) / atr;
          state.maxAwayAtr = Math.max(state.maxAwayAtr || 0, away);
        } else {
          const away = Math.max(0, state.breakoutLevel - lowCurr) / atr;
          state.maxAwayAtr = Math.max(state.maxAwayAtr || 0, away);
        }
      }

      if (barsSinceBreakout < minBars) {
        return null;
      }

      const minAway = this.config.minDisplacementAtr ?? 0.30;
      if ((state.maxAwayAtr || 0) < minAway) {
        return null; // Never displaced → superficial noise, not a retest
      }

      const retestCheck = this.checkRetestEntry(
        closes,
        state.direction,
        state.breakoutLevel,
        lows,
        highs,
        opens.length ? opens : null,
        atr
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
        // Sprint 14: block the tightest-squeeze regimes (COILED/SQUEEZE/dry) — worst WR
        if ((this.config.blockedMarketConds || []).includes(marketCond)) {
          this.resetBreakoutState(config);
          return null;
        }

        // Sprint 14 P0.6: anchor TP to a REAL structural target (measured move =
        // consolidation range height projected beyond the broken level). Skip the
        // trade when the nearest structural target is unreachable within the planned
        // R:R cap (nearest realistic target would need RR > maxPlannedRR) — forcing a
        // far ATR TP was what inflated planned RR to a mean 3.48 (→ 20% WR band).
        const rangeHeight = state.rangeHeight || 0;
        const structuralTarget = signal === "LONG"
          ? state.breakoutLevel + rangeHeight
          : state.breakoutLevel - rangeHeight;
        const targetRoom = signal === "LONG"
          ? structuralTarget - retestCheck.entry
          : retestCheck.entry - structuralTarget;
        const slDistExpected = atr * this.config.slMultiplier;
        const maxRR = this.config.maxPlannedRR ?? 2.5;
        if (!(rangeHeight > 0) || targetRoom <= 0 || targetRoom > maxRR * slDistExpected) {
          this.resetBreakoutState(config);
          return null;
        }

        const bbSqueezeWidthAtr = atr > 0 && state.squeezeWidthPct != null
          ? (state.squeezeWidthPct * closes[closes.length - 1]) / atr
          : null;

        this._lastSignalMeta = {
          component: "BS_BR",
          winningComponent: "BS_BR",
          strategyLabel: "Breakout Trading",
          bbSqueeze: consol.squeeze === true,
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
          preferredTpMode: this.config.preferredTpMode || "full",
          retestExtreme: retestCheck.retestExtreme ?? null,
          structuralTarget, // P0.6: measured-move TP target (range projection)
          plannedRR: parseFloat((targetRoom / slDistExpected).toFixed(2)),
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
          maxAwayAtr: state.maxAwayAtr,
        };
        this.resetBreakoutState(config);
        return signal;
      }
    }

    return null;
  }

  /**
   * Calculate SL/TP.
   *
   * Sprint 14 P0.1-REVISI (SL): the earlier "structure-anchored + 0.5×ATR floor"
   * stop produced a ~1.05×ATR median stop — 38% tighter than the PRD 1.7×ATR
   * ("wide") spec — and got clipped by 1-candle noise (0/35 clean −1.0R stops).
   * SL is now the WIDE ATR stop by default; structure (retest wick / broken level)
   * may only WIDEN it further, never tighten it below `minSlAtrFloor`×ATR.
   *
   * Sprint 14 P0.6 (TP): TP anchors to a REAL structural target (measured move,
   * passed via meta/extras.structuralTarget) instead of a stretched ATR multiple,
   * and planned R:R is hard-capped at `maxPlannedRR` (PRD 1.9 + tolerance).
   *
   * Signature is tolerant of the SMC-style call
   *   calculateRiskConfig(price, atr, signal, componentId, extras)
   * used by RealStrategyBacktestService.
   */
  calculateRiskConfig(entryPrice, atr, signal, extrasOrComponent = {}, maybeExtras = {}) {
    const extras = (extrasOrComponent && typeof extrasOrComponent === "object" && !Array.isArray(extrasOrComponent))
      ? extrasOrComponent
      : (maybeExtras && typeof maybeExtras === "object" ? maybeExtras : {});
    const meta = this._lastSignalMeta || {};
    const slDist = atr * this.config.slMultiplier;
    const minSlDist = atr * (this.config.minSlAtrFloor ?? 1.5);
    const maxRR = this.config.maxPlannedRR ?? 2.5;
    const breakoutLevel = extras.breakoutLevel ?? meta.breakoutLevel ?? null;
    const retestExtreme = extras.retestExtreme ?? meta.retestExtreme ?? null;
    const structuralTarget = extras.structuralTarget ?? meta.structuralTarget ?? null;

    let stopLoss;

    if (signal === "LONG") {
      const atrStop = entryPrice - slDist;
      let structureStop = null;
      if (retestExtreme != null) {
        structureStop = retestExtreme - atr * 0.2;
      } else if (breakoutLevel != null) {
        structureStop = breakoutLevel - atr * 0.25;
      }
      // P0.1-REVISI: start from the wide ATR stop; structure only widens it.
      stopLoss = atrStop;
      if (structureStop != null && structureStop < atrStop) {
        stopLoss = structureStop; // structure invalidation sits further away → give room
      }
      if (entryPrice - stopLoss < minSlDist) stopLoss = entryPrice - minSlDist; // floor
      if (stopLoss >= entryPrice) stopLoss = entryPrice - minSlDist;            // LONG clamp
    } else {
      const atrStop = entryPrice + slDist;
      let structureStop = null;
      if (retestExtreme != null) {
        structureStop = retestExtreme + atr * 0.2;
      } else if (breakoutLevel != null) {
        structureStop = breakoutLevel + atr * 0.25;
      }
      stopLoss = atrStop;
      if (structureStop != null && structureStop > atrStop) {
        stopLoss = structureStop;
      }
      if (stopLoss - entryPrice < minSlDist) stopLoss = entryPrice + minSlDist; // floor
      if (stopLoss <= entryPrice) stopLoss = entryPrice + minSlDist;            // SHORT clamp
    }

    const actualSlDist = Math.abs(entryPrice - stopLoss);
    const maxTpDist = actualSlDist * maxRR;

    // P0.6: prefer the structural target; fall back to the ATR multiple only when no
    // structural target is available (e.g. direct SMC-style call). Always clamp so
    // planned R:R never exceeds maxPlannedRR.
    let tpDist;
    const structOnCorrectSide = structuralTarget != null && (
      (signal === "LONG" && structuralTarget > entryPrice) ||
      (signal === "SHORT" && structuralTarget < entryPrice)
    );
    if (structOnCorrectSide) {
      tpDist = Math.abs(structuralTarget - entryPrice);
    } else {
      tpDist = atr * this.config.tpMultiplier;
    }
    tpDist = Math.min(tpDist, maxTpDist);

    const takeProfit = signal === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;

    return {
      stopLoss: parseFloat(stopLoss.toFixed(8)),
      takeProfit: parseFloat(takeProfit.toFixed(8)),
      riskReward: parseFloat((tpDist / actualSlDist).toFixed(2)),
      slDistance: actualSlDist,
      tpDistance: tpDist,
      slMultiplier: this.config.slMultiplier,
      tpMultiplier: this.config.tpMultiplier,
      preferredTpMode: this.config.preferredTpMode || "full",
      slPlusPartial1Pct: this.config.slPlusPartial1Pct ?? 0.33,
    };
  }

  /**
   * Validate entry conditions
   */
  validateEntry(price, atr, volume, volSMA) {
    const atrPct = (atr / price) * 100;
    const volRatio = volSMA > 0 ? volume / volSMA : 0;

    // ATR should be in healthy range (align with minAtrPct floor when strict)
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
      preferredTpMode: this.config.preferredTpMode || "full",
      slPlusPartial1Pct: this.config.slPlusPartial1Pct ?? 0.33,
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
