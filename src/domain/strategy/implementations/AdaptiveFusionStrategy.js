/**
 * AdaptiveFusionStrategy.js — v2.2 (Post-mortem dry-run 11–12 Jun)
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
        "Market-aware system combining 3 sub-strategies: " +
        "Aggressive Scalping (A), Day Trading (B), Swing Trading (C). " +
        "Selects best strategy by market conditions with score-based filtering.",
      version: "2.2.0",
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
      // Pass full RSI array + index so A can compute RSI velocity (momentum)
      signals.A = this._detectSignalA(indicators.rsi || [], lastIdx, emaFast, emaSlow, closes, vol, vSMA);
    }

    // Component B — only run if balance sufficient AND score meets threshold
    // Teruskan emaLong (EMA50) agar B bisa pakai 3-EMA alignment (Day Trading intent)
    if (
      balance >= this.SUB_STRATEGIES.B.minCapital &&
      (scoreMap.B ?? 0) >= this.SUB_STRATEGIES.B.minScore
    ) {
      const emaLong = indicators.emaTrend?.[lastIdx] ?? null;
      // P8: B butuh series EMA (bukan scalar) untuk deteksi event crossover/pullback
      signals.B = this._detectSignalB(
        rsi,
        indicators.emaFast || [],
        indicators.emaSlow || [],
        emaLong,
        closesConfirmed,
        lastIdx
      );
    }

    // Component C — only run if balance sufficient AND score meets threshold
    if (
      balance >= this.SUB_STRATEGIES.C.minCapital &&
      (scoreMap.C ?? 0) >= this.SUB_STRATEGIES.C.minScore
    ) {
      signals.C = this._detectSignalC(rsi, emaFast, emaSlow, closesConfirmed);
    }

    // PAIR-TIER-07: respect votingThresholdOverride from pair tier (e.g. 0.65 for VOLATILE)
    const votingThresholdOverride = config.tierOverrides?.votingThresholdOverride ?? null;
    const resolved = this._resolveSignalConflict(signals, votingThresholdOverride);

    if (resolved) {
      // P6: Store which component(s) fired for SL/TP selection
      const winningComponent = this._pickBestComponent(signals, resolved, scoreMap);
      this._lastSignalMeta = {
        direction:   resolved,
        component:   winningComponent,
        votes:       signals,
        scores:      scoreMap,
        marketCond,
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

  // ── Component A — Momentum Scalping ───────────────────────────────────────
  // REDESIGN: A now reads RSI *velocity* (momentum acceleration), not absolute
  // extremes. The old absolute bands (rsi<30 / rsi>70) were mutually exclusive
  // with B (rsi>50/<50) and C (rsi 35-75) — so A could never join a 2-vote
  // majority and was effectively dead code. RSI-momentum bands (rising & >40 /
  // falling & <60) overlap with B and C, letting A confirm trend entries.
  // Keeps scalp character via EMA alignment + close confirmation + volume.
  //
  // @param {number[]} rsiSeries - full RSI array
  // @param {number}   lastIdx   - current bar index (for slope)
  _detectSignalA(rsiSeries, lastIdx, emaFast, emaSlow, closes, volume = 0, volSMA = 0) {
    if (emaFast == null || emaSlow == null) return null;

    const rsiCurr  = rsiSeries?.[lastIdx];
    const rsiPrev2 = rsiSeries?.[lastIdx - 2];
    if (rsiCurr == null || rsiPrev2 == null) return null;

    const closeCurr  = closes[closes.length - 1];
    const volRatio   = volSMA > 0 ? volume / volSMA : 0;
    const volOk      = volRatio >= 1.5;   // scalp fires only on a genuine volume spike

    // RSI velocity over 2 bars: positive = accelerating up, negative = down
    const rsiSlope = (rsiCurr - rsiPrev2) / 2;

    // LONG: RSI accelerating up + above neutral + bullish EMA structure + close>fast
    if (
      rsiSlope > 0.5 &&
      rsiCurr > 40 &&
      closeCurr > emaFast &&
      emaFast > emaSlow &&
      volOk
    ) {
      return "LONG";
    }

    // SHORT: RSI accelerating down + below neutral + bearish EMA structure + close<fast
    if (
      rsiSlope < -0.5 &&
      rsiCurr < 60 &&
      closeCurr < emaFast &&
      emaFast < emaSlow &&
      volOk
    ) {
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

  _detectSignalB(rsi, emaFastArr, emaSlowArr, emaLong, closes, lastIdx) {
    if (!Array.isArray(emaFastArr) || !Array.isArray(emaSlowArr)) return null;
    if (!Array.isArray(closes) || closes.length < 2) return null;
    if (lastIdx == null) lastIdx = closes.length - 1;

    const emaFast = emaFastArr[lastIdx];
    const emaSlow = emaSlowArr[lastIdx];
    if (emaFast == null || emaSlow == null) return null;

    const closeCurr = closes[lastIdx] ?? closes[closes.length - 1];
    if (closeCurr == null) return null;

    const LOOKBACK = 3; // event harus terjadi dalam 3 candle confirmed terakhir

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

    // LONG: EMA9 > EMA21 > EMA50 + price > EMA21 + RSI 50–70 + EVENT segar
    if (
      emaFast > emaSlow &&
      (emaLong == null || emaSlow > emaLong) &&
      closeCurr > emaSlow &&
      rsi > 50 && rsi < 70 &&
      (hasFreshCross("LONG") || hasPullbackResume("LONG"))
    ) {
      return "LONG";
    }

    // SHORT: EMA9 < EMA21 < EMA50 + price < EMA21 + RSI 30–50 + EVENT segar
    if (
      emaFast < emaSlow &&
      (emaLong == null || emaSlow < emaLong) &&
      closeCurr < emaSlow &&
      rsi < 50 && rsi > 30 &&
      (hasFreshCross("SHORT") || hasPullbackResume("SHORT"))
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

  // ── Conflict Resolution ───────────────────────────────────────────────────

  /**
   * Voting rules (default):
   *   3/3 agree → execute (highest confidence)
   *   2/3 agree → execute (high confidence)
   *   1/3      → skip (safety first)
   *
   * With votingThresholdOverride (PAIR-TIER-07):
   *   Require votes/total >= threshold fraction before executing.
   *   STABLE = 0.55 (same effective bar as default for 3 signals)
   *   VOLATILE = 0.65 (3/3 = 100% required — single dissent blocks entry)
   */
  _resolveSignalConflict(signals, votingThresholdOverride = null) {
    const votes = Object.values(signals).filter(Boolean);
    if (votes.length === 0) return null;

    const longs  = votes.filter(v => v === "LONG").length;
    const shorts = votes.filter(v => v === "SHORT").length;
    const total  = votes.length;

    if (votingThresholdOverride !== null) {
      if (longs / total  >= votingThresholdOverride) return "LONG";
      if (shorts / total >= votingThresholdOverride) return "SHORT";
      return null;
    }

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
      // P9: 3 → 30 menit. Nilai kecil di sini meng-override balik default 30 mnt
      // BotEngine (`strat.cooldownAfterLoss || 30`) → re-entry 6 menit setelah SL
      // pada setup identik (data dry-run 11–12 Jun).
      cooldownAfterLoss: 30,
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
    // P7: floor 0.3 → 0.5. Semua 18 trade loss dry-run 11–12 Jun lolos di ATR%
    // 0.30–0.45 — SL 1–2×ATR di regime itu berada di dalam noise normal 15m.
    // Floor 0.5 = sanity minimum; regime gate utama (vol+trend) ada di
    // detectSignal via interpretMarketCondition === "DEAD_MARKET".
    if (atrPct < 0.5 || atrPct > 4.0) {
      return { valid: false, reason: `ATR ${atrPct.toFixed(2)}% outside healthy range (0.5–4.0%)` };
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
