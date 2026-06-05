/**
 * AdaptiveFusionStrategy.js — v2.0 (Professional Trader Feedback)
 *
 * Fixes applied:
 *  P1 — calculateRiskConfig(): component-aware SL/TP multipliers
 *  P2 — _detectSignalB(): confirmed candle CLOSE cross, not wick
 *  P3 — _detectSignalA(): volume spike + close confirmation required
 *  P4 — detectSignal(): skip components with score below threshold
 *  P5 — getMarketThresholds() + interpretMarketCondition()
 *  P6 — component-level position guard (tracked via _lastSignalMeta)
 */

const StrategyBase = require("../base/StrategyBase");

class AdaptiveFusionStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "ADAPTIVE_FUSION",
      label: "Adaptive Fusion Strategy",
      description:
        "Market-aware system combining 3 sub-strategies: " +
        "Aggressive Scalping (A), Day Trading (B), Swing Trading (C). " +
        "Selects best strategy by market conditions with score-based filtering.",
      version: "2.0.0",
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
        // P1: SL = 2x ATR, TP = 3x ATR → RR 1:1.5
        slMultiplier: 2.0,
        tpMultiplier: 3.0,
        riskPerTrade: 0.01,
        maxTradesPerDay: 20,
        minCapital: 50,
        minScore: 30,         // P4: skip jika score < 30
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
        // P1: SL = 1.5x ATR, TP = 3x ATR → RR 1:2
        slMultiplier: 1.5,
        tpMultiplier: 3.0,
        riskPerTrade: 0.015,
        maxTradesPerDay: 8,
        minCapital: 20,
        minScore: 40,         // P4: skip jika score < 40
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
        // P1: SL = 1x ATR, TP = 2.5x ATR → RR 1:2.5
        slMultiplier: 1.0,
        tpMultiplier: 2.5,
        riskPerTrade: 0.015,
        maxTradesPerDay: 3,
        minCapital: 20,
        minScore: 35,         // P4: skip jika score < 35
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
  getMarketThresholds() {
    return {
      LOW_VOL:         1.0,    // ATR% < 1.0 → dead market
      NORMAL_VOL:      2.0,    // ATR% 1.0–2.0 → normal
      HIGH_VOL:        3.5,    // ATR% > 3.5 → high volatility
      WEAK_TREND:      0.3,    // < 0.3 → no real trend
      NORMAL_TREND:    0.6,    // 0.3–0.6 → emerging trend
      STRONG_TREND:    0.8,    // > 0.8 → clear trend
      COMP_A_MIN_SCORE: 30,
      COMP_B_MIN_SCORE: 40,
      COMP_C_MIN_SCORE: 35,
    };
  }

  /**
   * Classify market regime into one of four readable states.
   * @returns {"DEAD_MARKET"|"CHOPPY_VOLATILE"|"STRONG_TREND"|"NORMAL"}
   */
  interpretMarketCondition(volatility, trendStrength) {
    const t = this.getMarketThresholds();
    if (volatility <= t.LOW_VOL && trendStrength < t.WEAK_TREND) return "DEAD_MARKET";
    if (volatility > t.HIGH_VOL && trendStrength < t.WEAK_TREND) return "CHOPPY_VOLATILE";
    if (trendStrength > t.STRONG_TREND)                          return "STRONG_TREND";
    return "NORMAL";
  }

  // ── Ranking ───────────────────────────────────────────────────────────────

  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 1.0, trend_strength = 0.1 } = marketConditions;
    const t = this.getMarketThresholds();

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
   * Component A (Scalp): SL 2× ATR, TP 3× ATR  → RR 1:1.5
   * Component B (Day):   SL 1.5× ATR, TP 3× ATR → RR 1:2
   * Component C (Swing): SL 1× ATR, TP 2.5× ATR → RR 1:2.5
   *
   * Acceptance criteria:
   *   LONG  entry 100 ATR 2 Component B → SL 97, TP 106
   *   SHORT entry 100 ATR 2 Component B → SL 103, TP 94
   */
  calculateRiskConfig(entryPrice, atr, signal, component = "B") {
    const sub = this.SUB_STRATEGIES[component] || this.SUB_STRATEGIES.B;
    const slDist = atr * sub.slMultiplier;
    const tpDist = atr * sub.tpMultiplier;

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
      tpMultiplier: sub.tpMultiplier,
      slDistance:  slDist,
      tpDistance:  tpDist,
      component,
    };
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

    // P4: Get scores and filter out low-scoring components
    const marketConditions = {
      volatility:      config.volatility      || 1.0,
      trend_strength:  config.trend_strength  || 0.1,
    };
    const rankings  = this.rankByMarketConditions(marketConditions);
    const scoreMap  = Object.fromEntries(rankings.map(r => [r.key, r.score]));

    const signals = {};

    // Component A — only run if balance sufficient AND score meets threshold
    if (
      balance >= this.SUB_STRATEGIES.A.minCapital &&
      (scoreMap.A ?? 0) >= this.SUB_STRATEGIES.A.minScore
    ) {
      const vol    = volumes[lastIdx] ?? 0;
      const vSMA   = volSMA[lastIdx]  ?? 0;
      signals.A = this._detectSignalA(rsi, emaFast, emaSlow, closes, vol, vSMA);
    }

    // Component B — only run if balance sufficient AND score meets threshold
    if (
      balance >= this.SUB_STRATEGIES.B.minCapital &&
      (scoreMap.B ?? 0) >= this.SUB_STRATEGIES.B.minScore
    ) {
      signals.B = this._detectSignalB(rsi, emaFast, emaSlow, closes);
    }

    // Component C — only run if balance sufficient AND score meets threshold
    if (
      balance >= this.SUB_STRATEGIES.C.minCapital &&
      (scoreMap.C ?? 0) >= this.SUB_STRATEGIES.C.minScore
    ) {
      signals.C = this._detectSignalC(rsi, emaFast, emaSlow, closes);
    }

    const resolved = this._resolveSignalConflict(signals);

    if (resolved) {
      // P6: Store which component(s) fired for SL/TP selection
      const winningComponent = this._pickBestComponent(signals, resolved, scoreMap);
      this._lastSignalMeta = {
        direction:   resolved,
        component:   winningComponent,
        votes:       signals,
        scores:      scoreMap,
        marketCond:  this.interpretMarketCondition(
          marketConditions.volatility,
          marketConditions.trend_strength
        ),
      };
    }

    return resolved;
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
   * Expose last signal metadata for SL/TP calculation by BotEngine.
   * BotEngine should call this immediately after detectSignal() returns non-null.
   */
  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  // ── P3: Component A — Scalping ────────────────────────────────────────────
  // Requires: RSI oversold/overbought + EMA alignment + volume spike + close confirm

  _detectSignalA(rsi, emaFast, emaSlow, closes, volume = 0, volSMA = 0) {
    if (rsi == null || emaFast == null || emaSlow == null) return null;

    const closeCurr  = closes[closes.length - 1];
    const volRatio   = volSMA > 0 ? volume / volSMA : 0;
    const volSpike   = volRatio >= 1.5;   // require 1.5× volume spike

    // LONG: RSI oversold + close above fast EMA + fast above slow (uptrend) + volume spike
    if (
      rsi < 30 &&
      closeCurr > emaFast &&
      emaFast > emaSlow &&
      volSpike
    ) {
      return "LONG";
    }

    // SHORT: RSI overbought + close below fast EMA + fast below slow (downtrend) + volume spike
    if (
      rsi > 70 &&
      closeCurr < emaFast &&
      emaFast < emaSlow &&
      volSpike
    ) {
      return "SHORT";
    }

    return null;
  }

  // ── P2: Component B — Day Trading ─────────────────────────────────────────
  // Confirmed CANDLE CLOSE cross over EMA, not wick touch.
  // Previous close must be on the opposite side of EMA to current close.

  _detectSignalB(rsi, emaFast, emaSlow, closes) {
    if (emaFast == null || emaSlow == null || closes.length < 2) return null;

    const closeCurr = closes[closes.length - 1];   // confirmed current close
    const closePrev = closes[closes.length - 2];   // previous candle close

    // LONG: previous close ≤ emaSlow, current close > emaSlow (confirmed bullish cross)
    //       + RSI > 50 on current candle (trend confirmation)
    if (closePrev <= emaSlow && closeCurr > emaSlow && rsi > 50) {
      return "LONG";
    }

    // SHORT: previous close ≥ emaSlow, current close < emaSlow (confirmed bearish cross)
    //        + RSI < 50 on current candle
    if (closePrev >= emaSlow && closeCurr < emaSlow && rsi < 50) {
      return "SHORT";
    }

    return null;
  }

  // ── Component C — Swing Trading ───────────────────────────────────────────
  // Trend-following: price AND fast EMA on same side of slow EMA + RSI confirmation

  _detectSignalC(rsi, emaFast, emaSlow, closes) {
    if (emaFast == null || emaSlow == null) return null;

    const closeCurr = closes[closes.length - 1];

    // LONG: price above slow EMA + fast above slow (uptrend structure) + RSI in healthy zone
    // 35–75: wider than original 40–70 to catch more mid-trend entries, still avoids extremes
    if (closeCurr > emaSlow && emaFast > emaSlow && rsi > 35 && rsi < 75) {
      return "LONG";
    }

    // SHORT: price below slow EMA + fast below slow (downtrend) + RSI in healthy zone
    // 25–65: symmetric adjustment (was 30–60)
    if (closeCurr < emaSlow && emaFast < emaSlow && rsi < 65 && rsi > 25) {
      return "SHORT";
    }

    return null;
  }

  // ── Conflict Resolution ───────────────────────────────────────────────────

  /**
   * Voting rules:
   *   3/3 agree → execute (highest confidence)
   *   2/3 agree → execute (high confidence)
   *   1/3      → skip (safety first)
   */
  _resolveSignalConflict(signals) {
    const votes = Object.values(signals).filter(Boolean);
    if (votes.length === 0) return null;

    const longs  = votes.filter(v => v === "LONG").length;
    const shorts = votes.filter(v => v === "SHORT").length;

    if (longs >= 2)  return "LONG";
    if (shorts >= 2) return "SHORT";
    return null;
  }

  // ── Risk & Timeframe Config ───────────────────────────────────────────────

  getRiskConfig() {
    return {
      riskPerTrade:      0.015,
      maxRiskPerTrade:   0.02,
      maxDailyLossPct:   0.05,
      maxTradesPerDay:   10,
      cooldownAfterLoss: 3,
      maxConsecLoss:     4,
      leverage:          2,
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
    if (atrPct < 0.3 || atrPct > 4.0) {
      return { valid: false, reason: `ATR ${atrPct.toFixed(2)}% outside healthy range (0.3–4.0%)` };
    }
    if (volRatio < 0.7) {
      return { valid: false, reason: `Volume ${volRatio.toFixed(2)}× below threshold (0.7×)` };
    }
    return { valid: true, reason: "Entry conditions met" };
  }

  getSubStrategies()        { return this.SUB_STRATEGIES; }
  getSubStrategyConfig(key) { return this.SUB_STRATEGIES[key] || null; }
}

module.exports = AdaptiveFusionStrategy;
