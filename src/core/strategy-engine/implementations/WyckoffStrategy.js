/**
 * WyckoffStrategy.js — AF racer B (Spring / Upthrust / LPS / LPSY)
 *
 * Independent race participant under AdaptiveFusionUmbrella.
 * Also usable as vote Component B when afCombinationMode:"vote".
 *
 * Entry logic follows syarat_entry_wyckoff.txt.
 * Event detection aligned with wyckoff_indicator.txt via wyckoffEntry.js.
 *
 * Default entryModel: "balanced" (~50–100 Intraday fills/year on BTC)
 * Set config.entryModel / config.wyckoff.entryModel to:
 *   "aggressive"   — spring/UT reclaim + rejection + RR ≥ minRr (AF race)
 *   "moderate"     — full Syarat §4–5 (prior + CHoCH) — selective
 *   "conservative" — safest chain (§11): SOS/SOW + LPS/LPSY
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const {
  evaluateWyckoffComponent,
  candlesFromIndicators,
  DEFAULTS,
} = require("../af/wyckoffEntry");

/** Strategy-level defaults layered on component DEFAULTS — Syarat-first. */
const STRATEGY_DEFAULTS = {
  entryModel: "balanced",
  minRr: 2.0,
  volMultiplier: 1.5,
  volumeConfirmMult: 1.3,
  lookback: 100,
  rejectionWickRatio: 0.4,
  maxEntryProximityPct: 0.4,
  cooldownBars: 5,
  allowHtfSideways: true,
  requireHtfAlign: true,
  sidewaysShortOnly: true,
  riskPerTrade: 0.008,
};

class WyckoffStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "WYCKOFF",
      label: "Wyckoff Method (Spring/Upthrust)",
      description:
        "Wyckoff accumulation/distribution entries per syarat_entry_wyckoff: " +
        "Downtrend→Accumulation→Spring→Reclaim→CHoCH→(SOS→LPS) / " +
        "Uptrend→Distribution→UTAD→Rejection→CHoCH→(SOW→LPSY). " +
        "Indicator events from wyckoff_indicator schematic.",
      version: "2.1.0",
      enabled: true,
      ...config,
    });
    this._lastSignalMeta = null;
    this._lastSignalIdx = null;
    this._ablation = null;
  }

  static get ABLATION_SCHEMA() {
    return [
      { key: "evaluated", label: "1. Bars evaluated" },
      { key: "rejMinBars", label: "2. - Insufficient bars" },
      { key: "rejVolume", label: "3. - Volume absent" },
      { key: "rejCooldown", label: "4. - Cooldown active" },
      { key: "rejRange", label: "5. - No valid trading range" },
      { key: "rejPattern", label: "6. - No spring/upthrust/LPS" },
      { key: "rejChecklist", label: "7. - Entry checklist failed" },
      { key: "passed", label: "= PASSED (tradeable signals)" },
    ];
  }

  resetAblation() {
    const a = {};
    for (const s of WyckoffStrategy.ABLATION_SCHEMA) a[s.key] = 0;
    this._ablation = a;
    return this._ablation;
  }

  getAblation() { return this._ablation; }

  getAblationSchema() { return WyckoffStrategy.ABLATION_SCHEMA; }

  _mergedConfig(config = {}) {
    return {
      ...DEFAULTS,
      ...STRATEGY_DEFAULTS,
      ...this.config?.wyckoff,
      ...config.wyckoff,
      ...config,
    };
  }

  /** Last detect/evaluate merge — calculateRiskConfig has no config arg (live+BT). */
  _riskConfig() {
    return this._activeConfig || this._mergedConfig();
  }

  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 1.0, trend_strength = 0.3 } = marketConditions;
    // Wyckoff thrives in ranging / moderate-vol markets after a prior trend
    let score = 50;
    if (trend_strength < 0.25) score += 25;
    if (volatility >= 0.8 && volatility <= 2.0) score += 15;
    if (trend_strength > 0.6) score -= 20;
    return [
      {
        key: "WYCKOFF",
        label: this.config.label,
        score: Math.max(0, Math.min(100, score)),
        reason: "range_phase_affinity",
      },
    ];
  }

  canActivate(balance, htfTrend, volatility) {
    if (balance != null && balance < 10) {
      return { allowed: false, reason: "insufficient_balance" };
    }
    // Prefer range / mild-trend regimes — strong one-way HTF is handled by executor
    // gates; do not hard-block here so prior-trend springs after selloffs still fire.
    return { allowed: true, reason: "ok", htfTrend: htfTrend ?? null };
  }

  _buildWyFields(result) {
    const nested = result.meta || {};
    const range = nested.range || {};
    const spring = nested.spring || {};
    const upthrust = nested.upthrust || {};
    const entry = nested.entry || {};
    const checklist = entry.checklist || {};
    const reason = String(result.reason || "");
    let patternType = null;
    if (reason.includes("lpsy")) patternType = "LPSY";
    else if (reason.includes("wyckoff_lps") || reason.endsWith("_lps")) patternType = "LPS";
    else if (spring.detected || reason.includes("spring")) patternType = "SPRING";
    else if (upthrust.detected || reason.includes("upthrust") || reason.includes("utad")) {
      patternType = "UPTHRUST";
    }
    const event = spring.detected ? spring : (upthrust.detected ? upthrust : null);
    let sosOrSow = null;
    if (checklist.sosOrSow) {
      sosOrSow = result.vote === "LONG" || patternType === "SPRING" || patternType === "LPS"
        ? "SOS"
        : "SOW";
    } else if (reason.includes("sos") || reason.includes("lps")) sosOrSow = "SOS";
    else if (reason.includes("sow") || reason.includes("lpsy")) sosOrSow = "SOW";

    return {
      wyPatternType: patternType,
      wyAccumulationBars: range.bars
        ?? (range.rangeEndIdx != null && range.rangeStartIdx != null
          ? range.rangeEndIdx - range.rangeStartIdx
          : null),
      wyFakeBreakDepthAtr: event?.depthAtr ?? event?.penetrationAtr ?? null,
      wyReclameBars: event?.reclaimBars ?? entry.reclaimBars ?? null,
      wyVolumeRatio: event?.volRatio ?? entry.volRatio ?? null,
      wySosOrSow: sosOrSow,
      wyLpsLevel: entry.lpsLevel ?? nested.lpsLevel
        ?? (result.vote === "LONG" || patternType === "SPRING" || patternType === "LPS"
          ? range.rangeLow
          : range.rangeHigh) ?? null,
      wyEntryModel: entry.model ?? this._mergedConfig().entryModel,
      wyRr: nested.rr ?? entry.rr ?? null,
    };
  }

  detectSignal(indicators, lastIdx, config = {}) {
    // Singleton strategies retain _lastSignalIdx across backtest jobs — reset when
    // the series rewinds so a prior run cannot cooldown-lock an entire new tape.
    if (this._lastSignalIdx != null && lastIdx < this._lastSignalIdx) {
      this._lastSignalIdx = null;
    }
    this._activeConfig = this._mergedConfig(config);
    const candles = candlesFromIndicators(indicators, lastIdx);
    const result = evaluateWyckoffComponent(
      candles,
      this._activeConfig,
      { lastSignalIdx: this._lastSignalIdx, ablation: this._ablation },
    );

    const wyFields = this._buildWyFields(result);
    this._lastSignalMeta = {
      component: "WYCKOFF",
      winningComponent: (result.vote === "LONG" || result.vote === "SHORT") ? "WYCKOFF" : null,
      strategyLabel: "Wyckoff Method (Spring/Upthrust)",
      vote: result.vote,
      confidence: result.confidence,
      reason: result.reason,
      meta: result.meta || null,
      ...wyFields,
    };

    if (result.vote === "LONG" || result.vote === "SHORT") {
      this._lastSignalIdx = lastIdx;
      return result.vote;
    }
    return null;
  }

  /**
   * Full evaluation with NEUTRAL (for umbrella vote breakdown).
   */
  evaluate(indicators, lastIdx, config = {}) {
    if (this._lastSignalIdx != null && lastIdx < this._lastSignalIdx) {
      this._lastSignalIdx = null;
    }
    this._activeConfig = this._mergedConfig(config);
    const candles = candlesFromIndicators(indicators, lastIdx);
    const result = evaluateWyckoffComponent(
      candles,
      this._activeConfig,
      { lastSignalIdx: this._lastSignalIdx, ablation: this._ablation },
    );
    this._lastSignalMeta = {
      component: "WYCKOFF",
      winningComponent: (result.vote === "LONG" || result.vote === "SHORT") ? "WYCKOFF" : null,
      strategyLabel: "Wyckoff Method (Spring/Upthrust)",
      ...result,
      ...this._buildWyFields(result),
    };
    if (result.vote === "LONG" || result.vote === "SHORT") {
      this._lastSignalIdx = lastIdx;
    }
    return result;
  }

  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  /**
   * Risk: Spring/UTAD invalidation with ATR floor, TP at ≥ minRr (Syarat §8–10).
   * Pure structure SL was too tight on noise retests (mock 12m moderate → 6% WR).
   * Flooring SL to ~0.9×ATR and banking 2R (or structural mid if closer) restores
   * room to survive the fakeout without giving up the Wyckoff invalidation thesis.
   */
  calculateRiskConfig(entryPrice, atr, signal, _component, opts = {}) {
    const side = typeof signal === "object" ? (signal.signal || signal.side) : signal;
    const cfg = this._riskConfig();
    const minRr = Number(opts.minRr ?? cfg.minRr ?? STRATEGY_DEFAULTS.minRr) || 2;
    const atrSafe = Number.isFinite(atr) && atr > 0 ? atr : null;
    const levels = this.getStopTakeLevels(entryPrice, side);
    const minSlAtr = Number(opts.wyckoffMinSlAtr ?? cfg.minSlAtrMult ?? 0.9);
    // Fee-survivability floor: 5m springs often set SL ~0.2% while taker RT≈0.2%
    // — fees consume ~1R. Flooring SL% (live + backtest via same calculateRiskConfig)
    // restores usable R after costs without changing the entry thesis.
    const minSlPct = Number(opts.minSlPct ?? cfg.minSlPct ?? 0);

    let slDist;
    let stopLoss;
    let source = "wyckoff_atr_fallback";

    if (levels?.stopLoss != null && Number.isFinite(entryPrice)) {
      const slBuf = atrSafe ? atrSafe * 0.15 : Math.abs(entryPrice) * 0.0008;
      const rawSl = side === "LONG"
        ? Math.min(levels.stopLoss, entryPrice) - slBuf
        : Math.max(levels.stopLoss, entryPrice) + slBuf;
      let structDist = Math.abs(entryPrice - rawSl);
      const atrFloor = atrSafe ? atrSafe * minSlAtr : 0;
      if (structDist < atrFloor) {
        slDist = atrFloor;
        stopLoss = side === "LONG" ? entryPrice - slDist : entryPrice + slDist;
        source = "wyckoff_structure_atr_floor";
      } else {
        slDist = structDist;
        stopLoss = rawSl;
        source = "wyckoff_structure";
      }
    } else {
      const slMult = opts.slMultiplier ?? 1.0;
      slDist = (atrSafe || Math.abs(entryPrice) * 0.005) * slMult;
      stopLoss = side === "LONG" ? entryPrice - slDist : entryPrice + slDist;
    }

    if (!(slDist > 0)) {
      slDist = atrSafe ? atrSafe * 1.0 : Math.abs(entryPrice) * 0.005;
      stopLoss = side === "LONG" ? entryPrice - slDist : entryPrice + slDist;
      source = "wyckoff_atr_fallback";
    }

    // minSlPctMode:
    //   "floor"  (default) — widen SL to minSlPct (shrinks size; fee/R improves, WR often falls)
    //   "reject" — return null so executor skips fee-toxic micro-SL setups (keeps WR of survivors)
    if (minSlPct > 0 && Number.isFinite(entryPrice) && entryPrice !== 0) {
      const pctFloor = Math.abs(entryPrice) * minSlPct;
      if (slDist < pctFloor) {
        const mode = String(opts.minSlPctMode ?? cfg.minSlPctMode ?? "floor").toLowerCase();
        if (mode === "reject") {
          return null;
        }
        slDist = pctFloor;
        stopLoss = side === "LONG" ? entryPrice - slDist : entryPrice + slDist;
        source = `${source}+min_sl_pct`;
      }
    }

    // Prefer banking minRr from risk; use structural target only when it is
    // between minRr and ~2.5×minRr (avoids moonshot TPs that never fill).
    const cfgMinRr = Number(cfg.minRr ?? minRr) || minRr;
    let tpDist = slDist * cfgMinRr;
    let takeProfit = side === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;
    if (levels?.takeProfit != null) {
      const structTpDist = Math.abs(levels.takeProfit - entryPrice);
      const structRr = structTpDist / slDist;
      if (structRr >= cfgMinRr && structRr <= cfgMinRr * 2.5) {
        tpDist = structTpDist;
        takeProfit = levels.takeProfit;
        source = `${source}+struct_tp`;
      }
    }

    // Leg overrides (Scalping/Intraday/Swing) may pass explicit multipliers
    if (opts.tpMultiplier != null && atrSafe && (!levels?.takeProfit || source.includes("atr"))) {
      const tpMult = Number(opts.tpMultiplier);
      const slMult = Number(opts.slMultiplier ?? (slDist / atrSafe));
      if (tpMult > 0 && slMult > 0) {
        const planned = slDist * (tpMult / slMult);
        if (planned >= slDist * cfgMinRr * 0.95) {
          tpDist = planned;
          takeProfit = side === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;
          source = `${source}+leg_mult`;
        }
      }
    }

    const legOv = (_component && cfg.typeOverrides?.[_component]) || {};
    const tpMode = String(opts.tpMode ?? legOv.tpMode ?? cfg.tpMode ?? "full").toLowerCase();
    return {
      stopLoss: parseFloat(stopLoss.toFixed(8)),
      takeProfit: parseFloat(takeProfit.toFixed(8)),
      riskReward: parseFloat((tpDist / slDist).toFixed(2)),
      slDistance: slDist,
      tpDistance: tpDist,
      slMultiplier: atrSafe ? parseFloat((slDist / atrSafe).toFixed(4)) : null,
      tpMultiplier: atrSafe ? parseFloat((tpDist / atrSafe).toFixed(4)) : null,
      source,
      component: "WYCKOFF",
      // Live BotEngine reads preferredTpMode so partial ladder matches backtest.
      preferredTpMode: tpMode === "partial" ? "partial" : "full",
      slPlusPartial1Pct: opts.slPlusPartial1Pct ?? legOv.slPlusPartial1Pct ?? cfg.slPlusPartial1Pct,
      slPlusPartial2Pct: opts.slPlusPartial2Pct ?? legOv.slPlusPartial2Pct ?? cfg.slPlusPartial2Pct,
      slPlusM1R: opts.slPlusM1R ?? legOv.slPlusM1R ?? cfg.slPlusM1R,
      slPlusM2R: opts.slPlusM2R ?? legOv.slPlusM2R ?? cfg.slPlusM2R,
      slPlusBeOffsetR: opts.slPlusBeOffsetR ?? legOv.slPlusBeOffsetR ?? cfg.slPlusBeOffsetR,
    };
  }

  /**
   * Risk: min RR 1:2 (Syarat §10). SL below Spring / above UTAD when meta available.
   */
  getRiskConfig() {
    return {
      riskPerTrade: 0.008,
      maxTradesPerDay: 8,
      slMultiplier: 1.0,
      tpMultiplier: 2.0,
      minRr: STRATEGY_DEFAULTS.minRr,
    };
  }

  getTimeframeConfig() {
    return { interval: "15m", higherTf: "1h", checkInterval: 60_000 };
  }

  /**
   * Validate entry: volume + ATR + Syarat checklist / RR / proximity from last meta.
   */
  validateEntry(price, atr, volume, volSMA) {
    if (!volume || volume === 0) return { valid: false, reason: "missing_volume" };
    if (volSMA && volume < 0.8 * volSMA) return { valid: false, reason: "low_volume" };
    if (!atr || atr <= 0) return { valid: false, reason: "no_atr" };

    const meta = this._lastSignalMeta;
    if (meta?.meta?.entry && meta.meta.entry.passed === false) {
      return { valid: false, reason: meta.meta.entry.reason || "entry_checklist_failed" };
    }
    if (meta?.reason && String(meta.reason).startsWith("entry_cancelled")) {
      return { valid: false, reason: meta.reason };
    }

    // Always enforce Syarat §10 RR when meta carries structural RR
    const rr = meta?.meta?.rr ?? meta?.wyRr;
    if (rr != null && rr < STRATEGY_DEFAULTS.minRr) {
      return { valid: false, reason: "rr_below_minimum" };
    }

    const model = meta?.meta?.entry?.model
      || meta?.wyEntryModel
      || this._mergedConfig().entryModel
      || STRATEGY_DEFAULTS.entryModel;

    // Aggressive: volume + RR only (checklist already required rejection)
    if (model === "aggressive") {
      return { valid: true, reason: "ok" };
    }

    // Syarat §1 / §4–5: avoid mid-range / poor location without confirmation
    const range = meta?.meta?.range;
    const vote = meta?.vote;
    if (range?.rangeHigh != null && range?.rangeLow != null && price != null && vote) {
      const mid = range.midRange ?? (range.rangeHigh + range.rangeLow) / 2;
      const width = range.rangeHigh - range.rangeLow;
      if (width > 0) {
        const isLps = String(meta?.reason || "").includes("lps")
          && !String(meta?.reason || "").includes("lpsy");
        const isLpsy = String(meta?.reason || "").includes("lpsy");
        if (vote === "LONG" && !isLps && price > mid + width * 0.15) {
          return { valid: false, reason: "long_too_close_to_resistance" };
        }
        if (vote === "SHORT" && !isLpsy && price < mid - width * 0.15) {
          return { valid: false, reason: "short_too_close_to_support" };
        }
      }
    }

    return { valid: true, reason: "ok" };
  }

  /**
   * Suggested SL/TP from last signal meta (Spring low / UTAD high → range opposite).
   * Syarat §8–9.
   */
  getStopTakeLevels(price, side) {
    const meta = this._lastSignalMeta?.meta;
    if (!meta) return null;
    const sl = meta.stopLoss;
    const tp = meta.takeProfit;
    if (sl == null || tp == null || price == null) return null;
    if (side === "LONG" && !(sl < price && tp > price)) return null;
    if (side === "SHORT" && !(sl > price && tp < price)) return null;
    return { stopLoss: sl, takeProfit: tp, rr: meta.rr ?? null };
  }
}

module.exports = WyckoffStrategy;
