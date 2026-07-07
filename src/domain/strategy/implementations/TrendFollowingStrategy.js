/**
 * TrendFollowingStrategy.js — Trend Following (TS_TF)
 *
 * Philosophy: "Mengikuti tren setelah terkonfirmasi"
 * - Multi-timeframe: 1h HTF trend, 15m confirmation, 5m entry
 * - Entry: EMA/SMA crossover, Donchian breakout, ADX strength gate
 * - Trade type: Intraday + Swing (medium holding)
 * - Best for: FORGE tier (Rp15-30M, 54-58% WR, 100-180% annual)
 *
 * 3-Layer Confirmation:
 * 1. HTF (1h): Trend direction via EMA alignment + ADX strength
 * 2. MTF (15m): Breakout confirmation via Donchian channel
 * 3. Entry (5m): Pullback retest via EMA crossover + volume
 *
 * Indikator: EMA9/21/50, SMA, Donchian Channel, ADX, ATR, Volume
 */

const StrategyBase = require("../base/StrategyBase");
const { calcEMA, calcSMA, calcDonchian, calcADX, calcATR } = require("../../indicators");
const { checkHTFRegime } = require("../../htfRegimeFilter");

class TrendFollowingStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "TREND_FOLLOWING",
      label: "Trend Following Strategy",
      description:
        "Multi-timeframe trend following using EMA/SMA, Donchian Channel, ADX, and ATR. " +
        "Confirms trend strength, enters on breakout with pullback retest. " +
        "Medium-term holding, strong risk-reward. Best for FORGE tier (Rp15-30M).",
      version: "1.0.0",
      enabled: true,
      ...config,
    });

    this.config = {
      ...this.config,
      // Timeframes (multi-TF strategy)
      htfInterval: "1h",        // Higher TF for trend direction
      mtfInterval: "15m",       // Middle TF for confirmation
      entryInterval: "5m",      // Entry TF for precision

      // Multi-TF index alignment ratios
      mtfRatio: 3,              // 15m / 5m  = 3
      htfRatio: 12,             // 1h  / 5m  = 12

      // EMAs & SMAs (trend structure)
      emaTrendFast: 9,          // Fast EMA (entry signal)
      emaTrendMid: 21,          // Mid EMA (structure)
      emaTrendSlow: 50,         // Slow EMA (trend filter)
      smaTrendFast: 9,          // SMA for crossover confirmation
      smaTrendMid: 21,          // SMA for trend

      // Donchian Channel (breakout detection)
      donchianPeriod: 20,       // Last 20 bars for channel

      // ADX (trend strength gate)
      adxPeriod: 14,
      adxMinStrength: 25,       // Require ADX > 25 for strong trend (tidak sideways)

      // RSI (momentum filter)
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,

      // Volume confirmation
      volSMAPeriod: 20,
      minVolRatio: 1.0,         // Minimum volume ratio (>= 1.0× SMA)

      // Risk management
      riskPerTrade: 0.015,      // 1.5% per trade (medium-term holding)
      slMultiplier: 1.5,        // SL = 1.5×ATR (wider than momentum)
      tpMultiplier: 3.0,        // TP = 3.0×ATR → RR ~1:2.0
      leverage: 2.0,            // 2x for FORGE tier

      // Position management
      maxTradesPerDay: 3,       // Fewer, high-conviction trades
      minCapital: 15000000,     // Rp15M minimum (FORGE tier)
      trailingStopAtrMultiplier: 1.0,  // Trail 1.0×ATR after 50% TP

      // Take-profit mode
      tpMode: "partial",        // 50% at 1.5R, trail rest

      // Exit management
      maxBarsHeld: 100,
      breakEvenActivationPct: 0.25,
      partialProfitPct: 0.5,    // Close 50% at 1.5R
    };

    this._openTrades = [];
    this._trendState = this._freshTrendState();
    // WeakMap keyed by the `indicators.highs` array reference — avoids recomputing
    // the fallback Donchian channel on every single bar (see detectSignal below).
    // WeakMap (not a plain field) so different bots/symbols sharing this singleton
    // instance never leak a cached channel from one symbol's candles into another's.
    this._donchianCache = new WeakMap();
  }

  _freshTrendState() {
    return {
      htfTrendConfirmed: false,
      htfTrendDirection: null,    // "LONG" | "SHORT" | null
      htfAdxStrength: 0,          // ADX value on HTF
      donchianBroken: false,      // Breakout detected?
      barsInTrend: 0,
    };
  }

  resetTrendState() {
    this._trendState = this._freshTrendState();
  }

  /**
   * Layer 1: Detect HTF trend via EMA alignment + ADX strength
   * Trend must be strong (ADX > threshold) to avoid sideways traps.
   * @returns "LONG" | "SHORT" | null
   */
  detectHTFTrend(htfClosesLast, emaFastHTF, emaMidHTF, emaSlowHTF, adxHTF) {
    if (!htfClosesLast || !emaFastHTF || !emaMidHTF || !emaSlowHTF) return null;

    const close = htfClosesLast;
    const adxMin = this.config.adxMinStrength ?? 25;

    // LONG: EMA aligned upward, price above structure, ADX strong
    if (
      emaFastHTF > emaMidHTF && emaMidHTF > emaSlowHTF &&
      close > emaMidHTF &&
      (adxHTF == null || adxHTF >= adxMin)
    ) {
      return "LONG";
    }

    // SHORT: EMA aligned downward, price below structure, ADX strong
    if (
      emaFastHTF < emaMidHTF && emaMidHTF < emaSlowHTF &&
      close < emaMidHTF &&
      (adxHTF == null || adxHTF >= adxMin)
    ) {
      return "SHORT";
    }

    return null;
  }

  /**
   * Layer 2: Check Donchian breakout on MTF (confirmation of trend)
   * LONG: close > upper channel (previous bar), or hold above after breakout
   * SHORT: close < lower channel (previous bar), or hold below after breakout
   */
  isDonchianBroken(closesEntry, donchianUpper, donchianLower, direction) {
    const n = closesEntry?.length || 0;
    if (n < 2) return false;

    const closeCurr = closesEntry[n - 1];
    const closePrev = closesEntry[n - 2];

    if (direction === "LONG") {
      // Breakout: prev <= upper, curr > upper (fresh break)
      // atau sustained: curr > upper (holding breakout)
      return closeCurr > donchianUpper;
    }
    // SHORT: opposite
    return closeCurr < donchianLower;
  }

  /**
   * Layer 3: Check LONG entry (5m) — pullback retest
   * After breakout confirmed, wait for pullback to EMA9/21 + retest above
   */
  checkLongEntry(
    closesEntry,
    volumesEntry,
    emaFastEntry,    // EMA9[5m]
    emaMidEntry,     // EMA21[5m]
    rsiEntry,
    volumeCurrentEntry,
    volumeSMAEntry,
    htfTrend,
    donchianBroken,
    donchianUpperMTF,
    adxHTF
  ) {
    if (!closesEntry || closesEntry.length === 0) {
      return { valid: false, reason: "No entry closes" };
    }

    const closeCurr = closesEntry[closesEntry.length - 1];

    // 1. HTF trend must be LONG
    if (htfTrend !== "LONG") {
      return { valid: false, reason: "HTF not in uptrend" };
    }

    // 2. ADX must be strong (avoid sideways)
    const adxMin = this.config.adxMinStrength ?? 25;
    if (adxHTF != null && adxHTF < adxMin) {
      return { valid: false, reason: `ADX ${adxHTF.toFixed(1)} below strength threshold ${adxMin}` };
    }

    // 3. Donchian breakout confirmed
    if (!donchianBroken) {
      return { valid: false, reason: "No Donchian breakout confirmation" };
    }

    // 4. Entry conditions (5m pullback retest)
    // Close > EMA9
    if (closeCurr <= emaFastEntry) {
      return { valid: false, reason: `Close not above EMA9 (pullback too deep)` };
    }

    // EMA9 > EMA21 (uptrend structure held)
    if (emaFastEntry <= emaMidEntry) {
      return { valid: false, reason: "EMA9 not above EMA21 (structure broken)" };
    }

    // RSI healthy zone (avoid overbought)
    if (rsiEntry == null || rsiEntry < 30 || rsiEntry > 70) {
      return { valid: false, reason: `RSI ${rsiEntry?.toFixed(1) || "null"} outside 30-70` };
    }

    // Volume confirmation
    if (volumeCurrentEntry < volumeSMAEntry * this.config.minVolRatio) {
      return { valid: false, reason: `Volume below ${this.config.minVolRatio}× SMA` };
    }

    return { valid: true, reason: "All LONG conditions met" };
  }

  /**
   * Layer 3: Check SHORT entry (5m) — mirror of LONG
   */
  checkShortEntry(
    closesEntry,
    volumesEntry,
    emaFastEntry,    // EMA9[5m]
    emaMidEntry,     // EMA21[5m]
    rsiEntry,
    volumeCurrentEntry,
    volumeSMAEntry,
    htfTrend,
    donchianBroken,
    donchianLowerMTF,
    adxHTF
  ) {
    if (!closesEntry || closesEntry.length === 0) {
      return { valid: false, reason: "No entry closes" };
    }

    const closeCurr = closesEntry[closesEntry.length - 1];

    if (htfTrend !== "SHORT") {
      return { valid: false, reason: "HTF not in downtrend" };
    }

    const adxMin = this.config.adxMinStrength ?? 25;
    if (adxHTF != null && adxHTF < adxMin) {
      return { valid: false, reason: `ADX too low for short` };
    }

    if (!donchianBroken) {
      return { valid: false, reason: "No Donchian breakout confirmation" };
    }

    if (closeCurr >= emaFastEntry) {
      return { valid: false, reason: `Close not below EMA9` };
    }

    if (emaFastEntry >= emaMidEntry) {
      return { valid: false, reason: "EMA9 not below EMA21" };
    }

    if (rsiEntry == null || rsiEntry < 30 || rsiEntry > 70) {
      return { valid: false, reason: `RSI outside 30-70` };
    }

    if (volumeCurrentEntry < volumeSMAEntry * this.config.minVolRatio) {
      return { valid: false, reason: `Volume below threshold` };
    }

    return { valid: true, reason: "All SHORT conditions met" };
  }

  /**
   * Main signal detection (3-layer with multi-TF)
   */
  detectSignal(indicators, lastIdx, config = {}) {
    if (lastIdx < 50) return null;

    // Entry TF (5m)
    const closesEntry = (indicators.closes || []).slice(0, lastIdx + 1);
    const volumesEntry = (indicators.volumes || []).slice(0, lastIdx + 1);
    const atr = indicators.atr?.[lastIdx];
    const rsiEntry = indicators.rsi?.[lastIdx];
    const emaFastEntry = indicators.emaFast?.[lastIdx];   // EMA9
    const emaMidEntry = indicators.emaSlow?.[lastIdx];    // EMA21
    const volumeCurrentEntry = volumesEntry[volumesEntry.length - 1];
    const volumeSMAEntry = indicators.volSMA?.[lastIdx] || 0;

    if (!atr || !rsiEntry || !emaFastEntry || !emaMidEntry) return null;

    // Index alignment
    const hasHTF = Array.isArray(indicators.closesHTF);
    const hasMTF = Array.isArray(indicators.macd15m);
    const idxHTF = hasHTF ? Math.floor(lastIdx / (this.config.htfRatio || 12)) : lastIdx;
    const idxMTF = hasMTF ? Math.floor(lastIdx / (this.config.mtfRatio || 3)) : lastIdx;

    // AF-SCALP-24: Layer 1 — HTF trend (enabled in backtest via indicators injection)
    // Live path: htfTrend passed via config.htfTrend from BotEngine (status quo)
    // Backtest path: read from indicators.closesHTF/emaFastHTF/emaMidHTF/emaSlowHTF/adxHTF
    const htfClose   = indicators.closesHTF?.[idxHTF] ?? closesEntry[closesEntry.length - 1];
    const htfEmaFast = indicators.emaFastHTF?.[idxHTF] ?? emaFastEntry;
    const htfEmaMid  = indicators.emaMidHTF?.[idxHTF] ?? emaMidEntry;
    const htfEmaSlow = indicators.emaSlowHTF?.[idxHTF] ?? indicators.emaTrend?.[lastIdx] ?? null;
    const htfAdx     = indicators.adxHTF?.[idxHTF] ?? null;

    const htfTrend = this.detectHTFTrend(htfClose, htfEmaFast, htfEmaMid, htfEmaSlow, htfAdx);

    if (this._trendState.htfTrendDirection && htfTrend && htfTrend !== this._trendState.htfTrendDirection) {
      this.resetTrendState();
    }

    if (!htfTrend) {
      this._trendState.htfTrendConfirmed = false;
      return null;
    }

    // Layer 2: MTF Donchian breakout
    let donchianBroken = false;
    let donchianUpperMTF = null;
    let donchianLowerMTF = null;

    if (hasMTF && indicators.donchian15m) {
      const dc = indicators.donchian15m;
      donchianUpperMTF = dc.upper?.[idxMTF];
      donchianLowerMTF = dc.lower?.[idxMTF];
      const mtfCloses = (indicators.closes15m || []).slice(0, idxMTF + 1);
      if (mtfCloses.length > 0) {
        donchianBroken = this.isDonchianBroken(mtfCloses, donchianUpperMTF, donchianLowerMTF, htfTrend);
      }
    } else {
      // Compute Donchian on entry TF as fallback (memoized — see constructor comment;
      // calcDonchian scans the full array, so recomputing it fresh on every bar was
      // O(n²) over the backtest range).
      const highs = indicators.highs || [];
      const lows = indicators.lows || [];
      let dc = this._donchianCache.get(highs);
      if (!dc) {
        dc = calcDonchian(highs, lows, this.config.donchianPeriod || 20);
        this._donchianCache.set(highs, dc);
      }
      // BUG FIX: dc.upper[lastIdx]/dc.lower[lastIdx] include the CURRENT bar's own
      // high/low in their rolling window, so close[lastIdx] can never exceed
      // upper[lastIdx] (close <= high <= upper by construction) or undercut
      // lower[lastIdx] (close >= low >= lower) — the breakout condition was
      // mathematically unreachable, meaning TS_TF could never enter a trade via
      // this fallback path (the only path ever exercised — nothing in the codebase
      // populates indicators.donchian15m, so the `if (hasMTF...)` branch above never
      // runs). Compare against the PRIOR bar's channel instead (excludes the current
      // bar), which is how a breakout is actually defined: today's close vs.
      // yesterday's N-period high/low.
      donchianUpperMTF = dc.upper?.[lastIdx - 1];
      donchianLowerMTF = dc.lower?.[lastIdx - 1];
      donchianBroken = this.isDonchianBroken(closesEntry, donchianUpperMTF, donchianLowerMTF, htfTrend);
    }

    this._trendState.htfTrendConfirmed = true;
    this._trendState.htfTrendDirection = htfTrend;
    this._trendState.htfAdxStrength = htfAdx || 0;
    this._trendState.donchianBroken = donchianBroken;
    this._trendState.barsInTrend += 1;

    // Layer 3: Entry checks
    const longCheck = this.checkLongEntry(
      closesEntry, volumesEntry, emaFastEntry, emaMidEntry, rsiEntry,
      volumeCurrentEntry, volumeSMAEntry,
      htfTrend, donchianBroken, donchianUpperMTF, htfAdx
    );

    if (longCheck.valid) {
      if (config.tierOverrides?.regimeFilterRequired) {
        const regimeCheck = checkHTFRegime({
          direction: 'LONG',
          htfData: {
            ema9: htfEmaFast,
            ema50: htfEmaSlow,
            ema200: indicators.ema200HTF?.[idxHTF] ?? null,
          },
          required: true,
        });
        if (!regimeCheck.allowed) return null;
      }
      return "LONG";
    }

    const shortCheck = this.checkShortEntry(
      closesEntry, volumesEntry, emaFastEntry, emaMidEntry, rsiEntry,
      volumeCurrentEntry, volumeSMAEntry,
      htfTrend, donchianBroken, donchianLowerMTF, htfAdx
    );

    if (shortCheck.valid) {
      if (config.tierOverrides?.regimeFilterRequired) {
        const regimeCheck = checkHTFRegime({
          direction: 'SHORT',
          htfData: {
            ema9: htfEmaFast,
            ema50: htfEmaSlow,
            ema200: indicators.ema200HTF?.[idxHTF] ?? null,
          },
          required: true,
        });
        if (!regimeCheck.allowed) return null;
      }
      return "SHORT";
    }

    return null;
  }

  // AF-SCALP-21: accept the engine's per-run overrides (5th arg), matching the
  // SMC contract. Before this, the 3-arg signature silently DISCARDED the
  // slMultiplier/tpMultiplier the backtest engine passes (built from
  // cfg.slAtrMult / typeOverrides) — every SL/TP knob for TS_TF (FE "SL
  // Multiplier" atrMult 1.3, "TP Multiplier" riskReward 1.92) was a dead knob,
  // and TF always traded the constructor defaults SL 1.5×ATR / TP 3.0×ATR
  // (CSV cross-check: all 91 rows show Planned R:R 2.0 = 3.0/1.5, never 1.92).
  // Live engines pass no slMultiplier/tpMultiplier in opts → fallback keeps
  // live behavior byte-identical.
  calculateRiskConfig(entryPrice, atr, signal, _component, opts = {}) {
    const slMult = opts.slMultiplier ?? this.config.slMultiplier;
    const tpMult = opts.tpMultiplier ?? this.config.tpMultiplier;
    const slDist = atr * slMult;
    const tpDist = atr * tpMult;

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
      slMultiplier: slMult,
      tpMultiplier: tpMult,
    };
  }

  calculatePositionSize(balance, entryPrice, stopLossPrice, riskPercentage = null, leverage = null) {
    const riskPct = riskPercentage ?? this.config.riskPerTrade;
    const lev = leverage ?? this.config.leverage;

    if (!balance || balance <= 0 || !entryPrice || entryPrice <= 0) return 0;

    const riskAmount = balance * riskPct;
    const slDistance = Math.abs(entryPrice - stopLossPrice);
    if (slDistance === 0) return 0;

    const baseQty = riskAmount / slDistance;
    const leveragedQty = baseQty * lev;

    const maxNotional = balance * lev;
    const notional = leveragedQty * entryPrice;
    if (notional > maxNotional) {
      return parseFloat((maxNotional / entryPrice).toFixed(8));
    }

    return parseFloat(leveragedQty.toFixed(8));
  }

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

  checkExit(trade, candle, barsHeld = 0) {
    const { high, low, close } = candle;

    if (trade.direction === "LONG" && low <= trade.stopLoss) {
      return { exit: true, reason: "SL", price: trade.stopLoss };
    }
    if (trade.direction === "SHORT" && high >= trade.stopLoss) {
      return { exit: true, reason: "SL", price: trade.stopLoss };
    }

    if (trade.direction === "LONG" && high >= trade.takeProfit) {
      return { exit: true, reason: "TP", price: trade.takeProfit };
    }
    if (trade.direction === "SHORT" && low <= trade.takeProfit) {
      return { exit: true, reason: "TP", price: trade.takeProfit };
    }

    if (barsHeld >= this.config.maxBarsHeld) {
      return { exit: true, reason: "TIMEOUT", price: close };
    }

    return { exit: false, reason: null, price: null };
  }

  validateMarketCondition(volatility = 0, trendStrength = 0) {
    const atrPct = volatility;

    if (atrPct < 0.5) {
      return { valid: false, reason: `Market too dead (ATR ${atrPct.toFixed(2)}% < 0.5%)` };
    }

    if (atrPct > 8) {
      return { valid: false, reason: `Market too volatile (ATR ${atrPct.toFixed(2)}% > 8%)` };
    }

    const trendMin = this.config.adxMinStrength ?? 25;
    if (trendStrength < trendMin) {
      return { valid: false, reason: `No clear trend (ADX ${trendStrength.toFixed(1)} < ${trendMin})` };
    }

    return { valid: true, reason: "Market suitable for trend following" };
  }

  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 0, trendStrength = 0 } = marketConditions;

    let score = 50;

    if (trendStrength >= 30) score += 30;
    else if (trendStrength >= 20) score += 15;
    else score -= 25;

    if (volatility >= 0.5 && volatility <= 6) score += 20;
    else if (volatility > 6) score -= 15;

    return this.clamp(score, 0, 100);
  }

  getRiskConfig() {
    return {
      riskPerTrade: this.config.riskPerTrade,
      maxRiskPerTrade: 0.03,
      maxDailyLossPct: 0.06,
      maxTradesPerDay: this.config.maxTradesPerDay,
      cooldownAfterLoss: 15,
      maxConsecLoss: 2,
      leverage: this.config.leverage,
    };
  }

  getTimeframeConfig() {
    return {
      interval: this.config.entryInterval,
      higherTf: this.config.mtfInterval,
      checkInterval: 300000,
    };
  }

  getLastSignalMeta() {
    return {
      component: "Swing",  // Trend Following = trend-continuation swing trades (Type Trade label)
      marketCond: this._trendState.htfTrendConfirmed ? "STRONG_TREND" : "NORMAL",
      direction: this._trendState.htfTrendDirection,
      htfTrendConfirmed: this._trendState.htfTrendConfirmed,
      adxStrength: this._trendState.htfAdxStrength,
      donchianBroken: this._trendState.donchianBroken,
      barsInTrend: this._trendState.barsInTrend,
    };
  }

  validateEntry(price, atr, volume, volSMA) {
    if (!price || !atr) return { valid: true, reason: "Data lengkap" };
    const atrPct = (atr / price) * 100;
    const volRatio = volSMA > 0 ? volume / volSMA : 1;
    if (atrPct < 0.25 || atrPct > 5.0) {
      return { valid: false, reason: `ATR ${atrPct.toFixed(2)}% out of range` };
    }
    if (volRatio < 0.7) {
      return { valid: false, reason: `Volume ${volRatio.toFixed(2)}× below threshold` };
    }
    return { valid: true, reason: "Entry OK" };
  }

  getConfig() {
    return this.config;
  }

  setConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }
}

module.exports = TrendFollowingStrategy;
