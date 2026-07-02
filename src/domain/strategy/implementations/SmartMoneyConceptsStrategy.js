/**
 * SmartMoneyConceptsStrategy.js — v3.1.0 (SAC: Smart Money Concepts)
 *
 * FOUNDRY Tier — 3 Trade Types, each on its own timeframe stack:
 *   Scalping  (type A) : Liquidity sweep + OB + CVD  | entry 5m, confirm 15m, trend 1h
 *   Intraday  (type B) : CHoCH + OB + EMA trend      | entry 15m, confirm 1h, trend 4h
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
      label: "Smart Money Concepts (SAC) v3.1",
      description:
        "LuxAlgo-compatible SMC structure engine (v3.1): " +
        "sweep → CHoCH/MSS → displacement/FVG → mitigation → entry. " +
        "Causal, cross-bar structure replicates institutional market reading. " +
        "3 independent trade types: Scalping (5m/1h), Intraday (15m/4h), Swing (4h/1w). " +
        "HTF directional bias; sacUseSequenceEngine flag (default on) for fallback.",
      version: "3.1.0",
      enabled: true,
      ...config,
    });

    // ── Trade type TF configuration (each type runs on its own TF stack) ─────
    this.TRADE_TYPE_TF_CONFIG = {
      Scalping: { entryTf: "5m",  confirmTf: "15m", trendTf: "1h" },  // v3.1
      Intraday: { entryTf: "15m", confirmTf: "1h",  trendTf: "4h" },  // v3.1
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
      interval:      "15m",
      higherTf:      "4h",
      checkInterval: 900000,
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

  // LuxAlgo-compatible confirmed pivots and market structure.
  // A pivot at candidate index (bar - size) is confirmed only after `size`
  // right-side bars have closed. This is causal and does not use future data.
  _collectConfirmedPivots(highs, lows, lastIdx, size = 5, scanBars = Infinity) {
    if (!Array.isArray(highs) || !Array.isArray(lows) || lastIdx < size) {
      return { highs: [], lows: [], all: [] };
    }

    let leg = 0; // LuxAlgo BEARISH_LEG initial value
    const pivotHighs = [];
    const pivotLows = [];
    const all = [];

    for (let bar = size; bar <= lastIdx; bar++) {
      const candidate = bar - size;
      let rightHighest = -Infinity;
      let rightLowest = Infinity;
      for (let j = candidate + 1; j <= bar; j++) {
        rightHighest = Math.max(rightHighest, highs[j] ?? -Infinity);
        rightLowest = Math.min(rightLowest, lows[j] ?? Infinity);
      }

      const newLegHigh = (highs[candidate] ?? -Infinity) > rightHighest;
      const newLegLow = (lows[candidate] ?? Infinity) < rightLowest;
      let nextLeg = leg;
      if (newLegHigh) nextLeg = 0;
      else if (newLegLow) nextLeg = 1;

      if (nextLeg !== leg) {
        const pivot = nextLeg === 1
          ? { idx: candidate, confirmedIdx: bar, price: lows[candidate], type: "low" }
          : { idx: candidate, confirmedIdx: bar, price: highs[candidate], type: "high" };
        all.push(pivot);
        if (pivot.type === "high") pivotHighs.push(pivot);
        else pivotLows.push(pivot);
      }
      leg = nextLeg;
    }

    const minIdx = Number.isFinite(scanBars) ? Math.max(0, lastIdx - scanBars) : 0;
    return {
      highs: pivotHighs.filter(p => p.idx >= minIdx),
      lows: pivotLows.filter(p => p.idx >= minIdx),
      all: all.filter(p => p.idx >= minIdx),
    };
  }

  _findRecentSwingHighs(highs, lastIdx, size = 5, scanBars = 30, lows = null) {
    const lowSeries = lows ?? highs.map(() => Infinity);
    return this._collectConfirmedPivots(highs, lowSeries, lastIdx, size, scanBars).highs;
  }

  _findRecentSwingLows(lows, lastIdx, size = 5, scanBars = 30, highs = null) {
    const highSeries = highs ?? lows.map(() => -Infinity);
    return this._collectConfirmedPivots(highSeries, lows, lastIdx, size, scanBars).lows;
  }

  _trueRange(highs, lows, closes, idx) {
    const hi = highs[idx] ?? 0;
    const lo = lows[idx] ?? hi;
    if (idx <= 0) return Math.max(hi - lo, 0);
    const prevClose = closes[idx - 1] ?? lo;
    return Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose));
  }

  _buildParsedPrices(closes, highs, lows, lastIdx, config = {}) {
    const filter = String(config.sacOrderBlockFilter ?? "ATR").toUpperCase();
    const atrLength = Math.max(1, config.sacOrderBlockAtrLength ?? 200);
    const parsedHighs = new Array(lastIdx + 1);
    const parsedLows = new Array(lastIdx + 1);
    let cumulativeTR = 0;
    let atr = null;

    for (let i = 0; i <= lastIdx; i++) {
      const tr = this._trueRange(highs, lows, closes, i);
      cumulativeTR += tr;
      if (i === atrLength - 1) atr = cumulativeTR / atrLength;
      else if (i >= atrLength && atr != null) atr = ((atr * (atrLength - 1)) + tr) / atrLength;

      const cumulativeMean = cumulativeTR / Math.max(i, 1);
      const measure = filter === "RANGE" ? cumulativeMean : (atr ?? Infinity);
      const highVolatilityBar = ((highs[i] ?? 0) - (lows[i] ?? 0)) >= 2 * Math.max(measure, EPSILON);
      parsedHighs[i] = highVolatilityBar ? lows[i] : highs[i];
      parsedLows[i] = highVolatilityBar ? highs[i] : lows[i];
    }
    return { parsedHighs, parsedLows };
  }

  _structureConfluenceOk(direction, opens, closes, highs, lows, idx, config = {}) {
    if (!config.sacInternalFilterConfluence) return true;
    const open = opens?.[idx] ?? closes[idx - 1] ?? closes[idx];
    const close = closes[idx];
    const upperWick = (highs[idx] ?? close) - Math.max(close, open);
    const lowerWick = Math.min(close, open) - (lows[idx] ?? close);
    return direction === "bullish" ? upperWick > lowerWick : upperWick < lowerWick;
  }

  _buildStructureState(closes, highs, lows, opens, lastIdx, config = {}) {
    const internalSize = Math.max(1, config.sacInternalStructureSize ?? 5);
    const swingSize = Math.max(2, config.sacSwingStructureSize ?? 50);
    const { parsedHighs, parsedLows } = this._buildParsedPrices(closes, highs, lows, lastIdx, config);
    const mitigationMode = String(config.sacOrderBlockMitigation ?? "HIGHLOW").toUpperCase();

    const makeState = (size, internal) => ({
      size, internal, leg: 0, trend: 0,
      high: { currentLevel: null, lastLevel: null, crossed: false, idx: -1, previousSeriesLevel: null },
      low: { currentLevel: null, lastLevel: null, crossed: false, idx: -1, previousSeriesLevel: null },
    });
    const swing = makeState(swingSize, false);
    const internal = makeState(internalSize, true);
    const events = [];
    let orderBlocks = [];
    const pivots = { internalHighs: [], internalLows: [], swingHighs: [], swingLows: [] };
    const trailing = { top: null, bottom: null, barIndex: -1 };

    const updateLegAndPivot = (state, bar) => {
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
        (state.internal ? pivots.internalLows : pivots.swingLows).push({
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
        (state.internal ? pivots.internalHighs : pivots.swingHighs).push({
          idx: candidate, confirmedIdx: bar, price: p.currentLevel, type: "high",
        });
        if (!state.internal) {
          trailing.top = p.currentLevel;
          trailing.barIndex = candidate;
        }
      }
      state.leg = nextLeg;
    };

    const storeOrderBlock = (state, direction, pivot, bar, event) => {
      if (pivot.idx < 0 || pivot.idx >= bar) return;
      let obIdx = pivot.idx;
      if (direction === "bullish") {
        let minValue = Infinity;
        for (let i = pivot.idx; i < bar; i++) {
          if ((parsedLows[i] ?? Infinity) < minValue) { minValue = parsedLows[i]; obIdx = i; }
        }
      } else {
        let maxValue = -Infinity;
        for (let i = pivot.idx; i < bar; i++) {
          if ((parsedHighs[i] ?? -Infinity) > maxValue) { maxValue = parsedHighs[i]; obIdx = i; }
        }
      }
      const ob = {
        type: direction === "bullish" ? "bullish_OB" : "bearish_OB",
        bias: direction,
        high: parsedHighs[obIdx],
        low: parsedLows[obIdx],
        idx: obIdx,
        createdIdx: bar,
        internal: state.internal,
        sourceEvent: event,
      };
      orderBlocks.unshift(ob);
      if (orderBlocks.length > 200) orderBlocks.pop();
      event.orderBlock = ob;
    };

    const processBreak = (state, direction, pivot, bar) => {
      if (pivot.currentLevel == null || pivot.crossed || bar <= 0) return;
      const previousLevel = pivot.previousSeriesLevel ?? pivot.currentLevel;
      const crossed = direction === "bullish"
        ? closes[bar] > pivot.currentLevel && closes[bar - 1] <= previousLevel
        : closes[bar] < pivot.currentLevel && closes[bar - 1] >= previousLevel;
      if (!crossed) return;

      if (state.internal) {
        const swingPivot = direction === "bullish" ? swing.high : swing.low;
        if (swingPivot.currentLevel === pivot.currentLevel) return;
        if (!this._structureConfluenceOk(direction, opens, closes, highs, lows, bar, config)) return;
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
      events.push(event);
      pivot.crossed = true;
      state.trend = direction === "bullish" ? 1 : -1;
      storeOrderBlock(state, direction, pivot, bar, event);
    };

    for (let bar = 0; bar <= lastIdx; bar++) {
      if (trailing.top != null) trailing.top = Math.max(trailing.top, highs[bar] ?? trailing.top);
      if (trailing.bottom != null) trailing.bottom = Math.min(trailing.bottom, lows[bar] ?? trailing.bottom);

      updateLegAndPivot(swing, bar);
      updateLegAndPivot(internal, bar);

      processBreak(internal, "bullish", internal.high, bar);
      processBreak(internal, "bearish", internal.low, bar);
      processBreak(swing, "bullish", swing.high, bar);
      processBreak(swing, "bearish", swing.low, bar);

      const bearSource = mitigationMode === "CLOSE" ? closes[bar] : highs[bar];
      const bullSource = mitigationMode === "CLOSE" ? closes[bar] : lows[bar];
      orderBlocks = orderBlocks.filter(ob => {
        if (ob.bias === "bearish") return !(bearSource > ob.high);
        return !(bullSource < ob.low);
      });

      for (const state of [internal, swing]) {
        state.high.previousSeriesLevel = state.high.currentLevel;
        state.low.previousSeriesLevel = state.low.currentLevel;
      }
    }

    const range = trailing.top != null && trailing.bottom != null && trailing.top > trailing.bottom
      ? trailing.top - trailing.bottom : null;
    const premiumDiscount = range == null ? null : {
      top: trailing.top,
      bottom: trailing.bottom,
      premium: { low: trailing.bottom + range * 0.95, high: trailing.top },
      equilibrium: { low: trailing.bottom + range * 0.475, high: trailing.bottom + range * 0.525 },
      discount: { low: trailing.bottom, high: trailing.bottom + range * 0.05 },
    };

    return { internal, swing, events, orderBlocks, pivots, trailing, premiumDiscount };
  }

  /**
   * Liquidity sweep of the latest confirmed LuxAlgo-style pivot.
   * Volume is optional because the reference indicator does not require it.
   */
  _detectSweep(closes, highs, lows, volumes, volSMA, lastIdx, config = {}) {
    const size = Math.max(1, config.sacLiquidityPivotSize ?? config.sacInternalStructureSize ?? 5);
    const scanBars = config.sacSweepScanBars ?? 50;
    const volMult = config.sacSweepVolMult ?? 1.1;
    const requireVolume = config.sacSweepRequireVolume === true;
    if (lastIdx < size + 1) return null;

    const pivots = this._collectConfirmedPivots(highs, lows, lastIdx - 1, size, scanBars);
    const swingLow = pivots.lows.at(-1);
    const swingHigh = pivots.highs.at(-1);
    const cl = closes[lastIdx];
    const vol = volumes?.[lastIdx] ?? 0;
    const vSMA = Math.max(volSMA?.[lastIdx] ?? 0, EPSILON);
    const volRatio = vol / vSMA;
    const volumeOk = !requireVolume || vol > vSMA * volMult;

    if (swingLow && lows[lastIdx] < swingLow.price && cl > swingLow.price && volumeOk) {
      return { type: "bullish", level: swingLow.price, pivotIdx: swingLow.idx, volRatio, bars: lastIdx };
    }
    if (swingHigh && highs[lastIdx] > swingHigh.price && cl < swingHigh.price && volumeOk) {
      return { type: "bearish", level: swingHigh.price, pivotIdx: swingHigh.idx, volRatio, bars: lastIdx };
    }
    return null;
  }

  /** LuxAlgo-compatible active order block created by a structure break. */
  _detectOrderBlock(closes, highs, lows, opens, volumes, volSMA, lastIdx, direction, config = {}) {
    if (lastIdx < 2) return null;
    const state = this._buildStructureState(closes, highs, lows, opens, lastIdx, config);
    const wanted = direction === "LONG" ? "bullish" : "bearish";
    const preferInternal = config.sacOrderBlockStructure !== "swing";
    const candidates = state.orderBlocks.filter(ob => ob.bias === wanted);
    const ob = candidates.find(x => x.internal === preferInternal) ?? candidates[0];
    if (!ob) return null;
    const cl = closes[lastIdx];
    const zoneLow = Math.min(ob.low, ob.high);
    const zoneHigh = Math.max(ob.low, ob.high);
    const eventRange = Math.abs((ob.sourceEvent?.level ?? cl) - cl) / Math.max(cl, EPSILON);
    return {
      ...ob,
      low: zoneLow,
      high: zoneHigh,
      inZone: cl >= zoneLow && cl <= zoneHigh,
      strength: Math.max(1, eventRange * 100),
    };
  }

  /** Return a BOS/CHoCH event on the current bar using the reference state machine. */
  _detectStructureBreak(closes, highs, lows, opens, lastIdx, config = {}) {
    if (lastIdx < 2) return null;
    const state = this._buildStructureState(closes, highs, lows, opens, lastIdx, config);
    const structureType = String(config.sacStructureType ?? "internal").toLowerCase();
    return [...state.events].reverse().find(e => e.idx === lastIdx && (
      structureType === "both" || (structureType === "swing" ? !e.internal : e.internal)
    )) ?? null;
  }

  _detectCHoCH(closes, highs, lows, lastIdx, config = {}, opens = null) {
    const event = this._detectStructureBreak(closes, highs, lows, opens, lastIdx, config);
    if (!event || event.tag !== "CHOCH") return null;
    return {
      type: event.type,
      tag: event.tag,
      level: event.level,
      pivotIdx: event.pivotIdx,
      internal: event.internal,
    };
  }

  /**
   * LuxAlgo-compatible same-timeframe FVG detection.
   * The middle candle must close beyond candle i-2 and its body displacement
   * must exceed the indicator's adaptive cumulative threshold.
   */
  _detectFVG(closes, highs, lows, lastIdx, config = {}, opens = null) {
    const scanBars = config.sacFvgScanBars ?? 100;
    const autoThreshold = config.sacFvgAutoThreshold !== false;
    const explicitMinGap = config.sacFvgMinGap;
    const openSeries = opens ?? closes.map((c, i) => i > 0 ? closes[i - 1] : c);
    const gaps = [];
    let cumulativeAbsBody = 0;

    for (let i = 1; i <= lastIdx; i++) {
      const midOpen = openSeries[i - 1] ?? closes[i - 1];
      const midClose = closes[i - 1];
      const bodyDelta = (midClose - midOpen) / Math.max(Math.abs(midOpen), EPSILON);
      cumulativeAbsBody += Math.abs(bodyDelta);
      if (i < 2) continue;

      const threshold = autoThreshold ? (cumulativeAbsBody / Math.max(i, 1)) * 2 : 0;
      const bullGapSize = (lows[i] - highs[i - 2]) / Math.max(Math.abs(midClose), EPSILON);
      const bearGapSize = (lows[i - 2] - highs[i]) / Math.max(Math.abs(midClose), EPSILON);
      const gapFloor = typeof explicitMinGap === "number" ? explicitMinGap : 0;
      const bullish = lows[i] > highs[i - 2] && midClose > highs[i - 2] && bodyDelta > threshold && bullGapSize > gapFloor;
      const bearish = highs[i] < lows[i - 2] && midClose < lows[i - 2] && -bodyDelta > threshold && bearGapSize > gapFloor;

      if (bullish) {
        gaps.unshift({
          type: "bullish", top: lows[i], bottom: highs[i - 2],
          midpoint: (lows[i] + highs[i - 2]) / 2,
          size: bullGapSize, idx: i, displacementIdx: i - 1,
          bodyDelta, threshold,
        });
      }
      if (bearish) {
        gaps.unshift({
          type: "bearish", top: lows[i - 2], bottom: highs[i],
          midpoint: (lows[i - 2] + highs[i]) / 2,
          size: bearGapSize, idx: i, displacementIdx: i - 1,
          bodyDelta, threshold,
        });
      }
    }

    const startIdx = Math.max(2, lastIdx - scanBars);
    const mitigationMode = String(config.sacFvgMitigationMode ?? "INDICATOR").toUpperCase();
    const active = gaps.filter(gap => {
      if (gap.idx < startIdx) return false;
      for (let j = gap.idx + 1; j <= lastIdx; j++) {
        if (gap.type === "bullish" && lows[j] < gap.bottom) return false;
        if (gap.type === "bearish") {
          // The supplied indicator removes bearish FVGs when high crosses the
          // lower edge. FULL_FILL is available for symmetric strategy testing.
          const invalidationLevel = mitigationMode === "FULL_FILL" ? gap.top : gap.bottom;
          if (highs[j] > invalidationLevel) return false;
        }
      }
      return true;
    });

    return {
      bullish: active.find(g => g.type === "bullish") ?? null,
      bearish: active.find(g => g.type === "bearish") ?? null,
      all: active,
    };
  }

  _getPremiumDiscountZone(closes, highs, lows, opens, lastIdx, config = {}) {
    return this._buildStructureState(closes, highs, lows, opens, lastIdx, config).premiumDiscount;
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
  // EVENT-DRIVEN SMC SEQUENCE DETECTOR (v3.1)
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
    const { closes, highs, lows, volumes, volSMA, opens } = indicators;
    const win = config.sacSeqWindow ?? 60;
    if (lastIdx < 25) return { signal: null, meta: null };

    const cl = closes[lastIdx];
    const fvgs = this._detectFVG(closes, highs, lows, lastIdx, config, opens);
    const structure = this._buildStructureState(closes, highs, lows, opens, lastIdx, config);
    const structureType = String(config.sacStructureType ?? "internal").toLowerCase();
    const structureEvents = structure.events.filter(e => (
      structureType === "both" || (structureType === "swing" ? !e.internal : e.internal)
    ));

    for (const dir of ["LONG", "SHORT"]) {
      const isLong = dir === "LONG";
      const expectedType = isLong ? "bullish" : "bearish";
      const fvg = isLong ? fvgs.bullish : fvgs.bearish;
      if (!fvg) continue;

      const inMitigation = isLong
        ? (cl >= fvg.bottom * 0.999 && cl <= fvg.midpoint * 1.002)
        : (cl <= fvg.top * 1.001 && cl >= fvg.midpoint * 0.998);
      if (!inMitigation) continue;

      // The reference indicator treats the middle candle as the FVG displacement.
      const dispIdx = fvg.displacementIdx ?? (fvg.idx - 1);
      const chochEvent = [...structureEvents].reverse().find(e =>
        e.tag === "CHOCH" && e.type === expectedType &&
        e.idx <= dispIdx && e.idx >= Math.max(0, dispIdx - win)
      );
      if (!chochEvent) continue;
      const chochIdx = chochEvent.idx;

      let sweepIdx = -1;
      let sweepExtreme = null;
      for (let b = chochIdx - 1; b >= Math.max(1, chochIdx - win); b--) {
        const sweep = this._detectSweep(closes, highs, lows, volumes, volSMA, b, config);
        if (sweep && sweep.type === expectedType) {
          sweepIdx = b;
          sweepExtreme = isLong ? lows[b] : highs[b];
          break;
        }
      }
      if (sweepIdx < 0) continue;

      const score = this._scoreSequence(indicators, lastIdx, {
        isLong, fvg, dispIdx, chochIdx, sweepIdx, config,
      });
      return {
        signal: dir,
        meta: {
          sweepIdx, chochIdx, dispIdx, fvg, sweepExtreme, score,
          structureEvent: chochEvent,
          premiumDiscount: structure.premiumDiscount,
        },
      };
    }
    

    return { signal: null, meta: null };
  }

  /** 0-100 confidence for a completed SMC sequence. */
  _scoreSequence(indicators, lastIdx, ctx) {
    const { closes, highs, lows, volumes, volSMA } = indicators;
    const { isLong, fvg, dispIdx, chochIdx, sweepIdx } = ctx;
    let score = 45;

    // Sweep conviction: volume surge on the sweep bar
    const sVol = volumes[sweepIdx] ?? 0, sVSMA = volSMA[sweepIdx] ?? 1;
    const sweepVolRatio = sVSMA > 0 ? sVol / sVSMA : 1;
    score += Math.min(15, (sweepVolRatio - 1) * 15);

    // Displacement strength: range of the FVG-origin bar
    const dRange = ((highs[dispIdx] ?? 0) - (lows[dispIdx] ?? 0)) / (closes[dispIdx] || 1);
    score += Math.min(15, dRange * 600); // ~2.5% range → +15

    // Displacement volume confirmation — weak displacement = premature entry (AF-FIX-06)
    // If the FVG-origin bar had below-average volume, the "displacement" may be noise.
    const dVol = volumes[dispIdx] ?? 0, dVSMA = volSMA[dispIdx] ?? 1;
    const dispVolRatio = dVSMA > 0 ? dVol / dVSMA : 1;
    if (dispVolRatio < 1.2) score -= 12; // penalise weak-volume displacement

    // FVG size (bigger imbalance = stronger)
    score += Math.min(10, (fvg.size || 0) * 1500); // 0.67% gap → +10

    // Mitigation depth: deeper into the zone = better entry
    const cl = closes[lastIdx];
    const depth = isLong
      ? (fvg.midpoint - cl) / Math.max(fvg.midpoint - fvg.bottom, 1e-9)
      : (cl - fvg.midpoint) / Math.max(fvg.top - fvg.midpoint, 1e-9);
    score += Math.max(0, Math.min(15, depth * 15));

    // Sequence freshness — stale setups produce whipsaws (AF-FIX-06: 0% WR on <2h trades)
    // Reward recent sweeps (≤20 bars = setup is still "alive"), penalise very old ones.
    const sweepAge = lastIdx - sweepIdx;
    if      (sweepAge <= 20) score += 8;   // fresh: full bonus
    else if (sweepAge <= 40) score += 3;   // acceptable
    else                     score -= 8;   // stale: risk of whipsaw

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

  _detectSignalB(closes, highs, lows, volumes, volSMA, emaFast, emaSlow, lastIdx, config = {}, opens = null) {
    if (lastIdx < 40) return null;

    const choch = this._detectCHoCH(closes, highs, lows, lastIdx, config, opens);
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

  _detectSignalC(closes, highs, lows, volumes, volSMA, lastIdx, config = {}, opens = null) {
    if (lastIdx < 30) return null;

    const cl = closes[lastIdx];
    const fvgs = this._detectFVG(closes, highs, lows, lastIdx, config, opens);
    const pd = this._getPremiumDiscountZone(closes, highs, lows, opens, lastIdx, config);
    if (!pd) return null;

    // LuxAlgo P/D zones are the outer 5% of the current trailing swing range.
    const inDiscount = cl >= pd.discount.low && cl <= pd.discount.high;
    const inPremium = cl >= pd.premium.low && cl <= pd.premium.high;
    if (fvgs.bullish && inDiscount) return "LONG";
    if (fvgs.bearish && inPremium) return "SHORT";
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
    const choch = this._detectCHoCH(closes, highs, lows, lastIdx, config, opens);
    const fvgs  = this._detectFVG(closes, highs, lows, lastIdx, config, opens);
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
    if (dir === "LONG" && htfTrend === "BEARISH") return true;
    if (dir === "SHORT" && htfTrend === "BULLISH") return true;
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
    // ── EVENT-DRIVEN SEQUENCE ENGINE (v3.1, default ON) ──────────────────────
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
      rawB = wantB ? this._detectSignalB(closes, highs, lows, volumes, volSMA, emaFast, emaSlow, lastIdx, config, opens) : null;
      rawC = wantC ? this._detectSignalC(closes, highs, lows, volumes, volSMA, lastIdx, config, opens) : null;

      // ── Confidence scoring (legacy per-component) ──────────────────────────
      const ctx = this._buildConfidenceContext(indicators, lastIdx, config, { marketCond });
      confA = rawA ? this._componentConfidence("A", rawA, ctx) : 0;
      confB = rawB ? this._componentConfidence("B", rawB, ctx) : 0;
      confC = rawC ? this._componentConfidence("C", rawC, ctx) : 0;
    }

    // ── HTF filter ───────────────────────────────────────────────────────────
    // Default: soft scoring penalty (−15 pts) — allows neutral HTF entries but
    // penalizes trading against HTF trend. AF-FIX-REGIME (Sprint 7, re-scoped
    // 2026-07-02): when the pair's tier mandates a regime filter (STABLE and
    // stricter — see PairClassifier PARAM_OVERRIDES.regimeFilterRequired), a
    // direction-conflicting signal is HARD-blocked instead, since letting a
    // penalized-but-still-passing signal through defeats "lebih selektif" on
    // exactly the pairs where regime risk matters most.
    const hardRegimeBlock = config.tierOverrides?.regimeFilterRequired === true;
    if (hardRegimeBlock) {
      if (rawA && this._htfDirectionBlocked(rawA, htfTrend)) { rawA = null; confA = 0; }
      if (rawB && this._htfDirectionBlocked(rawB, htfTrend)) { rawB = null; confB = 0; }
      if (rawC && this._htfDirectionBlocked(rawC, htfTrend)) { rawC = null; confC = 0; }
    } else {
      if (rawA && this._htfDirectionBlocked(rawA, htfTrend)) confA = Math.max(0, confA - 15);
      if (rawB && this._htfDirectionBlocked(rawB, htfTrend)) confB = Math.max(0, confB - 15);
      if (rawC && this._htfDirectionBlocked(rawC, htfTrend)) confC = Math.max(0, confC - 15);
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
    const effMinConf = votingMinConf != null
      ? { A: Math.max(minConf.A, votingMinConf), B: Math.max(minConf.B, votingMinConf), C: Math.max(minConf.C, votingMinConf) }
      : minConf;

    const sigScalping = (rawA && confA >= effMinConf.A) ? rawA : null;
    const sigIntraday = (rawB && confB >= effMinConf.B) ? rawB : null;
    const sigSwing    = (rawC && confC >= effMinConf.C) ? rawC : null;

    // Set both type names and legacy letter aliases
    result.Scalping = sigScalping; result.A = sigScalping;
    result.Intraday = sigIntraday; result.B = sigIntraday;
    result.Swing    = sigSwing;    result.C = sigSwing;

    const accepted = [
      [sigScalping, confA],
      [sigIntraday, confB],
      [sigSwing, confC],
    ].filter(([signal]) => Boolean(signal));
    const aggConf = accepted.length > 0
      ? accepted.reduce((sum, [, confidence]) => sum + confidence, 0) / accepted.length
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
