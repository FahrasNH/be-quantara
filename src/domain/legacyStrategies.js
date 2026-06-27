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
  // ADAPTIVE_FUSION — Multi-Component Strategy (v2.5)
  //
  //   Components A (scalp) + B (day) + C (swing) run simultaneously.
  //   Signal fired only on majority vote (3/3 with afMinVotes=3).
  //   SL/TP per component: A→2.2x/3.3x ATR, B→1.6x/3.4x ATR, C→1.2x/3.0x ATR
  //   v2.5 spec (STRATEGIES.md §4): high win-rate, tight entry, strongTrendTPMult 1.6
  // ─────────────────────────────────────────────
  ADAPTIVE_FUSION: {
    name:          "ADAPTIVE_FUSION",
    label:         "Adaptive Fusion",
    description:   "3-component voting system (Scalp+Day+Swing). Adapts SL/TP to winning component.",

    // Base indicators (used for calcIndicators — same as B for compatibility)
    emaFast:       9,
    emaSlow:       21,
    emaTrend:      50,

    rsiPeriod:     14,
    rsiOverbought: 72,
    rsiOversold:   28,
    rsiLongMin:    58,
    rsiLongMax:    68,
    rsiShortMin:   32,
    rsiShortMax:   42,

    atrPeriod:     14,
    // SL/TP overridden per-component in _handleSignal; these are fallback defaults
    atrMultiplier: 1.4,
    riskReward:    2.5,
    // v2.5: selaras dengan AdaptiveFusionStrategy.validateEntry (1.0–3.5%).
    atrMinMult:    1.0,
    atrMaxMult:    3.5,

    higherTf:      "1h",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    htfTrendStrengthMin: 0.72,
    sidewaysThresholdPct: 0.2,

    sidewaysRangeLookback:   20,
    sidewaysBreakoutVolMult: 1.5,
    sidewaysBreakoutBufMult: 0.3,

    volSmaMultiplier: 1.8,

    // v2.5 spec (STRATEGIES.md §4): risk 0.7%, max 8 trade/hari, cooldown 60 mnt.
    riskPerTrade:      0.007,
    maxDailyLossPct:   0.035,
    maxTradesPerDay:   8,
    cooldownAfterLoss: 60,
    maxConsecLoss:     2,

    // ── FEE-01/03: pengetatan entry v2.5 ───────────────────────────────────
    maxEntryExtensionATR: 0.8,
    minEdgeFeeMultiple:   7,
    strongTrendTPMult:    1.6,
    afMinVotes:           3,
    afRejectOnDissent:    true,

    leverage:      2,
    interval:      "15m",
    checkInterval: 60000,

    signalType:    "ADAPTIVE_FUSION",

    trades:        "2-8 trade/hari",
    winrate:       "~45-48% (v2.5 target)",
    risk:          "Sedang",
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

    signalType:    "BREAKOUT_RETEST",

    trades:        "2-7 trade/hari",
    winrate:       "~51-56%",
    risk:          "Sedang-Tinggi",
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
