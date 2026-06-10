/**
 * TrendMomentumStrategy.js — Professional Trend + Momentum Trading
 *
 * Philosophy: "Trade strong trends with momentum confirmation"
 * - Multi-timeframe: 4H trend, 15m momentum, 5m entry (lower risk)
 * - Quality over frequency: 60 trades/year vs 100+/month
 * - Tight stops (1.2×ATR), good reward (2.3×ATR) = RR 1:1.92
 * - Best for: MINT tier (Rp10-15M, 54-58% WR, 100-180% annual)
 *
 * 3-Layer Confirmation:
 * 1. HTF (4H): Trend direction via EMA21/50
 * 2. MTF (15m): Momentum building via MACD + RSI slope
 * 3. Entry (5m): Retracement entry via EMA9/21 + RSI + volume
 *
 * ── Multi-Timeframe Data Contract (FIX #1) ──────────────────────────────────
 * detectSignal() reads multi-TF data when provided on the indicators object,
 * and gracefully falls back to entry-TF proxies otherwise.
 *
 *   indicators = {
 *     // Entry TF (5m) — always required
 *     closes, volumes, emaFast (EMA9), emaSlow (EMA21), emaTrend (EMA50),
 *     rsi, atr, volSMA,
 *
 *     // MTF (15m) — optional; if present, used for momentum layer
 *     macd15m, signal15m, histogram15m, rsi15m,
 *
 *     // HTF (4h) — optional; if present, used for trend layer
 *     closesHTF, emaFastHTF, emaMidHTF, emaSlowHTF,
 *   }
 *
 * Index alignment (when MTF/HTF arrays are supplied):
 *   idxMTF = floor(entryIdx / mtfRatio)   // 15m/5m  = 3
 *   idxHTF = floor(entryIdx / htfRatio)   // 4h/5m   = 48
 * ────────────────────────────────────────────────────────────────────────────
 */

const StrategyBase = require("../base/StrategyBase");
const { calcMACD } = require("../../indicators");

class TrendMomentumStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "TREND_MOMENTUM",
      label: "Trend + Momentum Strategy",
      description:
        "Multi-timeframe trend trading with momentum confirmation. " +
        "Identifies strong trends (4H), confirms momentum (15m), enters on retracement (5m). " +
        "Tight stops, good risk-reward. Fewer trades, higher quality. Best for MINT tier (Rp10-15M).",
      version: "1.1.0",
      enabled: true,
      ...config,
    });

    this.config = {
      ...this.config,           // preserve name/label/version from StrategyBase
      // Timeframes (multi-TF strategy)
      htfInterval: "4h",        // Higher TF for trend direction
      mtfInterval: "15m",       // Middle TF for momentum
      entryInterval: "5m",      // Entry TF for precision

      // Multi-TF index alignment ratios (FIX #1)
      mtfRatio: 3,              // 15m / 5m  = 3
      htfRatio: 48,             // 4h  / 5m  = 48

      // EMAs (trend structure)
      emaTrendFast: 9,          // Fast EMA (entry confirmation)
      emaTrendMid: 21,          // Mid EMA (structure)
      emaTrendSlow: 50,         // Slow EMA (trend filter)

      // MACD (momentum)
      macdFastPeriod: 12,
      macdSlowPeriod: 26,
      macdSignalPeriod: 9,

      // RSI (momentum confirmation)
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      rsiSlopePeriod: 3,        // Bars for RSI slope (FIX #2)
      minRsiSlope: 0.5,         // Slope harus > 0.5 (LONG) / < -0.5 (SHORT) — momentum
                                // benar-benar membangun, bukan sekadar > 0 (FIX #4)

      // Momentum minimum — histogram MACD harus cukup kuat relatif ATR (scale-invariant,
      // berlaku lintas-simbol). Mengganti gagasan ">10" literal yang bergantung skala harga.
      macdHistMinAtrFrac: 0.10, // |histogram| >= 0.10 × ATR (FIX #2)

      // Pullback entry — wajib ada retracement nyata ke EMA lalu reclaim (FIX #3)
      pullbackLookback: 5,      // jumlah bar ke belakang untuk cari dip ke EMA
      pullbackTol: 0.001,       // toleransi 0.1% saat menilai "menyentuh" EMA

      // Volume confirmation (FIX #4)
      volSMAPeriod: 20,         // Period for volume SMA (entry TF)
      minVolRatio: 1.0,         // Minimum volume ratio (>= 1.0× SMA)

      // Risk management (MINT tier: conservative)
      riskPerTrade: 0.02,       // 2% per trade
      slMultiplier: 1.2,        // SL = 1.2×ATR (tight)
      tpMultiplier: 2.3,        // TP = 2.3×ATR (quality)
      leverage: 1.5,

      // Position management
      maxTradesPerDay: 6,
      minCapital: 10000000,     // Rp10M minimum
      trailingStopAtrMultiplier: 0.8,  // Trail after 50% TP

      // Exit management (FIX #8)
      maxBarsHeld: 100,             // Force close after N bars (timeout)
      breakEvenActivationPct: 0.2,  // Move SL to entry at 20% of TP reached
      partialProfitPct: 0.5,        // (reserved) close 50% at 50% TP
    };

    // Track open positions for trailing stop
    this._openTrades = [];

    // State management across bars (FIX #9)
    this._trendState = this._freshTrendState();
  }

  /**
   * Fresh trend state object (FIX #9)
   */
  _freshTrendState() {
    return {
      htfTrendConfirmed: false,   // Is HTF trend confirmed?
      htfTrendDirection: null,    // "LONG" | "SHORT" | null
      mtfMomentumStrength: 0,     // Last MACD histogram value
      lastRSISlope: 0,            // RSI slope from previous evaluation
      barsInCurrentTrend: 0,      // How many bars trend has persisted
    };
  }

  /**
   * Reset trend state (call on trade exit or HTF reversal) (FIX #9)
   */
  resetTrendState() {
    this._trendState = this._freshTrendState();
  }

  /**
   * Layer 1: Detect HTF trend (4H timeframe)
   * LONG: close > EMA21 > EMA50, fast > mid (uptrend structure)
   * SHORT: close < EMA21 < EMA50, fast < mid (downtrend structure)
   * Returns: "LONG" | "SHORT" | null
   */
  detectHTFTrend(htfClosesLast, emaFastHTF, emaMidHTF, emaSlowHTF) {
    if (!htfClosesLast || !emaFastHTF || !emaMidHTF || !emaSlowHTF) return null;

    const close = htfClosesLast;

    if (close > emaMidHTF && emaMidHTF > emaSlowHTF && emaFastHTF > emaMidHTF) {
      return "LONG";
    }

    if (close < emaMidHTF && emaMidHTF < emaSlowHTF && emaFastHTF < emaMidHTF) {
      return "SHORT";
    }

    return null;
  }

  /**
   * Layer 2: Calculate MACD momentum (delegates to indicators.calcMACD)
   * Returns: { macd, signal, histogram }
   */
  calculateMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    return calcMACD(closes, fastPeriod, slowPeriod, signalPeriod);
  }

  /**
   * RSI Slope: measure momentum strength (FIX #2)
   * Positive slope = momentum building, negative = weakening.
   * Uses last (period) RSI values; slope normalized per-bar.
   */
  calculateRSISlope(rsiValues, period = 3) {
    if (!rsiValues || rsiValues.length < period) return 0;

    const recentRSI = rsiValues.slice(-period);
    if (recentRSI.some(v => v === null || v === undefined)) return 0;

    const firstRSI = recentRSI[0];
    const lastRSI = recentRSI[recentRSI.length - 1];
    const slope = (lastRSI - firstRSI) / (period - 1);

    return slope;
  }

  /**
   * Pullback zone check (FIX #3 — pullback NYATA, bukan sekadar "stay above").
   * Entry pullback yang benar: harga RETRACE menyentuh EMA9 dalam beberapa bar
   * terakhir, LALU bar saat ini RECLAIM (close kembali ke sisi tren). Logika lama
   * hanya minta "close tetap di atas EMA 2 bar" → itu kelanjutan, bukan pullback,
   * dan sering entry di puncak retrace.
   *   LONG : ada bar sebelumnya yang dip ≤ EMA9, dan close kini > EMA9.
   *   SHORT: ada bar sebelumnya yang naik ≥ EMA9, dan close kini < EMA9.
   */
  isInPullbackZone(closesEntry, emaCurrEntry, direction) {
    const n = closesEntry?.length || 0;
    if (n < 3) return true; // history kurang → jangan blok
    const closeCurr = closesEntry[n - 1];
    const look = Math.min(this.config.pullbackLookback ?? 5, n - 1);
    const tol  = this.config.pullbackTol ?? 0.001;
    const prior = closesEntry.slice(n - 1 - look, n - 1); // bar sebelum bar saat ini

    if (direction === "LONG") {
      const resumed = closeCurr > emaCurrEntry;
      const dipped  = prior.some(c => c <= emaCurrEntry * (1 + tol)); // sempat retrace ke EMA
      return resumed && dipped;
    }
    const resumed = closeCurr < emaCurrEntry;
    const dipped  = prior.some(c => c >= emaCurrEntry * (1 - tol));
    return resumed && dipped;
  }

  /**
   * Layer 3: Check LONG entry (5m timeframe)
   */
  checkLongEntry(
    closesEntry,
    volumesEntry,
    emaCurrEntry,      // EMA9[5m]
    emaMidEntry,       // EMA21[5m]
    rsiEntry,
    volumeCurrentEntry,
    volumeSMAEntry,
    htfTrend,
    macdMTF,
    signalMTF,
    histogramMTF,
    rsiMTF,
    rsiSlopeMTF
  ) {
    if (!closesEntry || closesEntry.length === 0) return { valid: false, reason: "No entry closes" };

    const closeCurr = closesEntry[closesEntry.length - 1];

    // 1. HTF trend must be LONG
    if (htfTrend !== "LONG") {
      return { valid: false, reason: "HTF not in uptrend" };
    }

    // 2. MTF momentum checks
    if (macdMTF === null || signalMTF === null || histogramMTF === null) {
      return { valid: false, reason: "MACD not ready" };
    }

    const macdPositive = histogramMTF > 0;
    const rsiMomentum = rsiMTF !== null && rsiMTF > 50;
    const rsiMomentumBuild = rsiSlopeMTF > (this.config.minRsiSlope ?? 0.5);  // FIX #4

    if (!macdPositive || !rsiMomentum || !rsiMomentumBuild) {
      return { valid: false, reason: "MTF momentum not aligned" };
    }

    // 3. Entry conditions (5m)
    // Close > EMA9
    if (closeCurr <= emaCurrEntry) {
      return { valid: false, reason: `Close ${closeCurr.toFixed(2)} not above EMA9 ${emaCurrEntry.toFixed(2)}` };
    }

    // EMA9 > EMA21
    if (emaCurrEntry <= emaMidEntry) {
      return { valid: false, reason: "EMA9 not above EMA21 (no uptrend structure)" };
    }

    // Pullback zone — structure held over last 2 bars (FIX #6)
    if (!this.isInPullbackZone(closesEntry, emaCurrEntry, "LONG")) {
      return { valid: false, reason: "Not in pullback zone (broke below EMA9)" };
    }

    // RSI healthy momentum zone (symmetric 30-70) (FIX #5)
    if (rsiEntry === null || rsiEntry <= 30 || rsiEntry >= 70) {
      return { valid: false, reason: `RSI ${rsiEntry?.toFixed(1) || "null"} outside 30-70 healthy range` };
    }

    // Volume confirmation (FIX #4: minVolRatio)
    if (volumeCurrentEntry < volumeSMAEntry * this.config.minVolRatio) {
      return { valid: false, reason: `Volume ${volumeCurrentEntry.toFixed(0)} below ${this.config.minVolRatio}× SMA ${volumeSMAEntry.toFixed(0)}` };
    }

    return { valid: true, reason: "All LONG conditions met" };
  }

  /**
   * Layer 3: Check SHORT entry (5m timeframe) — mirror of LONG
   */
  checkShortEntry(
    closesEntry,
    volumesEntry,
    emaCurrEntry,      // EMA9[5m]
    emaMidEntry,       // EMA21[5m]
    rsiEntry,
    volumeCurrentEntry,
    volumeSMAEntry,
    htfTrend,
    macdMTF,
    signalMTF,
    histogramMTF,
    rsiMTF,
    rsiSlopeMTF
  ) {
    if (!closesEntry || closesEntry.length === 0) return { valid: false, reason: "No entry closes" };

    const closeCurr = closesEntry[closesEntry.length - 1];

    // 1. HTF trend must be SHORT
    if (htfTrend !== "SHORT") {
      return { valid: false, reason: "HTF not in downtrend" };
    }

    // 2. MTF momentum checks
    if (macdMTF === null || signalMTF === null || histogramMTF === null) {
      return { valid: false, reason: "MACD not ready" };
    }

    const macdNegative = histogramMTF < 0;
    const rsiMomentum = rsiMTF !== null && rsiMTF < 50;
    const rsiMomentumBuild = rsiSlopeMTF < -(this.config.minRsiSlope ?? 0.5);  // FIX #4

    if (!macdNegative || !rsiMomentum || !rsiMomentumBuild) {
      return { valid: false, reason: "MTF momentum not aligned" };
    }

    // 3. Entry conditions (5m)
    // Close < EMA9
    if (closeCurr >= emaCurrEntry) {
      return { valid: false, reason: `Close ${closeCurr.toFixed(2)} not below EMA9 ${emaCurrEntry.toFixed(2)}` };
    }

    // EMA9 < EMA21
    if (emaCurrEntry >= emaMidEntry) {
      return { valid: false, reason: "EMA9 not below EMA21 (no downtrend structure)" };
    }

    // Pullback zone — structure held over last 2 bars (FIX #6)
    if (!this.isInPullbackZone(closesEntry, emaCurrEntry, "SHORT")) {
      return { valid: false, reason: "Not in pullback zone (broke above EMA9)" };
    }

    // RSI healthy momentum zone (symmetric 30-70) (FIX #5)
    if (rsiEntry === null || rsiEntry <= 30 || rsiEntry >= 70) {
      return { valid: false, reason: `RSI ${rsiEntry?.toFixed(1) || "null"} outside 30-70 healthy range` };
    }

    // Volume confirmation (FIX #4: minVolRatio)
    if (volumeCurrentEntry < volumeSMAEntry * this.config.minVolRatio) {
      return { valid: false, reason: `Volume ${volumeCurrentEntry.toFixed(0)} below ${this.config.minVolRatio}× SMA ${volumeSMAEntry.toFixed(0)}` };
    }

    return { valid: true, reason: "All SHORT conditions met" };
  }

  /**
   * Main signal detection (3-layer approach with multi-TF support) (FIX #1)
   */
  detectSignal(indicators, lastIdx, config = {}) {
    if (lastIdx < 50) return null;

    // Entry TF (5m) — slice to lastIdx to avoid lookahead bias
    const closesEntry = (indicators.closes || []).slice(0, lastIdx + 1);
    const volumesEntry = (indicators.volumes || []).slice(0, lastIdx + 1);
    const atr = indicators.atr?.[lastIdx];
    const rsiEntry = indicators.rsi?.[lastIdx];
    const emaFastEntry = indicators.emaFast?.[lastIdx];   // EMA9
    const emaMidEntry = indicators.emaSlow?.[lastIdx];    // EMA21
    const volumeCurrentEntry = volumesEntry[volumesEntry.length - 1];
    const volumeSMAEntry = indicators.volSMA?.[lastIdx] || 0;

    if (!atr || !rsiEntry || !emaFastEntry || !emaMidEntry) return null;

    // ── Index alignment for multi-TF arrays (FIX #1) ──
    const hasHTF = Array.isArray(indicators.closesHTF);
    const hasMTF = Array.isArray(indicators.macd15m);
    const idxHTF = hasHTF ? Math.floor(lastIdx / (this.config.htfRatio || 48)) : lastIdx;
    const idxMTF = hasMTF ? Math.floor(lastIdx / (this.config.mtfRatio || 3)) : lastIdx;

    // ── Layer 1: HTF trend (real HTF arrays if provided, else entry-TF proxy) ──
    const htfClose   = indicators.closesHTF?.[idxHTF]  ?? closesEntry[closesEntry.length - 1];
    const htfEmaFast = indicators.emaFastHTF?.[idxHTF] ?? emaFastEntry;
    const htfEmaMid  = indicators.emaMidHTF?.[idxHTF]  ?? emaMidEntry;
    const htfEmaSlow = indicators.emaSlowHTF?.[idxHTF] ?? indicators.emaTrend?.[lastIdx] ?? null;

    const htfTrend = this.detectHTFTrend(htfClose, htfEmaFast, htfEmaMid, htfEmaSlow);

    // Reset state if HTF trend reversed (FIX #9)
    if (this._trendState.htfTrendDirection && htfTrend && htfTrend !== this._trendState.htfTrendDirection) {
      this.resetTrendState();
    }

    if (!htfTrend) {
      this._trendState.htfTrendConfirmed = false;
      return null;
    }

    // ── Layer 2: MTF momentum (real MTF → calcIndicators MACD → on-the-fly) ──
    let macdMTF, signalMTF, histogramMTF, rsiMTF, rsiSlopeMTF;
    const slopePeriod = this.config.rsiSlopePeriod || 3;

    if (hasMTF && indicators.signal15m && indicators.histogram15m) {
      macdMTF = indicators.macd15m[idxMTF];
      signalMTF = indicators.signal15m[idxMTF];
      histogramMTF = indicators.histogram15m[idxMTF];
      rsiMTF = indicators.rsi15m?.[idxMTF] ?? rsiEntry;
      rsiSlopeMTF = this.calculateRSISlope((indicators.rsi15m || []).slice(0, idxMTF + 1), slopePeriod);
    } else if (indicators.macd && indicators.macdSignal && indicators.macdHistogram) {
      // MACD precomputed in calcIndicators (entry TF) — no lookahead, index by lastIdx
      macdMTF = indicators.macd[lastIdx];
      signalMTF = indicators.macdSignal[lastIdx];
      histogramMTF = indicators.macdHistogram[lastIdx];
      rsiMTF = rsiEntry;
      rsiSlopeMTF = this.calculateRSISlope((indicators.rsi || []).slice(0, lastIdx + 1), slopePeriod);
    } else {
      // Fallback: compute MACD from entry closes up to lastIdx (no lookahead)
      const macdCalc = this.calculateMACD(closesEntry);
      macdMTF = macdCalc.macd[lastIdx];
      signalMTF = macdCalc.signal[lastIdx];
      histogramMTF = macdCalc.histogram[lastIdx];
      rsiMTF = rsiEntry;
      rsiSlopeMTF = this.calculateRSISlope((indicators.rsi || []).slice(0, lastIdx + 1), slopePeriod);
    }

    // ── Update trend state (FIX #9) ──
    this._trendState.htfTrendConfirmed = true;
    this._trendState.htfTrendDirection = htfTrend;
    this._trendState.mtfMomentumStrength = histogramMTF || 0;
    this._trendState.lastRSISlope = rsiSlopeMTF;
    this._trendState.barsInCurrentTrend += 1;

    // ── Momentum minimum (FIX #2): histogram MACD harus cukup kuat relatif ATR.
    // Menyaring crossover lemah/flat (momentum ~nol) yang sering jadi whipsaw.
    // Scale-invariant: histogram & ATR sama-sama satuan harga → berlaku lintas-simbol.
    const minHist = atr * (this.config.macdHistMinAtrFrac ?? 0.10);
    if (histogramMTF === null || Math.abs(histogramMTF) < minHist) {
      return null;
    }

    // ── Layer 3: entry checks ──
    const longCheck = this.checkLongEntry(
      closesEntry, volumesEntry, emaFastEntry, emaMidEntry, rsiEntry,
      volumeCurrentEntry, volumeSMAEntry,
      htfTrend, macdMTF, signalMTF, histogramMTF, rsiMTF, rsiSlopeMTF
    );

    if (longCheck.valid) return "LONG";

    const shortCheck = this.checkShortEntry(
      closesEntry, volumesEntry, emaFastEntry, emaMidEntry, rsiEntry,
      volumeCurrentEntry, volumeSMAEntry,
      htfTrend, macdMTF, signalMTF, histogramMTF, rsiMTF, rsiSlopeMTF
    );

    if (shortCheck.valid) return "SHORT";

    return null;
  }

  /**
   * Calculate SL/TP based on ATR
   * SL = 1.2×ATR, TP = 2.3×ATR → RR = 1.92 ≈ 1:2.3
   */
  calculateRiskConfig(entryPrice, atr, signal) {
    const slDist = atr * this.config.slMultiplier;
    const tpDist = atr * this.config.tpMultiplier;

    let stopLoss, takeProfit;

    if (signal === "LONG") {
      stopLoss = entryPrice - slDist;
      takeProfit = entryPrice + tpDist;
    } else {  // SHORT
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
   * Position sizing based on risk (FIX #7)
   * Returns the quantity to trade given account balance and SL distance.
   */
  calculatePositionSize(balance, entryPrice, stopLossPrice, riskPercentage = null, leverage = null) {
    const riskPct = riskPercentage ?? this.config.riskPerTrade;
    const lev = leverage ?? this.config.leverage;

    if (!balance || balance <= 0 || !entryPrice || entryPrice <= 0) return 0;

    const riskAmount = balance * riskPct;
    const slDistance = Math.abs(entryPrice - stopLossPrice);
    if (slDistance === 0) return 0;

    const baseQty = riskAmount / slDistance;
    const leveragedQty = baseQty * lev;

    // Cap: notional cannot exceed balance × leverage (margin safety)
    const maxNotional = balance * lev;
    const notional = leveragedQty * entryPrice;
    if (notional > maxNotional) {
      return parseFloat((maxNotional / entryPrice).toFixed(8));
    }

    return parseFloat(leveragedQty.toFixed(8));
  }

  /**
   * Move SL to break-even once price has run breakEvenActivationPct of TP (FIX #8)
   */
  applyBreakevenStop(trade, currentPrice) {
    const tpDist = Math.abs(trade.takeProfit - trade.entryPrice);
    const activation = tpDist * this.config.breakEvenActivationPct;

    if (trade.direction === "LONG") {
      if (currentPrice >= trade.entryPrice + activation && trade.stopLoss < trade.entryPrice) {
        trade.stopLoss = trade.entryPrice;
        trade.breakEvenActive = true;
      }
    } else if (trade.direction === "SHORT") {
      if (currentPrice <= trade.entryPrice - activation && trade.stopLoss > trade.entryPrice) {
        trade.stopLoss = trade.entryPrice;
        trade.breakEvenActive = true;
      }
    }
  }

  /**
   * Update trailing stop — after reaching 50% of TP, trail by 0.8×ATR
   */
  updateTrailingStop(trade, currentPrice, atr) {
    const tpDist = atr * this.config.tpMultiplier;
    const halfTPDist = tpDist * 0.5;

    if (trade.direction === "LONG") {
      const halfTP = trade.entryPrice + halfTPDist;

      if (currentPrice >= halfTP) {
        const trailDist = atr * this.config.trailingStopAtrMultiplier;
        const newSL = currentPrice - trailDist;

        if (newSL > trade.stopLoss) {
          trade.stopLoss = newSL;
          trade.trailingStopActive = true;
        }
      }
    } else if (trade.direction === "SHORT") {
      const halfTP = trade.entryPrice - halfTPDist;

      if (currentPrice <= halfTP) {
        const trailDist = atr * this.config.trailingStopAtrMultiplier;
        const newSL = currentPrice + trailDist;

        if (newSL < trade.stopLoss) {
          trade.stopLoss = newSL;
          trade.trailingStopActive = true;
        }
      }
    }
  }

  /**
   * Complete exit decision for an open trade (FIX #8)
   * Priority: Stop Loss → Take Profit → Timeout
   * Returns: { exit: bool, reason, price }
   */
  checkExit(trade, candle, barsHeld = 0) {
    const { high, low, close } = candle;

    // 1. Stop loss
    if (trade.direction === "LONG" && low <= trade.stopLoss) {
      return { exit: true, reason: "SL", price: trade.stopLoss };
    }
    if (trade.direction === "SHORT" && high >= trade.stopLoss) {
      return { exit: true, reason: "SL", price: trade.stopLoss };
    }

    // 2. Take profit
    if (trade.direction === "LONG" && high >= trade.takeProfit) {
      return { exit: true, reason: "TP", price: trade.takeProfit };
    }
    if (trade.direction === "SHORT" && low <= trade.takeProfit) {
      return { exit: true, reason: "TP", price: trade.takeProfit };
    }

    // 3. Timeout (opportunity cost)
    if (barsHeld >= this.config.maxBarsHeld) {
      return { exit: true, reason: "TIMEOUT", price: close };
    }

    return { exit: false, reason: null, price: null };
  }

  /**
   * Validate market conditions
   * Best: ATR 0.5-8%, trend strength > 0.4
   */
  validateMarketCondition(volatility = 0, trendStrength = 0) {
    const atrPct = volatility;

    if (atrPct < 0.5) {
      return { valid: false, reason: `Market too dead (ATR ${atrPct.toFixed(2)}% < 0.5%)` };
    }

    if (atrPct > 8) {
      return { valid: false, reason: `Market too volatile (ATR ${atrPct.toFixed(2)}% > 8%)` };
    }

    if (trendStrength < 0.4) {
      return { valid: false, reason: `No clear trend (strength ${trendStrength.toFixed(2)} < 0.4)` };
    }

    return { valid: true, reason: "Market suitable for trend trading" };
  }

  /**
   * Rank strategy by market conditions
   */
  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 0, trendStrength = 0 } = marketConditions;

    let score = 50;

    if (trendStrength >= 0.6) score += 25;
    else if (trendStrength >= 0.4) score += 15;
    else score -= 20;

    if (volatility >= 0.5 && volatility <= 4) score += 15;
    else if (volatility > 4) score -= 10;

    return this.clamp(score, 0, 100);
  }

  /**
   * Risk configuration
   */
  getRiskConfig() {
    return {
      riskPerTrade: this.config.riskPerTrade,
      maxRiskPerTrade: 0.03,
      maxDailyLossPct: 0.06,
      maxTradesPerDay: this.config.maxTradesPerDay,
      cooldownAfterLoss: 10,
      maxConsecLoss: 2,
      leverage: this.config.leverage,
    };
  }

  /**
   * Timeframe configuration
   */
  getTimeframeConfig() {
    return {
      interval: this.config.entryInterval,
      higherTf: this.config.mtfInterval,
      checkInterval: 300000,  // 5 minutes
    };
  }

  /**
   * Expose last signal metadata for BotEngine logging (FIX #11)
   */
  getLastSignalMeta() {
    return {
      direction: this._trendState.htfTrendDirection,
      htfTrendConfirmed: this._trendState.htfTrendConfirmed,
      momentumStrength: this._trendState.mtfMomentumStrength,
      rsiSlope: this._trendState.lastRSISlope,
      barsInTrend: this._trendState.barsInCurrentTrend,
    };
  }

  /**
   * Validasi kondisi entry terakhir sebelum eksekusi (gate engine).
   * Trend-momentum butuh pasar yang bergerak (ATR cukup) dan partisipasi volume.
   * Konfirmasi arah utama sudah ditangani detectSignal (HTF trend + MACD + RSI slope
   * + pullback zone).
   */
  validateEntry(price, atr, volume, volSMA) {
    if (!price || !atr) return { valid: true, reason: "Data tidak lengkap — lewati gate" };
    const atrPct   = (atr / price) * 100;
    const volRatio = volSMA > 0 ? volume / volSMA : 1;
    if (atrPct < 0.25 || atrPct > 5.0) {
      return { valid: false, reason: `ATR ${atrPct.toFixed(2)}% di luar rentang sehat (0.25–5.0%)` };
    }
    if (volRatio < 0.7) {
      return { valid: false, reason: `Volume ${volRatio.toFixed(2)}× di bawah ambang (0.7×)` };
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

module.exports = TrendMomentumStrategy;
