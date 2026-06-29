/**
 * AdaptiveFusionStrategy.js — v3.7.0 (Order Flow Component A replaces RSI-velocity scalp)
 *
 * v2.6 spec changes:
 *  - riskPerTrade 0.005 (0.5%); riskPerTradeStrong 0.01 on STRONG_TREND.
 *  - volSmaMultiplier 2.0; htfTrendStrengthMin 0.75; RSI B 60–68 / 32–40.
 *  - atrMinMult 1.2; maxEntryExtensionATR 0.7; maxTrades 6; cooldown 90.
 *  - strongTrendTPMult ×1.8 on STRONG_TREND.
 *
 * v2.3 spec changes (target win rate 40–45%):
 *  - afMinVotes default 2 → 3 (butuh konsensus lebih kuat).
 *  - votingThresholdOverride: VOLATILE 0.78 (sumber: PairClassifier), STABLE 0.60.
 *  - interpretMarketCondition: LOW_VOL 1.0 → 1.2 (ATR%), WEAK_TREND 0.3 → 0.45.
 *  - riskPerTrade default 0.015 → 0.01.
 *  - HTF (1h) alignment WAJIB sebelum voting (config.htfTrend).
 *  - SL wajib pakai komponen C (Swing) logic di VOLATILE/SEMI_VOLATILE pair.
 *
 * Fixes applied:
 *  P1 — calculateRiskConfig(): component-aware SL/TP multipliers
 *  P2 — _detectSignalB(): confirmed candle CLOSE cross, not wick
 *  P3 — _detectSignalA(): volume spike + close confirmation required
 *  P4 — detectSignal(): skip components with score below threshold
 *  P5 — getMarketThresholds() + interpretMarketCondition()
 *  P6 — component-level position guard (tracked via _lastSignalMeta)
 *
 * v2.2 (root-cause fixes dari 18/18 loss dry-run 11–12 Jun):
 *  P7 — detectSignal(): blok entry saat DEAD_MARKET. Semua 18 trade loss
 *       terjadi pada ATR% 0.30–0.45 + trend_strength < 0.06 — persis regime
 *       yang threshold strategi sendiri klasifikasikan sebagai dead market,
 *       tapi klasifikasinya tidak pernah dipakai untuk memblok entry.
 *  P8 — _detectSignalB(): EVENT-BASED (fresh crossover / pullback-resume),
 *       bukan state-based. Sebelumnya B & C overlap hampir total (alignment
 *       + RSI band beririsan) → kuorum 2/3 tercapai di hampir setiap candle
 *       selama tren → entry telat/chasing (rata-rata +0.2–0.76% di atas EMA9).
 *  P9 — cooldownAfterLoss 3 → 30 menit (selaras default BotEngine; nilai 3
 *       meng-override balik fix cooldown 30 menit via `strat.cooldownAfterLoss`).
 */

const StrategyBase = require("../base/StrategyBase");

class AdaptiveFusionStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "ADAPTIVE_FUSION",
      label: "Adaptive Fusion Strategy",
      description:
        "Market-aware system combining 4 sub-strategies: " +
        "Aggressive Scalping (A), Day Trading (B), Swing Trading (C), " +
        "SMC Order Block + FVG (D). " +
        "Selects best strategy by market conditions with score-based filtering.",
      version: "3.7.0",
      enabled: true,
      ...config,
    });

    this.SUB_STRATEGIES = {
      A: {
        name: "PDF_SCALPING",
        label: "Aggressive Scalping",
        htf: "15m",
        entryTf: "1m",
        emaFast: 9,
        emaSlow: 21,
        rsi: 7,
        // v2.5: SL = 2.2× ATR, TP = 3.3× ATR → RR 1:1.5
        slMultiplier: 2.2,
        tpMultiplier: 3.3,
        riskPerTrade: 0.01,
        maxTradesPerDay: 20,
        minCapital: 50,
        minScore: 38,
      },
      B: {
        name: "PDF_DAYTRADING",
        label: "Day Trading",
        htf: "1h",
        entryTf: "15m",
        emaFast: 9,
        emaSlow: 21,
        emaLong: 50,
        rsi: 14,
        // AF-FIX-14: SL = 1.6× ATR, TP = 2.88× ATR → RR 1:1.8 (was 3.4 → RR 2.1, target too far)
        slMultiplier: 1.6,
        tpMultiplier: 2.88,
        riskPerTrade: 0.015,
        maxTradesPerDay: 8,
        minCapital: 20,
        minScore: 45,
      },
      C: {
        name: "PDF_SWING",
        label: "Swing Trading",
        htf: "1d",
        entryTf: "4h",
        emaFast: 21,
        emaSlow: 50,
        emaLong: 200,
        rsi: 14,
        // AF-FIX-14: SL = 1.2× ATR, TP = 2.16× ATR → RR 1:1.8 (was 3.0 → RR 2.5, target too far on 1h)
        slMultiplier: 1.2,
        tpMultiplier: 2.16,
        riskPerTrade: 0.015,
        maxTradesPerDay: 3,
        minCapital: 20,
        minScore: 42,
      },
      // AF-FIX-12/13 (Sprint 8): Smart Money Concepts — Order Block + Fair Value Gap
      D: {
        name: "SMC_ORDER_BLOCK",
        label: "SMC Order Block + FVG",
        htf: "1h",
        entryTf: "15m",
        // SL = 1.5× ATR (wider — OB is a zone, not a line), TP = 2.7× ATR → RR 1:1.8
        slMultiplier: 1.5,
        tpMultiplier: 2.7,
        riskPerTrade: 0.01,
        maxTradesPerDay: 4,
        minCapital: 20,
        minScore: 35,
      },
    };

    // P6: Tracks which component fired on last signal (for SL/TP selection)
    this._lastSignalMeta = null;
  }

  // ── P5: Market Condition Thresholds ───────────────────────────────────────

  /**
   * Tuneable market condition thresholds.
   * Crypto needs wider ranges than equities.
   */
  /**
   * Regime thresholds. v3.0: TF-aware / config-driven.
   *
   * ROOT-CAUSE FIX (2026-06-28): the v2.5 defaults (LOW_VOL 1.4, WEAK_TREND 0.55)
   * were calibrated for a HIGHER timeframe. On the strategy's actual 15m entry TF,
   * ATR% averages ~0.5% (never > 1.4) and the EMA-slope trendStrength averages
   * ~0.17 (never > 0.55) → interpretMarketCondition classified 100% of 15m bars
   * as DEAD_MARKET → the strategy NEVER traded (0–3 trades over 7 months).
   *
   * Defaults below are recalibrated for the 15m entry distribution. Any field can
   * still be overridden per-call (backtest sweep) via config.marketThresholds, or
   * globally via the constructor (this.config.marketThresholds) for live tuning.
   * @param {Object} overrides - per-call threshold overrides
   */
  getMarketThresholds(overrides = {}) {
    return {
      // 15m-calibrated volatility bands (ATR% of price)
      LOW_VOL:         0.35,
      NORMAL_VOL:      0.60,
      HIGH_VOL:        1.20,
      // 15m-calibrated trend bands (EMA-slope strength 0–1)
      WEAK_TREND:      0.10,
      NORMAL_TREND:    0.22,
      STRONG_TREND:    0.40,
      COMP_A_MIN_SCORE: 38,
      COMP_B_MIN_SCORE: 45,
      COMP_C_MIN_SCORE: 42,
      ...(this.config?.marketThresholds || {}),
      ...overrides,
    };
  }

  /**
   * Classify market regime into one of four readable states.
   * @returns {"DEAD_MARKET"|"CHOPPY_VOLATILE"|"STRONG_TREND"|"NORMAL"}
   */
  interpretMarketCondition(volatility, trendStrength, overrides = {}) {
    const t = this.getMarketThresholds(overrides);
    if (volatility <= t.LOW_VOL && trendStrength < t.WEAK_TREND) return "DEAD_MARKET";
    if (volatility > t.HIGH_VOL && trendStrength < t.WEAK_TREND) return "CHOPPY_VOLATILE";
    if (trendStrength > t.STRONG_TREND)                          return "STRONG_TREND";
    return "NORMAL";
  }

  // ── Ranking ───────────────────────────────────────────────────────────────

  rankByMarketConditions(marketConditions = {}, overrides = {}) {
    const { volatility = 1.0, trend_strength = 0.1 } = marketConditions;
    const t = this.getMarketThresholds(overrides);

    // Component C — Swing (best in strong trends, moderate volatility)
    let scoreC = 50;
    if (trend_strength > t.NORMAL_TREND) scoreC += 40;
    if (volatility <= t.NORMAL_VOL)      scoreC += 20;
    if (volatility > t.HIGH_VOL)         scoreC -= 15;

    // Component B — Day Trading (balanced default, suffers at extremes)
    let scoreB = 70;
    if (trend_strength > 0.7)                                        scoreB -= 15;
    if (trend_strength < t.WEAK_TREND)                               scoreB -= 10;
    if (volatility >= 1.5 && volatility <= t.NORMAL_VOL)            scoreB += 15;

    // Component A — Scalping (thrives in choppy high-vol, dies in dead markets)
    let scoreA = 40;
    if (volatility > t.NORMAL_VOL)                                   scoreA += 40;
    if (trend_strength < t.WEAK_TREND)                               scoreA += 20;
    if (volatility <= t.LOW_VOL)                                     scoreA -= 30;

    const rankings = [
      { key: "A", label: this.SUB_STRATEGIES.A.label, score: this.clamp(scoreA, 0, 100) },
      { key: "B", label: this.SUB_STRATEGIES.B.label, score: this.clamp(scoreB, 0, 100) },
      { key: "C", label: this.SUB_STRATEGIES.C.label, score: this.clamp(scoreC, 0, 100) },
    ];
    return rankings.sort((a, b) => b.score - a.score);
  }

  canActivate(balance) {
    if (balance < 20) {
      return { allowed: false, reason: `Insufficient capital: need min $20, have $${balance}` };
    }
    return { allowed: true, reason: "Adaptive Fusion Strategy can activate" };
  }

  // ── P1: Component-Aware SL/TP ─────────────────────────────────────────────

  /**
   * Calculate SL, TP, and RR for a specific component.
   *
   * Component A (Scalp): SL 2.2× ATR, TP 3.3× ATR  → RR 1:1.5
   * Component B (Day):   SL 1.6× ATR, TP 3.4× ATR → RR 1:2.1
   * Component C (Swing): SL 1.2× ATR, TP 3.0× ATR → RR 1:2.5
   *
   * v2.5: opts.strongTrendTPMult × TP saat marketCond === STRONG_TREND.
   */
  calculateRiskConfig(entryPrice, atr, signal, component = "B", opts = {}) {
    const sub = this.SUB_STRATEGIES[component] || this.SUB_STRATEGIES.B;
    const slDist = atr * sub.slMultiplier;
    let tpDist = atr * sub.tpMultiplier;
    const strongMult = opts.strongTrendTPMult ?? 1;
    const strongTrendApplied =
      opts.marketCond === "STRONG_TREND" && strongMult > 1;
    if (strongTrendApplied) tpDist *= strongMult;

    let stopLoss, takeProfit;
    if (signal === "LONG") {
      stopLoss   = entryPrice - slDist;
      takeProfit = entryPrice + tpDist;
    } else {
      stopLoss   = entryPrice + slDist;
      takeProfit = entryPrice - tpDist;
    }

    return {
      stopLoss:    parseFloat(stopLoss.toFixed(8)),
      takeProfit:  parseFloat(takeProfit.toFixed(8)),
      riskReward:  parseFloat((tpDist / slDist).toFixed(2)),
      slMultiplier: sub.slMultiplier,
      tpMultiplier: strongTrendApplied
        ? parseFloat((sub.tpMultiplier * strongMult).toFixed(4))
        : sub.tpMultiplier,
      slDistance:  slDist,
      tpDistance:  tpDist,
      component,
      strongTrendTPApplied: strongTrendApplied,
    };
  }

  // ── AF-FIX-01: Per-Component Confidence Scoring (0–100) ───────────────────
  //
  // Sprint 7 (2026-06-29). Each component A/B/C now carries an EXPLICIT
  // indicator→weight mapping (sums to 100) so a fired signal is graded by
  // CONVICTION rather than treated as a binary yes/no. A component that BARELY
  // qualifies (weak RSI momentum, volume at threshold, price over-extended)
  // scores low and is filtered out by the ≥60% entry gate (AF-FIX-02); a clean
  // setup scores ~80–95.
  //
  // Indicator→weight table (the AF-FIX-01 deliverable):
  //   A (Aggressive Scalp):  emaAlign 25 · closeVsFast 15 · rsiVelocity 25 · rsiLevel 15 · volume 20
  //   B (Balanced Day):      emaStack 30 · closeVsSlow 15 · rsiBand   20 · event    25 · macd   10
  //   C (Swing):             closeVsSlow 25 · emaStructure 25 · rsiBand 20 · trendStrength 20 · proximity 10
  //
  // Structural conditions (EMA alignment, close-vs-EMA, fresh event) are already
  // TRUE when the component fired, so they contribute full weight; the graded
  // indicators differentiate strong from weak entries.
  getConfidenceWeights() {
    return {
      // OA-FIX-02 (Sprint 8): Order Flow A — OHLCV-approximated microstructure scoring
      // deltaStrength: bar delta (close-low)/(high-low) absorption strength
      // cvdAlign: cumulative volume delta direction over lookback
      // vwapSide: price side vs rolling VWAP (institutional reference)
      // volumeSurge: volume ratio vs SMA threshold
      A: { deltaStrength: 35, cvdAlign: 25, vwapSide: 20, volumeSurge: 20 },
      B: { emaStack: 30, closeVsSlow: 15, rsiBand: 20, event: 25, macd: 10 },
      C: { closeVsSlow: 25, emaStructure: 25, rsiBand: 20, trendStrength: 20, proximity: 10 },
      // D: SMC — zone quality (40) + structural confirm via EMA (30) + RSI neutrality (20) + ATR magnitude (10)
      D: { zoneQuality: 40, emaStructure: 30, rsiNeutral: 20, atrMagnitude: 10 },
    };
  }

  _clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  /**
   * AF-FIX-04: Net-edge filter — skip entry when expected move < k× fee.
   * feePct  = 0.12% roundtrip (taker, both legs)
   * k       = 2.0  (need 2× fee as minimum edge; configurable)
   * Knob-gated: OFF when config.netEdgeK is absent (backward compat).
   */
  _netEdgeCheck(atr, price, config = {}) {
    const k = config.netEdgeK ?? this.config?.netEdgeK ?? null;
    if (k == null || !atr || !price) return true; // gate OFF
    const feePct = config.feePct ?? this.config?.feePct ?? 0.0012;
    return (atr / price) >= k * feePct;
  }

  /** Band membership score: 1.0 at the band centre, 0.5 at the edges, 0 outside. */
  _bandScore(v, lo, hi) {
    if (v == null || v < lo || v > hi) return 0;
    const mid  = (lo + hi) / 2;
    const half = (hi - lo) / 2 || 1;
    return 0.5 + 0.5 * (1 - Math.abs(v - mid) / half);
  }

  /**
   * Assemble the indicator context used by _componentConfidence from the raw
   * indicator arrays at `lastIdx`. Shared by detectSignal (voting) and
   * detectSignalMulti so the two paths score identically.
   */
  _buildConfidenceContext(indicators, lastIdx, config = {}, marketConditions = {}) {
    const rsiSeries = indicators.rsi || [];
    const rsiCurr   = rsiSeries[lastIdx];
    const rsiPrev2  = rsiSeries[lastIdx - 2];
    const rsiSlope  = (rsiCurr != null && rsiPrev2 != null) ? (rsiCurr - rsiPrev2) / 2 : 0;
    const closes    = indicators.closes || [];
    const volSMAv   = indicators.volSMA?.[lastIdx] ?? 0;
    const volRatio  = volSMAv > 0 ? (indicators.volumes?.[lastIdx] ?? 0) / volSMAv : 0;

    // OA-FIX-02: Order Flow metrics for Component A confidence scoring.
    // OHLCV-approximated: no live order book needed for backtest.
    const highs  = indicators.highs  || [];
    const lows   = indicators.lows   || [];
    const vols   = indicators.volumes || [];
    const vwapLookback = config.vwapLookback ?? 14;
    const hi = highs[lastIdx], lo = lows[lastIdx], cl = closes[lastIdx];
    const barRange = (hi != null && lo != null) ? Math.max(hi - lo, 1e-9) : null;
    const deltaPct = (barRange != null && lo != null && cl != null)
      ? (cl - lo) / barRange
      : 0.5; // neutral fallback when no highs/lows data
    let cvd = 0, sumTV = 0, sumVol = 0;
    for (let i = Math.max(0, lastIdx - vwapLookback + 1); i <= lastIdx; i++) {
      const h = highs[i], l = lows[i], c = closes[i], v = vols[i] ?? 0;
      if (h != null && l != null && c != null) {
        const r = Math.max(h - l, 1e-9);
        cvd   += ((c - l) / r - 0.5) * v;
        sumTV += ((h + l + c) / 3) * v;
      }
      sumVol += v;
    }
    const vwap = sumVol > 0 ? sumTV / sumVol : (cl ?? null);

    return {
      rsi:        rsiCurr,
      rsiSlope,
      emaFast:    indicators.emaFast?.[lastIdx]  ?? null,
      emaSlow:    indicators.emaSlow?.[lastIdx]  ?? null,
      emaTrend:   indicators.emaTrend?.[lastIdx] ?? null,
      close:      closes[lastIdx],
      atr:        indicators.atr?.[lastIdx] ?? 0,
      volRatio,
      volMult:    config.volSmaMultiplier ?? 2.0,
      trendStrength: marketConditions?.trend_strength ?? 0,
      macdHist:   indicators.macdHistogram?.[lastIdx] ?? null,
      rsiLongMin:  config.rsiLongMin  ?? 60,
      rsiLongMax:  config.rsiLongMax  ?? 68,
      rsiShortMin: config.rsiShortMin ?? 32,
      rsiShortMax: config.rsiShortMax ?? 40,
      // Order Flow fields
      deltaPct,
      cvd,
      vwap,
      volLookbackSum: sumVol,
    };
  }

  /**
   * Compute a 0–100 confidence score for a component that fired `direction`.
   * @param {"A"|"B"|"C"} key
   * @param {"LONG"|"SHORT"|null} direction
   * @param {Object} d  context from _buildConfidenceContext
   */
  _componentConfidence(key, direction, d = {}) {
    if (!direction) return 0;
    const W = this.getConfidenceWeights()[key];
    if (!W) return 0;
    const long = direction === "LONG";
    let score = 0;

    if (key === "A") {
      // OA-FIX-02: Order Flow confidence scoring (OHLCV-approximated).
      // deltaStrength: how strongly the bar closed on buyer/seller side
      const dp = d.deltaPct ?? 0.5;
      score += W.deltaStrength * this._clamp01(long ? (dp - 0.5) / 0.5 : (0.5 - dp) / 0.5);
      // cvdAlign: graded by CVD magnitude vs total lookback volume
      const maxCVD = (d.volLookbackSum ?? 1) * 0.5 + 1e-9;
      score += W.cvdAlign * this._clamp01(long ? d.cvd / maxCVD : -d.cvd / maxCVD);
      // vwapSide: binary — price above or below VWAP
      if (d.vwap != null && d.close != null) {
        score += W.vwapSide * (long ? (d.close > d.vwap ? 1 : 0) : (d.close < d.vwap ? 1 : 0));
      } else {
        score += W.vwapSide * 0.5; // no VWAP data → neutral
      }
      // volumeSurge: graded by ratio vs threshold
      score += W.volumeSurge * this._clamp01(d.volMult > 0 ? d.volRatio / (d.volMult * 2) : 0);
    } else if (key === "B") {
      let stack = 0;
      if (d.emaFast != null && d.emaSlow != null &&
          (long ? d.emaFast > d.emaSlow : d.emaFast < d.emaSlow)) stack += 0.5;
      // Fix: null emaTrend → neutral 0.25, not full 0.5 (no data ≠ confirmation)
      if (d.emaTrend == null) stack += 0.25;
      else if (long ? d.emaSlow > d.emaTrend : d.emaSlow < d.emaTrend) stack += 0.5;
      score += W.emaStack * stack;
      if (d.close != null && d.emaSlow != null &&
          (long ? d.close > d.emaSlow : d.close < d.emaSlow)) score += W.closeVsSlow;
      const lo = long ? d.rsiLongMin  : d.rsiShortMin;
      const hi = long ? d.rsiLongMax  : d.rsiShortMax;
      score += W.rsiBand * this._bandScore(d.rsi, lo, hi);
      score += W.event;  // a fired B implies a fresh cross / pullback-resume event
      if (d.macdHist == null) score += W.macd * 0.5;
      else score += W.macd * (long ? (d.macdHist > 0 ? 1 : 0) : (d.macdHist < 0 ? 1 : 0));
    } else if (key === "C") {
      // Fix: tautological binary checks replaced with graded distance metrics so
      // marginal C fires (barely above emaSlow, thin EMA spread) score below 60.
      // closeVsSlow: full score within 1 ATR of emaSlow, decays to 0 at 4+ ATR.
      if (d.close != null && d.emaSlow != null && d.atr > 0) {
        const dist = Math.abs(d.close - d.emaSlow) / d.atr;
        score += W.closeVsSlow * this._clamp01(1 - Math.max(0, dist - 1) / 3);
      } else if (d.close != null && d.emaSlow != null) {
        score += W.closeVsSlow * 0.5;
      }
      // emaStructure: graded by EMA separation / ATR — wider spread = stronger trend.
      if (d.emaFast != null && d.emaSlow != null && d.atr > 0) {
        const sep = Math.abs(d.emaFast - d.emaSlow) / d.atr;
        score += W.emaStructure * this._clamp01(sep / 3);
      } else if (d.emaFast != null && d.emaSlow != null) {
        score += W.emaStructure * 0.5;
      }
      const lo = long ? 45 : 35;
      const hi = long ? 65 : 55;
      score += W.rsiBand * this._bandScore(d.rsi, lo, hi);
      const strongRef = this.getMarketThresholds().STRONG_TREND || 0.4;
      score += W.trendStrength * this._clamp01((d.trendStrength ?? 0) / strongRef);
      if (d.close != null && d.emaFast != null && d.atr > 0) {
        const ext = Math.abs(d.close - d.emaFast) / d.atr;
        score += W.proximity * this._clamp01(1 - ext / 2);
      } else {
        score += W.proximity * 0.5;
      }
    } else if (key === "D") {
      // zoneQuality: graded by how well price is inside the zone (EMA distance proxy)
      if (d.close != null && d.emaSlow != null && d.atr > 0) {
        const dist = Math.abs(d.close - d.emaSlow) / d.atr;
        score += W.zoneQuality * this._clamp01(1 - dist / 3);
      } else {
        score += W.zoneQuality * 0.5;
      }
      // emaStructure: EMA9 and EMA21 aligned with trade direction
      if (d.emaFast != null && d.emaSlow != null) {
        const aligned = long ? d.emaFast > d.emaSlow : d.emaFast < d.emaSlow;
        score += W.emaStructure * (aligned ? 1 : 0);
      }
      // rsiNeutral: RSI near 50 is ideal for SMC (fresh structure, not overextended)
      if (d.rsi != null) {
        score += W.rsiNeutral * this._clamp01(1 - Math.abs(d.rsi - 50) / 30);
      }
      // atrMagnitude: higher ATR → bigger OB/FVG zones → more meaningful levels
      if (d.atr != null && d.close != null && d.close > 0) {
        const atrPct = (d.atr / d.close) * 100;
        score += W.atrMagnitude * this._clamp01(atrPct / 2);
      }
    }
    return Math.round(this._clamp01(score / 100) * 100);
  }

  // ── Main Signal Detection ─────────────────────────────────────────────────

  /**
   * Detect entry signal using all 3 components.
   * P4: Components with score below threshold are skipped.
   * Returns "LONG" | "SHORT" | null.
   * Sets this._lastSignalMeta for external SL/TP lookup.
   */
  detectSignal(indicators, lastIdx, config = {}) {
    this._lastSignalMeta = null;
    if (lastIdx < 30) return null;

    const balance = config.balance || 500;

    const rsi     = indicators.rsi?.[lastIdx];
    const atr     = indicators.atr?.[lastIdx];
    const closes  = indicators.closes || [];
    const emaFast = indicators.emaFast?.[lastIdx];
    const emaSlow = indicators.emaSlow?.[lastIdx];
    const volumes = indicators.volumes || [];
    const volSMA  = indicators.volSMA  || [];

    if (!rsi || !atr || closes.length < 3) return null;

    // #BugB: slice sampai lastIdx+1 agar Component B & C tidak membaca candle yang
    // masih forming (closes[closes.length-1] = candle aktif, belum confirmed).
    // lastIdx = candles.length-2 = candle terakhir yang sudah closed sepenuhnya.
    const closesConfirmed = closes.slice(0, lastIdx + 1);

    // P4: Get scores and filter out low-scoring components
    const marketConditions = {
      volatility:      config.volatility      || 1.0,
      trend_strength:  config.trend_strength  || 0.1,
    };

    // P7: Regime gate — JANGAN entry di dead market. Post-mortem 11–12 Jun:
    // 18/18 trade SL terjadi saat ATR% 0.30–0.45 & trend_strength < 0.06.
    // Di regime ini SL 1–2×ATR berada di dalam noise normal candle 15m,
    // sementara TP 2.5–3×ATR butuh pergerakan yang hampir tak pernah terjadi
    // → SL hampir pasti tersentuh duluan. Catatan: default config (vol=1.0,
    // trend=0.1) juga terklasifikasi DEAD_MARKET — caller WAJIB mengirim
    // kondisi market nyata (BotEngine & AdaptiveStrategyEngine sudah).
    const marketCond = this.interpretMarketCondition(
      marketConditions.volatility,
      marketConditions.trend_strength
    );
    if (marketCond === "DEAD_MARKET") return null;

    // v2.3 spec (STRATEGIES.md §4): HTF (1h) alignment WAJIB sebelum voting.
    // Bila caller (AdaptiveStrategyEngine/BotEngine) menyuplai htfTrend, blok
    // entry saat regime HTF tak bisa ditentukan (UNKNOWN) → fail-closed. Filter
    // directional (LONG vs BEARISH dst) diterapkan setelah sinyal di-resolve.
    // Backward-compatible: bila htfTrend tidak disuplai (unit test), gate dilewati.
    const htfTrend = config.htfTrend ?? null;
    if (htfTrend === "UNKNOWN") return null;

    // v2.5: HTF trend strength gate — trend harus cukup kuat sebelum voting.
    if (config.htfTrendStrengthMin != null && htfTrend && htfTrend !== "SIDEWAYS") {
      const ts = config.htfTrendStrength;
      if (ts == null || ts < config.htfTrendStrengthMin) return null;
    }

    const rankings  = this.rankByMarketConditions(marketConditions);
    const scoreMap  = Object.fromEntries(rankings.map(r => [r.key, r.score]));

    const signals = {};

    // AF-FIX-14: previous EMA9 value for slope filter in A and B
    const emaFastPrev = indicators.emaFast?.[lastIdx - 1] ?? null;

    // Component A — only run if balance sufficient AND score meets threshold
    if (
      balance >= this.SUB_STRATEGIES.A.minCapital &&
      (scoreMap.A ?? 0) >= this.SUB_STRATEGIES.A.minScore
    ) {
      const vol    = volumes[lastIdx] ?? 0;
      const vSMA   = volSMA[lastIdx]  ?? 0;
      signals.A = this._detectSignalA(
        closes, indicators.highs || [], indicators.lows || [],
        indicators.volumes || [], indicators.volSMA || [],
        emaFast, emaSlow, lastIdx, config
      );
    }

    // Component B — only run if balance sufficient AND score meets threshold
    if (
      balance >= this.SUB_STRATEGIES.B.minCapital &&
      (scoreMap.B ?? 0) >= this.SUB_STRATEGIES.B.minScore
    ) {
      const emaLong = indicators.emaTrend?.[lastIdx] ?? null;
      signals.B = this._detectSignalB(
        rsi,
        indicators.emaFast || [],
        indicators.emaSlow || [],
        emaLong,
        closesConfirmed,
        lastIdx,
        { ...config, macdHistogram: indicators.macdHistogram?.[lastIdx] ?? null }
      );
    }

    // Component C — only run if balance sufficient AND score meets threshold
    if (
      balance >= this.SUB_STRATEGIES.C.minCapital &&
      (scoreMap.C ?? 0) >= this.SUB_STRATEGIES.C.minScore
    ) {
      signals.C = this._detectSignalC(rsi, emaFast, emaSlow, closesConfirmed);
    }

    // AF-FIX-01/02 (Sprint 7): score every fired component (0–100) and gate the
    // vote by confidence. Only components clearing afMinComponentConfidence (60)
    // may vote; if fewer than 2 valid components remain → no-entry. Backward
    // compatible: when the knob is absent (legacy unit tests) the gate is OFF and
    // voting runs over all fired components exactly as before.
    const minComponentConf =
      config.afMinComponentConfidence ?? this.config?.afMinComponentConfidence ?? null;
    const confCtx     = this._buildConfidenceContext(indicators, lastIdx, config, marketConditions);
    const confidences = {};
    const validSignals = {};
    for (const k of ["A", "B", "C"]) {
      if (!signals[k]) continue;
      const conf = this._componentConfidence(k, signals[k], confCtx);
      confidences[k] = conf;
      if (minComponentConf == null || conf >= minComponentConf) validSignals[k] = signals[k];
    }

    // PAIR-TIER-07 / v2.3: respect votingThresholdOverride from pair tier
    // (STABLE 0.60, SEMI_VOLATILE 0.70, VOLATILE 0.78 — lihat PairClassifier).
    const votingThresholdOverride = config.tierOverrides?.votingThresholdOverride ?? null;
    const voteOpts = {
      rejectOnDissent: config.afRejectOnDissent ?? true,
      // v2.3 spec (STRATEGIES.md §4): afMinVotes default 2 → 3 (konsensus lebih kuat).
      minVotes:        config.afMinVotes ?? 3,
    };
    let resolved;
    if (minComponentConf != null) {
      // AF-FIX-02: <2 komponen lolos threshold → skip bar.
      resolved = Object.keys(validSignals).length < 2
        ? null
        : this._resolveSignalConflict(validSignals, votingThresholdOverride, voteOpts);
    } else {
      resolved = this._resolveSignalConflict(signals, votingThresholdOverride, voteOpts);
    }

    // v2.3: HTF directional alignment WAJIB — buang sinyal yang melawan tren HTF.
    // LONG hanya valid bila HTF bukan BEARISH; SHORT hanya bila HTF bukan BULLISH.
    if (resolved && htfTrend) {
      if (resolved === "LONG"  && htfTrend === "BEARISH") resolved = null;
      if (resolved === "SHORT" && htfTrend === "BULLISH") resolved = null;
    }

    // FEE-01: Anti-chase guard. Post-mortem data (69 trade live): LONG WR 21%
    // (-$37.90) sementara SHORT breakeven, dan Component C state-based fire
    // berulang di tren (WLDUSDT 36 trade). Akar = entry CHASING — harga sudah
    // jauh dari mean (EMA9) saat masuk, sehingga pullback normal langsung
    // menyentuh SL. Tolak entry bila ekstensi |close - EMA9| / ATR melebihi
    // maxEntryExtensionATR (default 1.5). Entry hanya diterima DEKAT mean
    // (fresh cross / pullback-resume), bukan di ujung ekstensi. Ini menaikkan
    // kualitas entry (WR) tanpa mematikan AF. Lihat juga FEE-03 min-edge gate.
    if (resolved) {
      const closeConfirmed = closesConfirmed[lastIdx] ?? closes[lastIdx];
      const maxExt = config.maxEntryExtensionATR ?? 0.7;
      if (
        closeConfirmed != null && emaFast != null && atr > 0 &&
        Math.abs(closeConfirmed - emaFast) / atr > maxExt
      ) {
        const ext = (Math.abs(closeConfirmed - emaFast) / atr).toFixed(2);
        this._lastChaseReject = { signal: resolved, extension: ext, maxExt };
        resolved = null;
      }
    }

    // AF-FIX-04: net-edge filter — skip entry when ATR/price < k × feePct.
    // Eliminates micro-edge trades where fees eat the expected profit.
    if (resolved && !this._netEdgeCheck(atr, closes[lastIdx] ?? closes[closes.length - 1], config)) {
      this._lastNetEdgeReject = { signal: resolved, atr, price: closes[lastIdx] };
      resolved = null;
    }

    // AF-FIX-03 (Sprint 7): block low-conviction reversal/"Signal" entries. Live
    // post-mortem: the majority of losing entries were weak reversals that only
    // paid fees. Require the AGGREGATE confidence (mean of components backing the
    // resolved direction) to clear afMinAggregateConfidence (60). The HTF
    // directional filter above already enforces regime alignment; together they
    // satisfy "block reversal unless confidence ≥60% AND aligned with HTF".
    let aggregateConfidence = null;
    if (resolved) {
      // Fix: use gate-cleared validSignals (not all fired signals) when component gate active
      const sigMap = minComponentConf != null ? validSignals : signals;
      const agreeing = ["A", "B", "C"].filter(k => sigMap[k] === resolved && confidences[k] != null);
      if (agreeing.length) {
        aggregateConfidence = Math.round(
          agreeing.reduce((s, k) => s + confidences[k], 0) / agreeing.length
        );
      }
      const minAgg =
        config.afMinAggregateConfidence ?? this.config?.afMinAggregateConfidence ?? null;
      if (minAgg != null && (aggregateConfidence == null || aggregateConfidence < minAgg)) {
        this._lastConfidenceReject = { signal: resolved, aggregate: aggregateConfidence, minAgg };
        resolved = null;
      }
    }

    if (resolved) {
      // P6: Store which component(s) fired for SL/TP selection
      let winningComponent = this._pickBestComponent(signals, resolved, scoreMap);

      // v2.3 spec (STRATEGIES.md §4): "SL wajib pakai komponen C logic (Swing)
      // di VOLATILE pair". Untuk pair VOLATILE/SEMI_VOLATILE, paksa komponen C
      // (SL 1×ATR / TP 2.5×ATR — swing) agar SL tidak terlalu sempit di koin
      // berisiko tinggi. Dideteksi via config.pairTier atau config.tierOverrides.
      const isVolatilePair = this._isVolatilePair(config);
      let forcedComponent = null;
      if (isVolatilePair) {
        forcedComponent = "C";
        winningComponent = "C";
      }

      this._lastSignalMeta = {
        direction:   resolved,
        component:   winningComponent,
        forcedComponent,
        votes:       signals,
        scores:      scoreMap,
        // AF-FIX-01/03: per-component + aggregate confidence (for logs / trade record).
        confidence:           confidences,
        componentConfidence:  confidences[winningComponent] ?? null,
        aggregateConfidence,
        marketCond,
        htfTrend,
      };
    }

    return resolved;
  }

  /**
   * detectSignalMulti — Multi-position mode (v3.0)
   * Returns {A, B, C} with each component's signal (LONG/SHORT/null) independently.
   * NO voting consensus — each component that triggers opens its own position.
   * Gates (market condition, HTF trend, chase guard) applied per-component.
   */
  detectSignalMulti(indicators, lastIdx, config = {}) {
    const result = { A: null, B: null, C: null, D: null, meta: {} };
    if (lastIdx < 30) return result;

    const balance = config.balance || 500;
    const rsi     = indicators.rsi?.[lastIdx];
    const atr     = indicators.atr?.[lastIdx];
    const closes  = indicators.closes || [];
    const emaFast = indicators.emaFast?.[lastIdx];
    const emaSlow = indicators.emaSlow?.[lastIdx];
    const volumes = indicators.volumes || [];
    const volSMA  = indicators.volSMA  || [];

    if (!rsi || !atr || closes.length < 3) return result;

    const closesConfirmed = closes.slice(0, lastIdx + 1);
    const marketConditions = {
      volatility:      config.volatility      || 1.0,
      trend_strength:  config.trend_strength  || 0.1,
    };

    // v3.0: per-call threshold overrides (TF-aware regime calibration / sweeps)
    const thr = config.marketThresholds || {};

    // Global gate: DEAD_MARKET blocks all components
    const marketCond = this.interpretMarketCondition(
      marketConditions.volatility,
      marketConditions.trend_strength,
      thr
    );
    if (marketCond === "DEAD_MARKET") return result;

    const htfTrend = config.htfTrend ?? null;
    if (htfTrend === "UNKNOWN") return result;

    if (config.htfTrendStrengthMin != null && htfTrend && htfTrend !== "SIDEWAYS") {
      const ts = config.htfTrendStrength;
      if (ts == null || ts < config.htfTrendStrengthMin) return result;
    }

    const rankings  = this.rankByMarketConditions(marketConditions, thr);
    const scoreMap  = Object.fromEntries(rankings.map(r => [r.key, r.score]));
    const maxExt    = config.maxEntryExtensionATR ?? 0.7;
    const D = config._diag || null; // optional per-component funnel counters

    // AF-FIX-01/02 (Sprint 7): per-component confidence gate. A component fires
    // only if its conviction score (0–100) clears afMinComponentConfidence (60).
    // Backward compatible: knob absent → gate OFF (legacy unit-test behaviour).
    const minComponentConf =
      config.afMinComponentConfidence ?? this.config?.afMinComponentConfidence ?? null;
    const confCtx     = this._buildConfidenceContext(indicators, lastIdx, config, marketConditions);
    const confidence  = { A: null, B: null, C: null, D: null };

    // v3.2 (2026-06-29): component enable-list. Real BNB data (19,969 15m bars,
    // Dec 2025–Jun 2026) showed A (PF 0.31) and B (PF 0.41) have NEGATIVE edge —
    // they are EMA-crossover scalp/day designs that whipsaw on real 15m chop.
    // Only C (Swing, RR 4.5 trend-following: small losses, occasional big wins)
    // is profitable (PF 1.45). Default to C-only; pass afEnabledComponents to
    // override (e.g. ["A","B","C"] for research/backtest comparison).
    const enabled = config.afEnabledComponents
      || this.config?.afEnabledComponents
      || ["A", "B", "C", "D"];

    // AF-FIX-14: previous EMA9 for slope filter; AF-FIX-11: MACD histogram for B
    const emaFastPrev    = indicators.emaFast?.[lastIdx - 1] ?? null;
    const macdHistCurr   = indicators.macdHistogram?.[lastIdx] ?? null;

    // Shared per-component pipeline: raw signal → HTF filter → chase guard → net-edge.
    const evalComponent = (key, rawSig) => {
      if (D) D.evaluated[key] = (D.evaluated[key] || 0) + 1;
      let sig = rawSig;
      if (!sig) { if (D) D.signalNull[key] = (D.signalNull[key] || 0) + 1; return null; }
      if (D) D.rawSignal[key] = (D.rawSignal[key] || 0) + 1;
      if (htfTrend) {
        if (sig === "LONG"  && htfTrend === "BEARISH") sig = null;
        // v3.1: SHORT only in confirmed BEARISH HTF — SIDEWAYS allows too many
        // counter-trend entries in ranging/bullish markets (WR 31.6%, PF 0.78).
        if (sig === "SHORT" && htfTrend !== "BEARISH") sig = null;
      }
      if (!sig) { if (D) D.htfBlock[key] = (D.htfBlock[key] || 0) + 1; return null; }
      const closeConfirmed = closesConfirmed[lastIdx] ?? closes[lastIdx];
      if (closeConfirmed != null && emaFast != null && atr > 0 &&
          Math.abs(closeConfirmed - emaFast) / atr > maxExt) {
        if (D) D.chaseBlock[key] = (D.chaseBlock[key] || 0) + 1;
        return null;
      }
      // AF-FIX-04: net-edge filter — same gate as detectSignal() voting path
      if (!this._netEdgeCheck(atr, closeConfirmed ?? closes[lastIdx], config)) {
        if (D) { D.netEdgeBlock = D.netEdgeBlock || {}; D.netEdgeBlock[key] = (D.netEdgeBlock[key] || 0) + 1; }
        return null;
      }
      // AF-FIX-02: conviction gate — score the (HTF-aligned, non-chasing) signal
      // and drop it if confidence is below threshold. "Trade lebih confidence".
      const conf = this._componentConfidence(key, sig, confCtx);
      confidence[key] = conf;
      if (minComponentConf != null && conf < minComponentConf) {
        if (D) { D.confBlock = D.confBlock || {}; D.confBlock[key] = (D.confBlock[key] || 0) + 1; }
        return null;
      }
      if (D) D.fired[key] = (D.fired[key] || 0) + 1;
      return sig;
    };

    // ── Component A ──────────────────────────────────────────────────────────
    if (enabled.includes("A") &&
        balance >= this.SUB_STRATEGIES.A.minCapital && (scoreMap.A ?? 0) >= this.SUB_STRATEGIES.A.minScore) {
      const vol    = volumes[lastIdx] ?? 0;
      const vSMA   = volSMA[lastIdx]  ?? 0;
      result.A = evalComponent("A", this._detectSignalA(
        closes, indicators.highs || [], indicators.lows || [],
        indicators.volumes || [], indicators.volSMA || [],
        emaFast, emaSlow, lastIdx, config
      ));
    } else if (D) { D.scoreGate.A = (D.scoreGate.A || 0) + 1; }

    // ── Component B ──────────────────────────────────────────────────────────
    if (enabled.includes("B") &&
        balance >= this.SUB_STRATEGIES.B.minCapital && (scoreMap.B ?? 0) >= this.SUB_STRATEGIES.B.minScore) {
      const emaLong = indicators.emaTrend?.[lastIdx] ?? null;
      result.B = evalComponent("B", this._detectSignalB(rsi, indicators.emaFast || [], indicators.emaSlow || [], emaLong, closesConfirmed, lastIdx, { ...config, macdHistogram: macdHistCurr }));
    } else if (D) { D.scoreGate.B = (D.scoreGate.B || 0) + 1; }

    // ── Component C ──────────────────────────────────────────────────────────
    // v3.1: C (Swing) was restricted to STRONG_TREND only — calibrated for 15m entry.
    // AF-FIX-17: Now on 1h TF, allow C in NORMAL too. STRONG_TREND restriction caused
    // C to fire 0 times in NORMAL/BULL markets (trendStrength rarely > 0.40 on 1h).
    // Confidence gate (afMinComponentConfidence: 60) serves as the quality guard.
    // CHOPPY_VOLATILE still blocked (wide ATR + low trend = bad swing entry).
    if (enabled.includes("C") &&
        balance >= this.SUB_STRATEGIES.C.minCapital &&
        (scoreMap.C ?? 0) >= this.SUB_STRATEGIES.C.minScore &&
        (marketCond === "STRONG_TREND" || marketCond === "NORMAL")) {
      result.C = evalComponent("C", this._detectSignalC(rsi, emaFast, emaSlow, closesConfirmed));
    } else if (D) { D.scoreGate.C = (D.scoreGate.C || 0) + 1; }

    // ── Component D (SMC) ────────────────────────────────────────────────────
    // Fires on Order Block / FVG retrace with EMA macro-alignment.
    // Allowed in NORMAL + STRONG_TREND (SMC levels work in both, not in chop).
    if (enabled.includes("D") &&
        balance >= this.SUB_STRATEGIES.D.minCapital &&
        (marketCond === "STRONG_TREND" || marketCond === "NORMAL")) {
      const highs = indicators.highs || [];
      const lows  = indicators.lows  || [];
      result.D = evalComponent("D", this._detectSignalD(
        closesConfirmed, highs, lows, emaFast, emaSlow, lastIdx, config
      ));
    } else if (D) { D.scoreGate.D = (D.scoreGate.D || 0) + 1; }

    // AF-FIX-03 (live path fix): aggregate confidence gate mirrors detectSignal().
    // Without this, afMinAggregateConfidence was dead code in the primary live path.
    const minAgg = config.afMinAggregateConfidence ?? this.config?.afMinAggregateConfidence ?? null;
    if (minAgg != null) {
      for (const dir of ["LONG", "SHORT"]) {
        const fired = ["A", "B", "C", "D"].filter(k => result[k] === dir && confidence[k] != null);
        if (!fired.length) continue;
        const avgConf = fired.reduce((s, k) => s + confidence[k], 0) / fired.length;
        if (avgConf < minAgg) {
          for (const k of fired) result[k] = null;
        }
      }
    }

    result.meta = { scoreMap, marketCond, htfTrend, confidence, minComponentConfidence: minComponentConf };
    return result;
  }

  /**
   * Pick the highest-scoring component that agrees with the resolved direction.
   * Used to select the right SL/TP multiplier.
   */
  _pickBestComponent(signals, direction, scoreMap) {
    const agreeing = Object.entries(signals)
      .filter(([, sig]) => sig === direction)
      .sort(([ka], [kb]) => (scoreMap[kb] ?? 0) - (scoreMap[ka] ?? 0));
    return agreeing.length > 0 ? agreeing[0][0] : "B";
  }

  /**
   * v2.3: deteksi apakah pair tergolong VOLATILE/SEMI_VOLATILE dari config.
   * Sumber prioritas: config.pairTier (string tier) → fallback config.tierOverrides
   * (regimeFilterRequired + votingThresholdOverride ketat mengindikasikan tier
   * berisiko). Dipakai untuk memaksa SL komponen C (Swing) di pair volatil.
   * @param {Object} config
   * @returns {boolean}
   */
  _isVolatilePair(config = {}) {
    const tier = config.pairTier || config.tierOverrides?.tier || null;
    if (tier) return tier === "VOLATILE" || tier === "SEMI_VOLATILE";
    // Fallback heuristik: regime filter wajib + ambang voting ≥ 0.70 ≈ tier berisiko.
    const to = config.tierOverrides;
    if (to && to.regimeFilterRequired && (to.votingThresholdOverride ?? 0) >= 0.70) {
      return true;
    }
    return false;
  }

  /**
   * Expose last signal metadata for SL/TP calculation by BotEngine.
   * BotEngine should call this immediately after detectSignal() returns non-null.
   */
  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  // ── Component A — Order Flow (OA-FIX-01/02, v3.7.0) ──────────────────────
  // Replaces RSI-velocity scalping with OHLCV-approximated order flow.
  // No live order book needed — uses candle OHLCV to reconstruct:
  //   deltaPct  = (close-low) / max(high-low, ε)  — bar buying pressure (1=all buyers)
  //   cvd       = Σ (deltaPct-0.5)×volume over vwapLookback bars (net demand)
  //   vwap      = Σ (typicalPrice×volume) / Σ volume (institutional reference)
  //
  // LONG: deltaPct ≥ threshold (buyer absorption) + CVD > 0 + close > VWAP +
  //       EMA aligned bullish + volume surge
  // SHORT: mirror — seller domination + CVD < 0 + close < VWAP + EMA bearish + surge
  //
  // @param {number[]} closes     full close array (lastIdx=current bar)
  // @param {number[]} highs      full high array
  // @param {number[]} lows       full low array
  // @param {number[]} volumes    full volume array
  // @param {number[]|number} volSMA  volSMA array (indexed) or scalar
  // @param {number}   emaFast    current EMA9 scalar
  // @param {number}   emaSlow    current EMA21 scalar
  // @param {number}   lastIdx    index of current confirmed bar
  // @param {Object}   config     strategy config (vwapLookback, ofDeltaThreshold, volSmaMultiplier)
  _detectSignalA(closes, highs, lows, volumes, volSMA, emaFast, emaSlow, lastIdx, config = {}) {
    if (emaFast == null || emaSlow == null) return null;
    if (!Array.isArray(closes) || !Array.isArray(highs) || !Array.isArray(lows)) return null;

    const hi = highs[lastIdx], lo = lows[lastIdx], cl = closes[lastIdx];
    if (hi == null || lo == null || cl == null) return null;

    const vSMA    = Array.isArray(volSMA) ? (volSMA[lastIdx] ?? 0) : (volSMA ?? 0);
    const volCurr = Array.isArray(volumes) ? (volumes[lastIdx] ?? 0) : 0;
    const volMult = config.volSmaMultiplier ?? 2.0;
    const volOk   = vSMA > 0 && volCurr / vSMA >= volMult;

    const ofDeltaThreshold = config.ofDeltaThreshold ?? 0.60;
    const vwapLookback     = config.vwapLookback     ?? 14;

    // Bar delta: fraction of bar range that closed above the low
    const barRange = Math.max(hi - lo, 1e-9);
    const deltaPct = (cl - lo) / barRange;

    // Rolling CVD and VWAP over lookback window
    let cvd = 0, sumTV = 0, sumVol = 0;
    for (let i = Math.max(0, lastIdx - vwapLookback + 1); i <= lastIdx; i++) {
      const h = highs[i], l = lows[i], c = closes[i];
      const v = Array.isArray(volumes) ? (volumes[i] ?? 0) : 0;
      if (h == null || l == null || c == null) { sumVol += v; continue; }
      const r = Math.max(h - l, 1e-9);
      cvd   += ((c - l) / r - 0.5) * v;
      sumTV += ((h + l + c) / 3) * v;
      sumVol += v;
    }
    const vwap = sumVol > 0 ? sumTV / sumVol : cl;

    // LONG: buyer absorption (deltaPct ≥ threshold = close in top portion of range) +
    //       net buying pressure (CVD > 0) + bullish EMA structure + volume confirmed.
    // NOTE: close > VWAP is intentionally NOT required here — it acts as a soft filter
    // via the confidence gate instead (vwapSide adds 20 pts; without it score drops ~20,
    // making counter-VWAP entries very likely fall below the 60-confidence threshold).
    // This keeps signal frequency viable on 1h TF without sacrificing quality gating.
    if (deltaPct >= ofDeltaThreshold && cvd > 0 && emaFast > emaSlow && volOk) {
      return "LONG";
    }

    // SHORT: seller absorption + net selling pressure + bearish EMA + volume
    if (deltaPct <= (1 - ofDeltaThreshold) && cvd < 0 && emaFast < emaSlow && volOk) {
      return "SHORT";
    }

    return null;
  }

  // ── Component B — Day Trading (v2.2 / P8: EVENT-BASED) ──────────────────
  //
  // Post-mortem 11–12 Jun: versi v2.1 ("3-EMA alignment state") fire di SETIAP
  // candle selama tren berlangsung. Karena C juga state-based dengan kondisi
  // yang hampir identik (alignment + RSI band beririsan 50–65), kuorum voting
  // 2/3 tercapai terus-menerus → bot entry di titik mana pun dalam tren —
  // rata-rata sudah +0.2–0.76% di atas EMA9 (chasing) → pullback normal ke
  // mean langsung menyentuh SL. Hasil: 18/18 loss.
  //
  // v2.2: alignment tetap jadi SYARAT, tapi B hanya fire saat ada EVENT segar
  // di dalam lookback window:
  //   Event 1 — fresh crossover : EMA9 baru saja melintasi EMA21
  //   Event 2 — pullback-resume : harga sempat menyentuh/menembus EMA9 melawan
  //             arah tren (pullback ke mean) lalu candle sekarang close kembali
  //             searah tren. Entry terjadi DEKAT mean, bukan di ujung ekstensi.
  //
  // @param {number}        rsi
  // @param {number[]}      emaFastArr — series EMA9 (index sejajar closes)
  // @param {number[]}      emaSlowArr — series EMA21
  // @param {number|null}   emaLong    — EMA50 scalar (null = abaikan filter)
  // @param {number[]}      closes     — closes terkonfirmasi s/d lastIdx
  // @param {number}        lastIdx    — index candle confirmed terakhir

  _detectSignalB(rsi, emaFastArr, emaSlowArr, emaLong, closes, lastIdx, config = {}) {
    if (!Array.isArray(emaFastArr) || !Array.isArray(emaSlowArr)) return null;
    if (!Array.isArray(closes) || closes.length < 2) return null;
    if (lastIdx == null) lastIdx = closes.length - 1;

    const rsiLongMin  = config.rsiLongMin  ?? 60;
    const rsiLongMax  = config.rsiLongMax  ?? 68;
    const rsiShortMin = config.rsiShortMin ?? 32;
    const rsiShortMax = config.rsiShortMax ?? 40;

    const emaFast = emaFastArr[lastIdx];
    const emaSlow = emaSlowArr[lastIdx];
    if (emaFast == null || emaSlow == null) return null;

    const closeCurr = closes[lastIdx] ?? closes[closes.length - 1];
    if (closeCurr == null) return null;

    // AF-FIX-17: Extended from 3→5. On 1h TF a pullback can take 4–5 candles to complete;
    // 3-bar window expired before RSI recovered to band → B almost never fired.
    const LOOKBACK = 5; // event harus terjadi dalam 5 candle confirmed terakhir

    // Event 1: fresh EMA9×EMA21 crossover dalam lookback window
    const hasFreshCross = (dir) => {
      for (let i = Math.max(1, lastIdx - LOOKBACK + 1); i <= lastIdx; i++) {
        const fPrev = emaFastArr[i - 1], sPrev = emaSlowArr[i - 1];
        const fCurr = emaFastArr[i],     sCurr = emaSlowArr[i];
        if (fPrev == null || sPrev == null || fCurr == null || sCurr == null) continue;
        if (dir === "LONG"  && fPrev <= sPrev && fCurr > sCurr) return true;
        if (dir === "SHORT" && fPrev >= sPrev && fCurr < sCurr) return true;
      }
      return false;
    };

    // Event 2: pullback ke EMA9 lalu resume searah tren pada candle sekarang
    const hasPullbackResume = (dir) => {
      if (dir === "LONG"  && closeCurr <= emaFast) return false;
      if (dir === "SHORT" && closeCurr >= emaFast) return false;
      for (let i = Math.max(0, lastIdx - LOOKBACK); i < lastIdx; i++) {
        const c = closes[i], f = emaFastArr[i];
        if (c == null || f == null) continue;
        if (dir === "LONG"  && c <= f) return true;  // sempat turun ke/bawah EMA9
        if (dir === "SHORT" && c >= f) return true;  // sempat naik ke/atas EMA9
      }
      return false;
    };

    // AF-FIX-14: EMA9 slope — ensures the mean is moving with the trade direction.
    const ema9Prev    = emaFastArr[lastIdx - 1];
    const ema9Rising  = ema9Prev == null || emaFast > ema9Prev;
    const ema9Falling = ema9Prev == null || emaFast < ema9Prev;

    // AF-FIX-11: MACD histogram direction confirmation. When available, require MACD
    // histogram to agree with the trade direction — eliminates entries against momentum.
    // Knob-gated via config.bUseMacd (default true when set in preset).
    const useMacd   = config.bUseMacd ?? false;
    const macdHist  = config.macdHistogram ?? null;
    const macdLongOk  = !useMacd || macdHist == null || macdHist > 0;
    const macdShortOk = !useMacd || macdHist == null || macdHist < 0;

    // LONG: EMA9 > EMA21 > EMA50 + price > EMA21 + RSI band + EVENT segar + slope ↑ + MACD ↑
    if (
      emaFast > emaSlow &&
      (emaLong == null || emaSlow > emaLong) &&
      closeCurr > emaSlow &&
      rsi > rsiLongMin && rsi < rsiLongMax &&
      (hasFreshCross("LONG") || hasPullbackResume("LONG")) &&
      ema9Rising &&
      macdLongOk
    ) {
      return "LONG";
    }

    // SHORT: EMA9 < EMA21 < EMA50 + price < EMA21 + RSI band + EVENT segar + slope ↓ + MACD ↓
    if (
      emaFast < emaSlow &&
      (emaLong == null || emaSlow < emaLong) &&
      closeCurr < emaSlow &&
      rsi < rsiShortMax && rsi > rsiShortMin &&
      (hasFreshCross("SHORT") || hasPullbackResume("SHORT")) &&
      ema9Falling &&
      macdShortOk
    ) {
      return "SHORT";
    }

    return null;
  }

  // ── Component C — Swing Trading ───────────────────────────────────────────
  // Trend-following: price AND fast EMA on same side of slow EMA + RSI confirmation

  _detectSignalC(rsi, emaFast, emaSlow, closes) {
    if (emaFast == null || emaSlow == null) return null;

    const closeCurr = closes[closes.length - 1];

    // LONG: price above slow EMA + fast above slow (uptrend structure) + RSI healthy.
    // #BugC: range 35–75 terlalu lebar → fire nyaris setiap candle uptrend → noise tinggi.
    // Diperketat ke 45–65: cukup lebar untuk mid-trend tapi menghindari overbought/oversold.
    if (closeCurr > emaSlow && emaFast > emaSlow && rsi > 45 && rsi < 65) {
      return "LONG";
    }

    // SHORT: symmetric. Range 35–55 (sebelumnya 25–65 terlalu lebar).
    if (closeCurr < emaSlow && emaFast < emaSlow && rsi < 55 && rsi > 35) {
      return "SHORT";
    }

    return null;
  }

  // ── Component D — SMC (Smart Money Concepts) ─────────────────────────────
  // AF-FIX-12/13 (Sprint 8): institutional-level price zones.
  //
  // Theory:
  //   Fair Value Gap (FVG): 3-bar pattern with a price gap (imbalance zone). Price
  //   tends to "fill" the gap when it retraces, offering a high-probability entry.
  //     Bullish FVG: candle[i-2].high < candle[i].low  (gap UP — buy zone when filled)
  //     Bearish FVG: candle[i-2].low > candle[i].high  (gap DOWN — sell zone when filled)
  //
  //   Order Block (OB): the last candle of the opposite colour before an impulse move.
  //   Smart money leaves footprints here. When price returns to this zone it often
  //   reverses again, giving a second-chance entry.
  //     Bullish OB: last bearish candle before bullish impulse (buy zone on retrace)
  //     Bearish OB: last bullish candle before bearish impulse (sell zone on retrace)
  //
  //   EMA confirmation (not SMC-pure, added for filter): EMA9 vs EMA21 alignment
  //   ensures the OB/FVG is IN the direction of the macro trend, not counter-trend.

  /**
   * Detect Fair Value Gaps in the candle array.
   * Scans the last `lookback` bars.
   * @returns {{ bullish: Array<{top,bottom,idx}>, bearish: Array<{top,bottom,idx}> }}
   */
  _detectFVG(highs, lows, lastIdx, lookback = 20) {
    const bullish = [], bearish = [];
    const start = Math.max(2, lastIdx - lookback + 1);
    for (let i = start; i <= lastIdx - 1; i++) {
      const h2 = highs[i - 2], l_i = lows[i];   // gap UP: prev-prev high < current low
      if (h2 != null && l_i != null && l_i > h2) {
        bullish.push({ top: l_i, bottom: h2, idx: i });
      }
      const l2 = lows[i - 2], h_i = highs[i];   // gap DOWN: prev-prev low > current high
      if (l2 != null && h_i != null && h_i < l2) {
        bearish.push({ top: l2, bottom: h_i, idx: i });
      }
    }
    return { bullish, bearish };
  }

  /**
   * Detect Order Blocks — last candle before an impulse in the opposite direction.
   * Returns the MOST RECENT bullish and bearish OB within `lookback` bars.
   * @returns {{ bullish: {top,bottom,idx}|null, bearish: {top,bottom,idx}|null }}
   */
  _detectOrderBlocks(closes, highs, lows, lastIdx, lookback = 20) {
    let bullishOB = null, bearishOB = null;
    const start = Math.max(1, lastIdx - lookback);
    for (let i = start; i <= lastIdx - 2; i++) {
      const prevClose = closes[i - 1];
      if (prevClose == null || closes[i] == null || closes[i + 1] == null) continue;

      // Require the NEXT candle to be an impulse (body > 50% of its range)
      const nextRange = (highs[i + 1] ?? 0) - (lows[i + 1] ?? 0);
      const nextBody  = Math.abs(closes[i + 1] - closes[i]);
      if (nextRange <= 0 || nextBody / nextRange < 0.5) continue;

      // Bullish OB: this candle bearish (close < prevClose) + next candle bullish
      if (closes[i] < prevClose && closes[i + 1] > closes[i]) {
        bullishOB = { top: highs[i], bottom: lows[i], idx: i };
      }
      // Bearish OB: this candle bullish (close > prevClose) + next candle bearish
      if (closes[i] > prevClose && closes[i + 1] < closes[i]) {
        bearishOB = { top: highs[i], bottom: lows[i], idx: i };
      }
    }
    return { bullish: bullishOB, bearish: bearishOB };
  }

  /**
   * Component D — SMC signal.
   * Fires when the current bar retraces INTO a valid OB or FVG zone,
   * with EMA9/EMA21 confirming the macro direction.
   * @returns {"LONG"|"SHORT"|null}
   */
  _detectSignalD(closes, highs, lows, emaFast, emaSlow, lastIdx, config = {}) {
    if (!closes || !highs || !lows || lastIdx < 20) return null;
    if (emaFast == null || emaSlow == null) return null;

    const lookback = config.smcLookback ?? 20;
    const close = closes[lastIdx];
    const high  = highs[lastIdx];
    const low   = lows[lastIdx];
    if (close == null) return null;

    const fvg = this._detectFVG(highs, lows, lastIdx, lookback);
    const ob  = this._detectOrderBlocks(closes, highs, lows, lastIdx, lookback);

    // LONG: price retraces into a bullish FVG or bullish OB + EMA uptrend
    const inBullFVG = fvg.bullish.some(z => low <= z.top && close >= z.bottom);
    const inBullOB  = ob.bullish != null && low <= ob.bullish.top && close >= ob.bullish.bottom;
    if ((inBullFVG || inBullOB) && emaFast > emaSlow) return "LONG";

    // SHORT: price retraces into a bearish FVG or bearish OB + EMA downtrend
    const inBearFVG = fvg.bearish.some(z => high >= z.bottom && close <= z.top);
    const inBearOB  = ob.bearish != null && high >= ob.bearish.bottom && close <= ob.bearish.top;
    if ((inBearFVG || inBearOB) && emaFast < emaSlow) return "SHORT";

    return null;
  }

  // ── Conflict Resolution ───────────────────────────────────────────────────

  /**
   * Voting rules (default):
   *   3/3 agree → execute (highest confidence)
   *   2/3 agree → execute (high confidence)
   *   1/3      → skip (safety first)
   *
   * With votingThresholdOverride (PAIR-TIER-07 / v2.3):
   *   Require votes/total >= threshold fraction before executing.
   *   STABLE = 0.60 · SEMI_VOLATILE = 0.70 · VOLATILE = 0.78
   *   (VOLATILE 0.78 ⇒ butuh ~unanimitas — single dissent blocks entry)
   *
   * FEE-01b — Conviction guards (reversible via strat.*):
   *   - rejectOnDissent (default true): tolak entry bila komponen yang fire
   *     saling bertentangan (mis. 2 LONG vs 1 SHORT). Saat ini komponen jarang
   *     berkonflik (ketiganya bergantung pada alignment EMA9/EMA21 yang sama),
   *     jadi ini terutama safeguard bila logika komponen berevolusi.
   *   - minVotes (default 2): kuorum minimum komponen searah. Set
   *     `strat.afMinVotes=3` untuk menuntut unanimitas (entry paling selektif) —
   *     menekan over-trading di edge tipis (akar gross-negatif AF) tanpa
   *     mematikan strategi. Pengetatan utama AF berada di preset config
   *     (maxEntryExtensionATR lebih ketat + minEdgeFeeMultiple), divalidasi via
   *     FEE-06 dry-run sebelum promote.
   */
  _resolveSignalConflict(signals, votingThresholdOverride = null, opts = {}) {
    const { rejectOnDissent = true, minVotes = 2 } = opts;
    const votes = Object.values(signals).filter(Boolean);
    if (votes.length === 0) return null;

    const longs  = votes.filter(v => v === "LONG").length;
    const shorts = votes.filter(v => v === "SHORT").length;
    const total  = votes.length;

    if (rejectOnDissent && longs > 0 && shorts > 0) return null;

    if (votingThresholdOverride !== null) {
      if (longs / total  >= votingThresholdOverride) return "LONG";
      if (shorts / total >= votingThresholdOverride) return "SHORT";
      return null;
    }

    if (longs >= minVotes)  return "LONG";
    if (shorts >= minVotes) return "SHORT";
    return null;
  }

  // ── Risk & Timeframe Config ───────────────────────────────────────────────

  getRiskConfig() {
    return {
      // v3.0 (2026-06-28): recalibrated for 15m entry TF.
      riskPerTrade:        0.005,
      riskPerTradeStrong:  0.01,
      maxRiskPerTrade:     0.02,
      maxDailyLossPct:     0.035,
      maxTradesPerDay:     12,
      cooldownAfterLoss:   30,
      maxConsecLoss:       4,
      leverage:            2,
    };
  }

  getTimeframeConfig() {
    return {
      interval:      "15m",
      higherTf:      "1h",
      checkInterval: 900000,
    };
  }

  validateEntry(price, atr, volume, volSMA) {
    const atrPct  = (atr / price) * 100;
    const volRatio = volSMA > 0 ? volume / volSMA : 0;
    // v2.6: gate 1.2–3.5% selaras atrMinMult preset.
    if (atrPct < 1.2 || atrPct > 3.5) {
      return { valid: false, reason: `ATR ${atrPct.toFixed(2)}% outside healthy range (1.2–3.5%)` };
    }
    const volMin = this.config?.volSmaMultiplier ?? 2.0;
    if (volRatio < volMin * 0.4) {
      return { valid: false, reason: `Volume ${volRatio.toFixed(2)}× below threshold (${(volMin * 0.4).toFixed(1)}×)` };
    }
    return { valid: true, reason: "Entry conditions met" };
  }

  getSubStrategies()        { return this.SUB_STRATEGIES; }
  getSubStrategyConfig(key) { return this.SUB_STRATEGIES[key] || null; }
}

module.exports = AdaptiveFusionStrategy;
