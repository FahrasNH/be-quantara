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


    rsiPeriod:     21,
    rsiOverbought: 72,
    rsiOversold:   28,

    // simultaneously with pullback event + EMA alignment + MACD on 1h TF → near-zero B trades)
    rsiLongMin:    55,
    rsiLongMax:    75,
    rsiShortMin:   25,
    rsiShortMax:   45,

    atrPeriod:     14,
    atrMultiplier: 1.4,

    riskReward:    1.8,
    atrMinMult:    1.2,
    atrMaxMult:    3.5,

    higherTf:      "4h",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    htfTrendStrengthMin: 0.25,
    sidewaysThresholdPct: 0.2,

    sidewaysRangeLookback:   20,
    sidewaysBreakoutVolMult: 1.5,
    sidewaysBreakoutBufMult: 0.3,

    volSmaMultiplier: 1.3,

    // v2.8 (2026-07-04): per-type risk ladder. riskPerTrade = COMBINED cap,
    // distributed by TYPE_RISK_WEIGHTS (typeRiskLadder.js): 0.035 →
    // A/Scalping 0.5% · B/Intraday 1% · C/Swing 2% (user-specified ladder).
    riskPerTrade:        0.035,
    riskPerTradeStrong:  0.05,
    maxDailyLossPct:     0.035,
    maxTradesPerDay:     6,
    cooldownAfterLoss:   90,
    maxConsecLoss:       2,


    maxEntryExtensionATR: 1.2,
    minEdgeFeeMultiple:   7,
    strongTrendTPMult:    1.8,
    // Sprint 8 (AF-SUB-03): 3-component voting (SMC + Wyckoff + VSA).
    // Default 2/3 majority; altcoin tiers use 3/3 via afVoting.js.
    // Set afUseThreeComponentVoting:false to rollback to SMC-only multi-position.
    afUseThreeComponentVoting: true,
    afMinVotes:           2,   // absolute vote floor (2/3); altcoin override → 3
    afRejectOnDissent:    true,
    // ── Sprint 7 (AF-FIX, 2026-06-29): confidence-gated multi-component ──────────
    // v3.2 disabled A/B (C-only) because, UNGATED, their EMA-crossover designs

    // conviction score per component + a ≥60 entry gate, so A/B now fire ONLY on
    // high-confidence setups. All three components are re-enabled behind the gate
    // ("semua komponen berjalan dengan normal"); the gate removes the low-quality
    // fires that were the source of the bleed. NOTE: promote to live only after


    afEnabledComponents:  ["A", "B", "C", "D"],

    afMinComponentConfidence: 60,

    // components ≥ this (blocks weak reversal/"Signal" entries that only pay fees).
    afMinAggregateConfidence: 60,
    // SMC Component D lookback (bars to scan for OB/FVG zones)
    smcLookback: 20,

    // vwapLookback: rolling window for CVD + VWAP computation (bars)
    vwapLookback: 14,
    // ofDeltaThreshold: min bar delta for LONG entry (≥0.55 = close in top 45% of bar range).
    // 0.55 is calibrated for 1h TF; 0.60 was designed for <5m scalping and produced 0 trades/year on 1h.
    ofDeltaThreshold: 0.55,


    bUseMacd:      true,

    netEdgeK:      2.0,   // need 2× fee as minimum expected move
    feePct:        0.0012, // 0.12% roundtrip (taker both legs)

    leverage:      2,
    interval:      "1h",
    checkInterval: 60000,

    grokConfirmMinEntry: 8,
    grokConfirmMinTp:    7,

    signalType:    "ADAPTIVE_FUSION",

    trades:        "2-6 trade/hari",
    winrate:       "~48-52% (v2.6 target)",
    risk:          "Rendah–Sedang",
  },

  // ─────────────────────────────────────────────
  // TREND_FOLLOWING — Multi-TF Momentum (MINT Tier)
  //
  //   HTF: 1H (EMA trend)
  //   MTF: 15m (MACD + RSI momentum)
  //   Entry: 5m (EMA + RSI + volume confirmation)

  //   Target: 54-58% WR, 100-180% annual
  // ─────────────────────────────────────────────
  TREND_FOLLOWING: {
    name:          "TREND_FOLLOWING",
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
    atrMultiplier: 1.3,
    riskReward:    1.92,       // TP = 1.92×1.3 ≈ 2.5x ATR (v2.3)
    atrMinMult:    0.5,
    atrMaxMult:    8.0,

    // HTF trend filter
    higherTf:      "1h",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.25,

    volSmaMultiplier: 1.0,

    // v2.8 (2026-07-04): per-type ladder. Combined cap 0.03 distributed by
    // TYPE_RISK_WEIGHTS (Intraday 1 : Swing 2) → 1%/position Intraday, 2% Swing.
    // TF is the best 12m performer (+13.9 on $250 leg, WR 48%). Live single-TF
    // engine carries the full combined cap per position (one position at a time
    // → same worst-case max loss as 2 concurrent backtest legs).
    riskPerTrade:     0.03,
    maxDailyLossPct:  0.06,
    maxTradesPerDay:  4,
    cooldownAfterLoss: 5,
    maxConsecLoss:    3,

    // FEE-04: mode "partial" mengunci 40% di +1R & 27.5% di +2R lalu menggeser

    // (2026-07-07): partial mode juga berfungsi sebagai DIAGNOSTIK — leg
    // Partial_1R/Partial_2R/TP di CSV mengukur seberapa sering tiap level
    // tersentuh (touch-rate +1R = 45.6%, +2R = 14% pada run 12mo). Jangan
    // ganti mode ini untuk "memperbaiki" PF — perbaiki geometri Entry/SL/TP.
    tpMode:        "partial",

    leverage:      2,
    interval:      "5m",
    checkInterval: 60000,

    grokConfirmMinEntry: 7,
    grokConfirmMinTp:    7,

    signalType:    "TREND_FOLLOWING",


    // further fee drag (in-sample netPF 0.76 -> 0.82; bull window 0.96 was the
    // best single-window result found). SL/time-stop exits remain taker+slippage.
    typeOverrides: {
      Intraday: { makerEntry: true, makerFeeRate: 0.0002 },
      Swing:    { makerEntry: true, makerFeeRate: 0.0002 },
    },


    // AKTIF di backtest dengan index timestamp-aligned (htfPtr, closed bar — the
    // strategy's hardcoded ratio-12 mapping was reading future bars on 15m→4h /
    // 4h→1w legs). ADX 30 dipilih dari sweep 4 window (25/30 × ±strongDay):
    // ADX30 menang di SEMUA window — 12mo eval netPF 0.83→1.29 (net -90.5→+64.6),
    // bull 1.54, bear/recovery masih <1 tapi rugi terpangkas 60-79%. Satu-satunya
    // varian dengan total 4yr net positif. strongDay gate MERUSAK semua kombinasi
    // (tfRequireStrongTrend tetap OFF). tfHtfLayerEnabled: false = kontrol A/B.
    adxMinStrength:    30,
    tfHtfLayerEnabled: true,

    // Sprint 9 (TS-SUB-01/02/03): structure gate + VWAP precision layers.
    // Set either flag false to rollback that layer independently.
    tsUseStructureGate: true,
    tsUseVwapPrecision: true,
    // Spec: abs(price-VWAP) <= vwapAtrMult × ATR. 0.5 after 0.3 proved too tight on 5m.
    vwapAtrMult: 0.5,

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
    atrMultiplier: 1.4,
    riskReward:    2.29,       // TP = 1.4×2.29 ≈ 3.2x ATR → RR ~1:2.3 (v2.3)
    atrMinMult:    0.5,
    atrMaxMult:    6.0,

    higherTf:      "15m",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.3,

    volSmaMultiplier: 0.8,

    // v2.8 (2026-07-04): per-type ladder. Combined cap 0.015 distributed by
    // TYPE_RISK_WEIGHTS (Scalping 0.5 : Intraday 1) → 0.5%/1% per position
    // (user-specified). NOTE: MR expectancy still negative on n=7 — ladder set
    // per user request, but entry-gate quality is the real fix, not size.
    riskPerTrade:     0.015,
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
    atrMultiplier: 1.4,
    riskReward:    3.93,       // TP = 1.4×3.93 ≈ 5.5× ATR → RR ~1:4 (v2.3)
    atrMinMult:    0.2,
    atrMaxMult:    5.0,

    higherTf:      "4h",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.25,

    volSmaMultiplier: 1.0,

    riskPerTrade:     0.02,
    maxDailyLossPct:  0.08,
    maxTradesPerDay:  5,
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

  // ─────────────────────────────────────────────
  // SMART_MONEY_CONCEPTS — SAC v1.0 (FOUNDRY tier)
  //
  //   Komponen A — Scalping  : Liquidity sweep + Order Block + CVD (1h bars)
  //   Komponen B — Intraday  : CHoCH + Order Block + EMA trend (1h bars)
  //   Komponen C — Swing     : FVG + Displacement + Premium/Discount (1h bars)
  //   HTF Filter             : 4h regime (BULLISH/BEARISH/NEUTRAL)
  //
  //   Minimum 1 komponen harus lolos gate (A≥60, B≥65, C≥65).
  //   Tidak ada konflik arah (LONG vs SHORT secara bersamaan → skip).
  // ─────────────────────────────────────────────
  SMART_MONEY_CONCEPTS: {
    name:          "SMART_MONEY_CONCEPTS",
    label:         "Smart Money Concepts (SAC)",
    description:   "3-komponen SMC: Sweep+OB+CVD (scalping), CHoCH+OB+trend (intraday), FVG+displacement (swing). Blok entry berlawanan HTF.",

    // EMA untuk HTF trend (dipakai BotEngine)
    emaFast:       9,
    emaSlow:       21,
    emaTrend:      50,

    rsiPeriod:     14,
    rsiOverbought: 70,
    rsiOversold:   30,
    rsiLongMin:    45,
    rsiLongMax:    75,
    rsiShortMin:   25,
    rsiShortMax:   55,

    atrPeriod:     14,
    atrMultiplier: 1.2,
    riskReward:    2.0,
    atrMinMult:    0.8,
    atrMaxMult:    5.0,

    higherTf:      "4h",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.15,

    volSmaMultiplier: 1.0,

    // riskPerTrade = COMBINED max loss across all concurrent components (A/B/C),
    // NOT per-component. Both engines enforce this: backtest sizes each type at
    // riskPerTrade/3 (runTripleTypeBacktest), and live now divides per component
    // too (BotEngine._handleMultiPositionSignal). Progression 0.5%→1.5%→2.0%
    // (2026-07-03): at 0.5% return was ~1%/yr (size-bound, not edge-bound). The
    // 12mo BTC run then showed Sharpe 5.16 with max DD only 1.18% at 1.5% —
    // strongly under-risked. Trader+quant sign-off raised to 2.0% (est. DD ~1.6%,
    // return ~5%). 2.0% is moderate-aggressive; 3.0% is the prudent ceiling for
    // 3 correlated components — do NOT exceed. NOTE: backtest DD is in-sample
    // (40 trades, favorable period); expect live DD 2-4× higher.
    riskPerTrade:        0.02,
    maxDailyLossPct:     0.03,
    maxTradesPerDay:     8,
    cooldownAfterLoss:   60,
    maxConsecLoss:       3,

    // SAC-specific knobs
    sacEnabledComponents: ["A", "B", "C"],
    sacMinVotes:           1,            // 1 = any qualifying component can fire
    sacMinAggregateConfidence: 0,        // aggregate gate disabled (per-component gates apply)
    sacMinConfidenceA:     65,
    sacMinConfidenceB:     55,  // Intraday — lowered 65→55 (2026-07-03): 65 produced only
                                // ~3 Intraday entries per 12mo on BTC. Intraday (15m/4h) is
                                // meant to be the workhorse (3–5/day target); the sequence
                                // engine is already selective, so a slightly lower confidence
                                // floor unlocks frequency without loosening Scalping/Swing.
    sacMinConfidenceC:     65,  // Swing

    // ── Event-driven SMC sequence engine (v3.0) ──────────────────────────────
    // sweep → CHoCH → displacement/FVG → mitigation → entry (causal, cross-bar)
    sacUseSequenceEngine: true,          // false = legacy independent single-bar checks
    sacSeqWindow:      60,               // max bars back to assemble the full sequence

    // Sweep detector
    sacSwingLookback:  5,
    sacSweepScanBars:  50,
    sacSweepVolMult:   0.9,

    // Order block
    sacOBLookback:     15,
    sacOBDispMult:     1.3,

    // CHoCH
    sacChochLookback:  20,

    // FVG (mitigation zone for the sequence engine)
    sacFvgMinGap:      0.0015,           // 0.3% → 0.15%: catch smaller imbalances (more mitigations)
    sacFvgScanBars:    40,

    // Displacement
    sacDispScanBars:   25,
    sacDispVolMult:    1.8,
    sacDispRangePct:   0.008,            // 1.2% → 0.8%: lower range bar for displacement

    // CVD / VWAP lookback
    vwapLookback:      14,

    leverage:      3,
    interval:      "1h",
    checkInterval: 3_600_000,

    signalType:    "SMART_MONEY_CONCEPTS",

    trades:  "~3–8 trade/hari (1h eval)",
    winrate: "Target 52–60%",
    risk:    "Rendah-Sedang",
  },

  // ─────────────────────────────────────────────
  // v2.0 UMBRELLA/COMPONENT KEYS
  // These mirror the primary presets above with updated name + signalType.
  // BotEngine resolves these via StrategyRegistry.get(signalType).
  // ─────────────────────────────────────────────

  AF_SMC: null, // populated below — avoids copy-paste drift
  TS_TF:  null,
  MD_MR:  null,
  BS_BR:  null,
};

// Populate component-key aliases from their parent presets
STRATEGIES.AF_SMC = { ...STRATEGIES.SMART_MONEY_CONCEPTS, name: "AF_SMC", label: "Adaptive Fusion (AF_SMC)", signalType: "AF_SMC" };
STRATEGIES.AF_WYCKOFF = { ...STRATEGIES.AF_SMC, name: "AF_WYCKOFF", label: "Wyckoff Method", signalType: "AF_SMC" };
STRATEGIES.AF_VSA = { ...STRATEGIES.AF_SMC, name: "AF_VSA", label: "Volume Spread Analysis", signalType: "AF_SMC" };
STRATEGIES.TS_TF  = { ...STRATEGIES.TREND_FOLLOWING,       name: "TS_TF",  label: "Trend Surge (TS_TF)",     signalType: "TS_TF"  };
STRATEGIES.TS_MS  = { ...STRATEGIES.TS_TF, name: "TS_MS", label: "Dow Theory", signalType: "TS_TF" };
STRATEGIES.TS_VP  = { ...STRATEGIES.TS_TF, name: "TS_VP", label: "Auction Market Theory", signalType: "TS_TF" };
STRATEGIES.MD_MR  = { ...STRATEGIES.MEAN_REVERSION,       name: "MD_MR",  label: "Mean Drift (MD_MR)",      signalType: "MD_MR"  };
STRATEGIES.BS_BR  = { ...STRATEGIES.BREAKOUT_RETEST,      name: "BS_BR",  label: "Breakout Storm (BS_BR)",  signalType: "BS_BR"  };

const _EMPTY = undefined; // remove null sentinels (already overwritten above)

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
