/**
 * AdaptiveFusionStrategy.js — v2.5 (High Win-Rate & Risk Control — STRATEGIES.md §4)
 *
 * v2.5 spec changes:
 *  - Sub SL/TP/minScore: A 2.2/3.3/38, B 1.6/3.4/45, C 1.2/3.0/42.
 *  - RSI B bands: LONG 58–68, SHORT 32–42.
 *  - validateEntry ATR gate 1.0–3.5%; volSmaMultiplier 1.8 on Component A.
 *  - strongTrendTPMult ×1.6 on STRONG_TREND; maxEntryExtensionATR 0.8.
 *  - riskPerTrade 0.007, maxDailyLoss 3.5%, cooldown 60, htfTrendStrengthMin 0.72.
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
        "Market-aware system combining 3 sub-strategies: " +
        "Aggressive Scalping (A), Day Trading (B), Swing Trading (C). " +
        "Selects best strategy by market conditions with score-based filtering.",
      version: "2.5.0",
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
        // v2.5: SL = 1.6× ATR, TP = 3.4× ATR → RR 1:2.1
        slMultiplier: 1.6,
        tpMultiplier: 3.4,
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
        // v2.5: SL = 1.2× ATR, TP = 3.0× ATR → RR 1:2.5
        slMultiplier: 1.2,
        tpMultiplier: 3.0,
        riskPerTrade: 0.015,
        maxTradesPerDay: 3,
        minCapital: 20,
        minScore: 42,
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
      // v2.5 spec (STRATEGIES.md §4): LOW_VOL 1.4, WEAK_TREND 0.55, STRONG_TREND 0.82.
      LOW_VOL:         1.4,
      NORMAL_VOL:      2.0,
      HIGH_VOL:        3.5,
      WEAK_TREND:      0.55,
      NORMAL_TREND:    0.65,
      STRONG_TREND:    0.82,
      COMP_A_MIN_SCORE: 38,
      COMP_B_MIN_SCORE: 45,
      COMP_C_MIN_SCORE: 42,
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

    // Component A — only run if balance sufficient AND score meets threshold
    if (
      balance >= this.SUB_STRATEGIES.A.minCapital &&
      (scoreMap.A ?? 0) >= this.SUB_STRATEGIES.A.minScore
    ) {
      const vol    = volumes[lastIdx] ?? 0;
      const vSMA   = volSMA[lastIdx]  ?? 0;
      // Pass full RSI array + index so A can compute RSI velocity (momentum)
      signals.A = this._detectSignalA(
        indicators.rsi || [], lastIdx, emaFast, emaSlow, closes, vol, vSMA,
        config.volSmaMultiplier ?? 1.8
      );
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
        lastIdx,
        config
      );
    }

    // Component C — only run if balance sufficient AND score meets threshold
    if (
      balance >= this.SUB_STRATEGIES.C.minCapital &&
      (scoreMap.C ?? 0) >= this.SUB_STRATEGIES.C.minScore
    ) {
      signals.C = this._detectSignalC(rsi, emaFast, emaSlow, closesConfirmed);
    }

    // PAIR-TIER-07 / v2.3: respect votingThresholdOverride from pair tier
    // (STABLE 0.60, SEMI_VOLATILE 0.70, VOLATILE 0.78 — lihat PairClassifier).
    const votingThresholdOverride = config.tierOverrides?.votingThresholdOverride ?? null;
    let resolved = this._resolveSignalConflict(signals, votingThresholdOverride, {
      rejectOnDissent: config.afRejectOnDissent ?? true,
      // v2.3 spec (STRATEGIES.md §4): afMinVotes default 2 → 3 (konsensus lebih kuat).
      minVotes:        config.afMinVotes ?? 3,
    });

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
      const maxExt = config.maxEntryExtensionATR ?? 0.8;
      if (
        closeConfirmed != null && emaFast != null && atr > 0 &&
        Math.abs(closeConfirmed - emaFast) / atr > maxExt
      ) {
        const ext = (Math.abs(closeConfirmed - emaFast) / atr).toFixed(2);
        this._lastChaseReject = { signal: resolved, extension: ext, maxExt };
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
        marketCond,
        htfTrend,
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
  _detectSignalA(rsiSeries, lastIdx, emaFast, emaSlow, closes, volume = 0, volSMA = 0, volMult = 1.8) {
    if (emaFast == null || emaSlow == null) return null;

    const rsiCurr  = rsiSeries?.[lastIdx];
    const rsiPrev2 = rsiSeries?.[lastIdx - 2];
    if (rsiCurr == null || rsiPrev2 == null) return null;

    const closeCurr  = closes[closes.length - 1];
    const volRatio   = volSMA > 0 ? volume / volSMA : 0;
    const volOk      = volRatio >= volMult;

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

  _detectSignalB(rsi, emaFastArr, emaSlowArr, emaLong, closes, lastIdx, config = {}) {
    if (!Array.isArray(emaFastArr) || !Array.isArray(emaSlowArr)) return null;
    if (!Array.isArray(closes) || closes.length < 2) return null;
    if (lastIdx == null) lastIdx = closes.length - 1;

    const rsiLongMin  = config.rsiLongMin  ?? 58;
    const rsiLongMax  = config.rsiLongMax  ?? 68;
    const rsiShortMin = config.rsiShortMin ?? 32;
    const rsiShortMax = config.rsiShortMax ?? 42;

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

    // LONG: EMA9 > EMA21 > EMA50 + price > EMA21 + RSI band + EVENT segar
    if (
      emaFast > emaSlow &&
      (emaLong == null || emaSlow > emaLong) &&
      closeCurr > emaSlow &&
      rsi > rsiLongMin && rsi < rsiLongMax &&
      (hasFreshCross("LONG") || hasPullbackResume("LONG"))
    ) {
      return "LONG";
    }

    // SHORT: EMA9 < EMA21 < EMA50 + price < EMA21 + RSI band + EVENT segar
    if (
      emaFast < emaSlow &&
      (emaLong == null || emaSlow < emaLong) &&
      closeCurr < emaSlow &&
      rsi < rsiShortMax && rsi > rsiShortMin &&
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
      // v2.5 spec (STRATEGIES.md §4): risk 0.7%, max 8 trade/hari, cooldown 60 mnt.
      riskPerTrade:      0.007,
      maxRiskPerTrade:   0.02,
      maxDailyLossPct:   0.035,
      maxTradesPerDay:   8,
      cooldownAfterLoss: 60,
      maxConsecLoss:     2,
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
    // v2.5: gate 1.0–3.5% selaras atrMinMult/atrMaxMult preset.
    if (atrPct < 1.0 || atrPct > 3.5) {
      return { valid: false, reason: `ATR ${atrPct.toFixed(2)}% outside healthy range (1.0–3.5%)` };
    }
    const volMin = this.config?.volSmaMultiplier ?? 1.8;
    if (volRatio < volMin * 0.4) {
      return { valid: false, reason: `Volume ${volRatio.toFixed(2)}× below threshold (${(volMin * 0.4).toFixed(1)}×)` };
    }
    return { valid: true, reason: "Entry conditions met" };
  }

  getSubStrategies()        { return this.SUB_STRATEGIES; }
  getSubStrategyConfig(key) { return this.SUB_STRATEGIES[key] || null; }
}

module.exports = AdaptiveFusionStrategy;
