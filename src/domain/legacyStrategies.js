// ─────────────────────────────────────────────
// legacyStrategies.js — Kumpulan Strategi Trading (legacy A/B/C)
//
// Berdasarkan: "Dokumentasi Panduan Strategi Trading"
//   Aggressive Scalping, Day Trading, dan Swing Trading
//
// Alur eksekusi per strategi:
//   1. HTF trend filter  → Bullish / Bearish / Sideways
//   2. Volume filter     → volume > volSMA × threshold
//   3. ATR filter        → ATR min/max agar TP realistis
//   4. Entry signal      → EMA + RSI + candle confirm
//   5. Risk management   → dailyLoss, maxTradesDay, cooldown
//   6. Kirim order
//
// Switch strategi via .env:
//   STRATEGY=A  → Aggressive Scalping  (HTF:15m, Entry:1m)
//   STRATEGY=B  → Day Trading          (HTF:1H,  Entry:15m)
//   STRATEGY=C  → Swing Trading        (HTF:1D,  Entry:4H)
// ─────────────────────────────────────────────

const STRATEGIES = {

  // ─────────────────────────────────────────────
  // STRATEGI A — Aggressive Scalping
  //
  //   HTF Trend Filter : 15m (EMA9/21 + close vs EMA)
  //   Entry TF         : 1m (default)
  //   EMA              : 9 / 21
  //   RSI              : 7 | Long >50, Short <50
  //   Volume           : Wajib di atas rata-rata
  //   SL               : 0.5x ATR | TP: 1x ATR (RR 1:2)
  //   Risk/trade       : 0.5%–1%
  // ─────────────────────────────────────────────
  A: {
    name:          "A",
    label:         "Aggressive Scalping",
    description:   "EMA9/21 + RSI zona momentum + volume spike. Frekuensi tinggi, cocok market volatile",

    // EMA entry
    emaFast:       9,
    emaSlow:       21,
    emaTrend:      0,          // Tidak pakai EMA trend di entry TF (pakai HTF saja)

    // RSI
    rsiPeriod:     7,
    rsiOverbought: 70,
    rsiOversold:   30,
    rsiLongMin:    50,         // Long: RSI di zona momentum bullish
    rsiLongMax:    70,
    rsiShortMin:   30,
    rsiShortMax:   50,

    // ATR
    atrPeriod:     14,
    atrMultiplier: 0.5,        // SL = 0.5x ATR
    riskReward:    2,          // TP = 2x SL = 1.0x ATR
    atrMinMult:    0.3,        // ATR minimum = 0.3x price% (market tidak terlalu sepi)
    atrMaxMult:    3.0,        // ATR maximum = 3.0x price% (market tidak terlalu liar)

    // HTF trend filter
    higherTf:      "15m",      // Higher timeframe untuk filter trend
    htfEmaFast:    9,          // EMA HTF untuk deteksi trend
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.15, // EMA spread < 0.15% = sideways → no trade

    // Volume
    volSmaMultiplier: 1.0,     // Volume harus >= 1.0x vol SMA

    // Risk management
    riskPerTrade:     0.01,    // 1% per trade
    maxDailyLossPct:  0.03,    // Stop trading jika loss harian >= 3%
    maxTradesPerDay:  20,       // Maks 20 trade/hari (scalping frekuensi tinggi)
    cooldownAfterLoss: 2,       // Cooldown 2 menit setelah loss
    maxConsecLoss:    3,        // Stop trading jika 3 loss berturut-turut

    leverage:      3,
    interval:      "1m",
    checkInterval: 30000,

    signalType:    "PDF_SCALPING",

    // Info UI
    trades:        "5-20 trade/hari",
    winrate:       "~45-55%",
    risk:          "Tinggi",
  },

  // ─────────────────────────────────────────────
  // STRATEGI B — Day Trading ⭐ RECOMMENDED
  //
  //   HTF Trend Filter : 1H (EMA9/21 + close vs EMA50)
  //   Entry TF         : 15m (default)
  //   EMA              : 9 / 21 + EMA50 trend filter
  //   RSI              : 14 | Long 50-70, Short 30-50
  //   Volume           : Wajib di atas rata-rata
  //   SL               : 1x ATR | TP: 1.5–3x ATR (RR 1:2)
  //   Risk/trade       : 1%–2%
  // ─────────────────────────────────────────────
  B: {
    name:          "B",
    label:         "Day Trading",
    description:   "EMA9/21 + filter EMA50 + RSI 50-70 + volume. Balanced frekuensi & akurasi",

    emaFast:       9,
    emaSlow:       21,
    emaTrend:      50,         // Filter trend entry: price harus di atas/bawah EMA50

    rsiPeriod:     14,
    rsiOverbought: 70,
    rsiOversold:   30,
    rsiLongMin:    50,
    rsiLongMax:    70,
    rsiShortMin:   30,
    rsiShortMax:   50,

    atrPeriod:     14,
    atrMultiplier: 1.0,        // SL = 1x ATR
    riskReward:    2,          // TP = 2x ATR
    atrMinMult:    0.2,
    atrMaxMult:    4.0,

    // HTF trend filter
    higherTf:      "1h",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.2,

    // Sideways breakout mode (aktif saat HTF = SIDEWAYS)
    sidewaysRangeLookback:   20,    // Jumlah candle HTF untuk range konsolidasi
    sidewaysBreakoutVolMult: 1.2,   // Volume min = 1.2× SMA saat breakout
    sidewaysBreakoutBufMult: 0.3,   // Buffer tepi range = ATR × 0.3

    volSmaMultiplier: 1.0,

    riskPerTrade:     0.015,
    maxDailyLossPct:  0.04,    // Stop jika loss harian >= 4%
    maxTradesPerDay:  8,
    cooldownAfterLoss: 5,       // Cooldown 5 menit
    maxConsecLoss:    3,

    leverage:      3,
    interval:      "15m",
    checkInterval: 60000,

    signalType:    "PDF_DAYTRADING",

    trades:        "3-8 trade/hari",
    winrate:       "~55-65%",
    risk:          "Sedang",
  },

  // ─────────────────────────────────────────────
  // STRATEGI C — Swing Trading
  //
  //   HTF Trend Filter : 1D (close vs EMA200)
  //   Entry TF         : 4H
  //   EMA              : 21 / 50 + EMA200 trend filter
  //   RSI              : 14 | Sesuai pullback trend (40-60)
  //   Volume           : Wajib di atas rata-rata
  //   SL               : 1.5x ATR | TP: 4.5x ATR (RR 1:3)
  //   Risk/trade       : 1%–2%
  // ─────────────────────────────────────────────
  C: {
    name:          "C",
    label:         "Swing Trading",
    description:   "EMA21/50/200 + pullback ke EMA + RSI 40-60. Trade sedikit tapi momentum kuat",

    emaFast:       21,
    emaSlow:       50,
    emaTrend:      200,        // Filter tren besar di entry TF (4H)

    rsiPeriod:     14,
    rsiOverbought: 60,
    rsiOversold:   40,
    rsiLongMin:    40,
    rsiLongMax:    60,
    rsiShortMin:   40,
    rsiShortMax:   60,

    atrPeriod:     14,
    atrMultiplier: 1.5,        // SL = 1.5x ATR
    riskReward:    3,          // TP = 4.5x ATR (RR 1:3)
    atrMinMult:    0.1,
    atrMaxMult:    6.0,

    // HTF trend filter
    higherTf:      "1d",
    htfEmaFast:    21,
    htfEmaSlow:    50,
    sidewaysThresholdPct: 0.3, // Swing lebih toleran sideways (EMA spread < 0.3%)

    // Sideways retest mode (aktif saat HTF = SIDEWAYS)
    sidewaysRangeLookback:   20,    // Candle daily untuk range konsolidasi
    sidewaysBreakoutVolMult: 1.2,   // Volume breakout lebih ketat
    sidewaysBreakoutBufMult: 0.3,   // Buffer = ATR × 0.3

    volSmaMultiplier: 0.8,     // Swing: volume sedikit lebih longgar

    riskPerTrade:     0.015,
    maxDailyLossPct:  0.05,    // Swing tahan floating lebih besar
    maxTradesPerDay:  3,
    cooldownAfterLoss: 60,      // Cooldown 1 jam setelah loss swing
    maxConsecLoss:    2,        // Stop setelah 2 loss berturut

    leverage:      2,
    interval:      "4h",
    checkInterval: 300000,

    signalType:    "PDF_SWING",

    trades:        "1-5 trade/minggu",
    winrate:       "~65-75%",
    risk:          "Rendah-Sedang",
  },

  // ─────────────────────────────────────────────
  // ADAPTIVE_FUSION — Multi-Component Strategy (v2.6)
  //
  //   v2.6 spec (STRATEGIES.md §4): selective & high probability — kurangi false positive.
  // ─────────────────────────────────────────────
  ADAPTIVE_FUSION: {
    name:          "ADAPTIVE_FUSION",
    label:         "Adaptive Fusion",
    description:   "3-component voting system (Scalp+Day+Swing). Adapts SL/TP to winning component.",

    emaFast:       9,
    emaSlow:       21,
    emaTrend:      50,

    // AF-FIX-14: RSI period 14→21 reduces sideways noise (Grok analysis recommendation)
    rsiPeriod:     21,
    rsiOverbought: 72,
    rsiOversold:   28,
    // AF-FIX-17: Widen Component B RSI bands (was 60-68/32-40 — too narrow, rarely satisfied
    // simultaneously with pullback event + EMA alignment + MACD on 1h TF → near-zero B trades)
    rsiLongMin:    55,
    rsiLongMax:    75,
    rsiShortMin:   25,
    rsiShortMax:   45,

    atrPeriod:     14,
    atrMultiplier: 1.4,
    // AF-FIX-14: RR 2.5→1.8 (more realistic targets on 1h TF; avoids TP never hit)
    riskReward:    1.8,
    atrMinMult:    1.2,
    atrMaxMult:    3.5,

    higherTf:      "4h",        // v3.3: changed from 1h → 4h (proper swing context)
    htfEmaFast:    9,
    htfEmaSlow:    21,
    htfTrendStrengthMin: 0.25, // v3.3: lowered from 0.75; backtest was always null → gate blocked all BULLISH/BEARISH entries
    sidewaysThresholdPct: 0.2,

    sidewaysRangeLookback:   20,
    sidewaysBreakoutVolMult: 1.5,
    sidewaysBreakoutBufMult: 0.3,

    volSmaMultiplier: 1.3,

    // v2.6: risk 0.5% default; 1% saat STRONG_TREND (riskPerTradeStrong).
    riskPerTrade:        0.005,
    riskPerTradeStrong:  0.01,
    maxDailyLossPct:     0.035,
    maxTradesPerDay:     6,
    cooldownAfterLoss:   90,
    maxConsecLoss:       2,

    // AF-FIX-17: Relaxed from 0.7 (too tight — blocked valid pullback-to-EMA entries on 1h TF)
    maxEntryExtensionATR: 1.2,
    minEdgeFeeMultiple:   7,
    strongTrendTPMult:    1.8,
    // afMinVotes retained for legacy single-position path; multi-position ignores it
    afMinVotes:           3,
    afRejectOnDissent:    true,
    // ── Sprint 7 (AF-FIX, 2026-06-29): confidence-gated multi-component ──────────
    // v3.2 disabled A/B (C-only) because, UNGATED, their EMA-crossover designs
    // bled on real 15m chop (A PF 0.31, B PF 0.41). AF-FIX-01/02 adds a 0–100
    // conviction score per component + a ≥60 entry gate, so A/B now fire ONLY on
    // high-confidence setups. All three components are re-enabled behind the gate
    // ("semua komponen berjalan dengan normal"); the gate removes the low-quality
    // fires that were the source of the bleed. NOTE: promote to live only after
    // the Quant apple-to-apple backtest gate (AF-FIX-06/07/08) confirms the edge.
    // AF-FIX-12/13 (Sprint 8): Component D (SMC) added — enable all 4 components.
    afEnabledComponents:  ["A", "B", "C", "D"],
    // AF-FIX-02: a component may vote/fire only if its confidence ≥ this.
    afMinComponentConfidence: 60,
    // AF-FIX-03: resolved entry rejected unless mean confidence of agreeing
    // components ≥ this (blocks weak reversal/"Signal" entries that only pay fees).
    afMinAggregateConfidence: 60,
    // SMC Component D lookback (bars to scan for OB/FVG zones)
    smcLookback: 20,
    // OA-FIX-02: Order Flow Component A knobs
    // vwapLookback: rolling window for CVD + VWAP computation (bars)
    vwapLookback: 14,
    // ofDeltaThreshold: min bar delta for LONG entry (≥0.55 = close in top 45% of bar range).
    // 0.55 is calibrated for 1h TF; 0.60 was designed for <5m scalping and produced 0 trades/year on 1h.
    ofDeltaThreshold: 0.55,

    // AF-FIX-11: MACD histogram alignment required for Component B (trend direction confirmation)
    bUseMacd:      true,
    // AF-FIX-04: net-edge filter — skip entry when ATR/price < k × feePct
    netEdgeK:      2.0,   // need 2× fee as minimum expected move
    feePct:        0.0012, // 0.12% roundtrip (taker both legs)

    leverage:      2,
    interval:      "1h",        // v3.3: changed from 15m → 1h (pullback-to-EMA needs proper swing TF)
    checkInterval: 60000,

    grokConfirmMinEntry: 8,
    grokConfirmMinTp:    7,

    signalType:    "ADAPTIVE_FUSION",

    trades:        "2-6 trade/hari",
    winrate:       "~48-52% (v2.6 target)",
    risk:          "Rendah–Sedang",
  },

  // ─────────────────────────────────────────────
  // TREND_MOMENTUM — Multi-TF Momentum (MINT Tier)
  //
  //   HTF: 1H (EMA trend)
  //   MTF: 15m (MACD + RSI momentum)
  //   Entry: 5m (EMA + RSI + volume confirmation)
  //   v2.3: SL 1.3x ATR | TP 2.5x ATR (RR ~1:1.92) | Risk 1.2% | Max 4 trade/hari
  //   Target: 54-58% WR, 100-180% annual
  // ─────────────────────────────────────────────
  TREND_MOMENTUM: {
    name:          "TREND_MOMENTUM",
    label:         "Trend Momentum",
    description:   "Multi-TF MACD + RSI momentum. 3-layer confirmation (HTF/MTF/Entry).",

    emaFast:       9,
    emaSlow:       21,
    emaTrend:      50,

    rsiPeriod:     14,
    rsiOverbought: 70,
    rsiOversold:   30,
    rsiLongMin:    35,
    rsiLongMax:    75,
    rsiShortMin:   25,
    rsiShortMax:   65,

    atrPeriod:     14,
    atrMultiplier: 1.3,        // v2.3: SL = 1.3x ATR (dari 1.2)
    riskReward:    1.92,       // TP = 1.92×1.3 ≈ 2.5x ATR (v2.3)
    atrMinMult:    0.5,
    atrMaxMult:    8.0,

    // HTF trend filter
    higherTf:      "1h",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.25,

    volSmaMultiplier: 1.0,

    riskPerTrade:     0.012,   // v2.3: 1.2% per trade (dari 2%)
    maxDailyLossPct:  0.06,
    maxTradesPerDay:  4,       // v2.3: 4 trade/hari (dari 10)
    cooldownAfterLoss: 5,
    maxConsecLoss:    3,

    // FEE-04: biarkan winner lari. Profit gross +$38 tertelan fee $45 (net −$7)
    // karena TP penuh dipukul rata di ~1.9R. Mode "partial" mengunci 40% di +1R
    // & 27.5% di +2R lalu menggeser SL ke BEP/+1R sembari sisanya lari ke TP
    // penuh — menaikkan ekspektasi net-of-fee tanpa menaikkan risiko. Knob:
    // set tpMode:"full" untuk perilaku lama.
    tpMode:        "partial",

    leverage:      2,
    interval:      "5m",
    checkInterval: 60000,

    grokConfirmMinEntry: 7,
    grokConfirmMinTp:    7,

    signalType:    "TREND_MOMENTUM",

    trades:        "8-15 trade/hari",
    winrate:       "~54-58%",
    risk:          "Sedang",
  },

  // ─────────────────────────────────────────────
  // MEAN_REVERSION — BB Extremes (VAULT Tier)
  //
  //   BB: 20 period, 2σ deviation
  //   RSI: 14 period (oversold <25, overbought >75)
  //   Entry: Price touch band + RSI confirmation + 2-bar validate
  //   v2.3: SL 1.4x ATR | TP 3.2x ATR (RR ~1:2.3) | Risk 0.8% per trade
  //   Target: 55-60% WR, 100-150% annual
  // ─────────────────────────────────────────────
  MEAN_REVERSION: {
    name:          "MEAN_REVERSION",
    label:         "Mean Reversion",
    description:   "Bollinger Bands extremes + RSI. Ultra-selective, ultra-conservative (VAULT).",

    emaFast:       9,
    emaSlow:       21,
    emaTrend:      50,

    rsiPeriod:     14,
    rsiOverbought: 75,
    rsiOversold:   25,
    rsiLongMin:    15,
    rsiLongMax:    25,
    rsiShortMin:   75,
    rsiShortMax:   85,

    atrPeriod:     14,
    atrMultiplier: 1.4,        // v2.3: SL = 1.4x ATR (dari 1.0)
    riskReward:    2.29,       // TP = 1.4×2.29 ≈ 3.2x ATR → RR ~1:2.3 (v2.3)
    atrMinMult:    0.5,
    atrMaxMult:    6.0,

    higherTf:      "15m",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.3,

    volSmaMultiplier: 0.8,

    riskPerTrade:     0.008,   // v2.3: 0.8% ultra-conservative (dari 1%)
    maxDailyLossPct:  0.03,
    maxTradesPerDay:  3,
    cooldownAfterLoss: 15,
    maxConsecLoss:    2,

    leverage:      1.0,        // No leverage
    interval:      "15m",
    checkInterval: 60000,

    grokConfirmMinEntry: 8,
    grokConfirmMinTp:    7,

    signalType:    "MEAN_REVERSION",

    trades:        "5-15 trade/minggu",
    winrate:       "~55-60%",
    risk:          "Rendah",
  },

  // ─────────────────────────────────────────────
  // BREAKOUT_RETEST — Breakout + Retest (VAULT Tier)
  //
  //   Entry TF  : 15m — deteksi level S&R 20-bar, breakout + retest
  //   v2.3: SL 1.4× ATR | TP 5.5× ATR (RR ~1:4) | Risk 2% | Max 5 trade/hari
  // ─────────────────────────────────────────────
  BREAKOUT_RETEST: {
    name:          "BREAKOUT_RETEST",
    label:         "Breakout + Retest",
    description:   "Breakout level S&R dengan konfirmasi retest. RR 1:4, cocok market konsolidasi.",

    emaFast:       9,
    emaSlow:       21,
    emaTrend:      50,

    rsiPeriod:     14,
    rsiOverbought: 70,
    rsiOversold:   30,
    rsiLongMin:    40,
    rsiLongMax:    70,
    rsiShortMin:   30,
    rsiShortMax:   60,

    atrPeriod:     14,
    atrMultiplier: 1.4,        // v2.3: SL = 1.4× ATR (dari 1.5)
    riskReward:    3.93,       // TP = 1.4×3.93 ≈ 5.5× ATR → RR ~1:4 (v2.3)
    atrMinMult:    0.2,
    atrMaxMult:    5.0,

    higherTf:      "4h",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.25,

    volSmaMultiplier: 1.0,

    riskPerTrade:     0.02,    // v2.3: 2% per trade (dari 3%)
    maxDailyLossPct:  0.08,
    maxTradesPerDay:  5,       // v2.3: 5 trade/hari (dari 7)
    cooldownAfterLoss: 5,
    maxConsecLoss:    3,

    leverage:      1,
    interval:      "15m",
    checkInterval: 900000,

    grokConfirmMinEntry: 8,
    grokConfirmMinTp:    7,

    signalType:    "BREAKOUT_RETEST",

    trades:        "2-7 trade/hari",
    winrate:       "~51-56%",
    risk:          "Sedang-Tinggi",
  },

  // ─────────────────────────────────────────────
  // GROK_AI_TRADING — Grok (xAI) Live Trading
  // ─────────────────────────────────────────────
  GROK_AI_TRADING: {
    name:          "GROK_AI_TRADING",
    label:         "Grok AI Trading",
    description:   "Entry, confidence, TP/SL ditentukan Grok (xAI) dari data multi-TF.",

    emaFast:       20,
    emaSlow:       50,
    emaTrend:      0,

    rsiPeriod:     14,
    rsiOverbought: 70,
    rsiOversold:   30,
    rsiLongMin:    50,
    rsiLongMax:    70,
    rsiShortMin:   30,
    rsiShortMax:   50,

    atrPeriod:     14,
    atrMultiplier: 1.0,
    riskReward:    1.2,
    atrMinMult:    1.0,
    atrMaxMult:    5.0,

    higherTf:      "1h",
    htfEmaFast:    20,
    htfEmaSlow:    50,
    sidewaysThresholdPct: 0.2,

    volSmaMultiplier: 1.0,

    riskPerTrade:        0.01,
    maxDailyLossPct:     0.05,
    maxTradesPerDay:     20,
    cooldownAfterLoss:   30,
    maxConsecLoss:       3,

    minConfidenceEntry:  8,
    minConfidenceTpSl: 7,
    minRiskReward:       1.2,

    leverage:      2,
    interval:      "15m",
    checkInterval: 600_000,

    signalType:    "GROK_AI_TRADING",

    trades:        "~144 eval/hari (10m cycle)",
    winrate:       "N/A (AI-driven)",
    risk:          "Sedang",
  },
};

function getStrategy(overrideKey = null) {
  const key = (overrideKey || "B").toUpperCase();
  const strat = STRATEGIES[key];
  if (!strat) {
    return STRATEGIES["B"];
  }
  return strat;
}

function listStrategies() {
  return Object.values(STRATEGIES).map(s => ({
    key:         s.name,
    label:       s.label,
    description: s.description,
    signalType:  s.signalType,
    trades:      s.trades,
    winrate:     s.winrate,
    risk:        s.risk,
  }));
}

module.exports = { getStrategy, listStrategies, STRATEGIES };
