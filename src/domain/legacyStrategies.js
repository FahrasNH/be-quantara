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
    description:   "FOUNDRY pool: SMC + Wyckoff + VSA race independently (legacy preset key → AF_SMC).",

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
    // Sprint 12 (AF-SUB-03 rescope): SMC / Wyckoff / VSA race independently.
    // Default afCombinationMode:"race". Rollback: "vote" (Sprint 8 2/3 majority)
    // or afUseThreeComponentVoting:false (SMC-only multi-position).
    afCombinationMode: "race",
    afUseThreeComponentVoting: true, // ignored when afCombinationMode is set; false → smc_only
    afMinVotes:           2,   // vote-mode only: absolute floor (2/3); altcoin override → 3
    afRejectOnDissent:    true, // vote-mode only
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

    // Sprint 14 factory reset — canonical Trend Following geometry (PDF:
    // EMA/SMA, Donchian, ADX, ATR). SL 1.5×ATR, TP 3.0×ATR (RR 1:2), 1% risk.
    atrPeriod:     14,
    atrMultiplier: 1.5,        // SL = 1.5×ATR
    riskReward:    2.0,        // TP = 3.0×ATR (RR 1:2)
    atrMinMult:    0.5,
    atrMaxMult:    8.0,

    // HTF trend filter
    higherTf:      "1h",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.25,

    volSmaMultiplier: 1.0,

    // Uniform 1% risk (factory default; per-type ladder removed).
    riskPerTrade:     0.01,
    maxDailyLossPct:  0.06,
    maxTradesPerDay:  4,
    cooldownAfterLoss: 5,
    maxConsecLoss:    3,

    // Factory default: close 100% at TP (no partial/trailing overlay).
    tpMode:        "fixed",

    leverage:      2,
    interval:      "5m",
    checkInterval: 60000,

    grokConfirmMinEntry: 7,
    grokConfirmMinTp:    7,

    signalType:    "TREND_FOLLOWING",

    // No per-type overrides — every leg uses the canonical geometry above.
    typeOverrides: {},

    // HTF trend layer (EMA + ADX) is core to Trend Following (PDF indicator).
    // ADX 25 = textbook trend-strength threshold (was tuned to 30).
    adxMinStrength:    25,
    tfHtfLayerEnabled: true,

    // Sub-components race independently (architecture default).
    tsCombinationMode: "race",
    // Experimental precision gates OFF (only apply in "gate"/"hybrid" mode).
    tsUseStructureGate: false,
    tsUseVwapPrecision: false,
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

    // Sprint 14 factory reset — canonical Mean Reversion (PDF: VWAP, Bollinger,
    // RSI, z-score). SL 1.5×ATR, TP 3.0×ATR (RR 1:2), 1% risk.
    atrPeriod:     14,
    atrMultiplier: 1.5,        // SL = 1.5×ATR
    riskReward:    2.0,        // TP = 3.0×ATR (RR 1:2)
    atrMinMult:    0.5,
    atrMaxMult:    6.0,

    higherTf:      "15m",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.3,

    volSmaMultiplier: 0.8,

    // Uniform 1% risk (factory default; per-type ladder removed).
    riskPerTrade:     0.01,
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

    // Sprint 14 factory reset — canonical Breakout (PDF: Volume, ATR, Bollinger
    // width, range H/L). SL 1.5×ATR, TP 4.5×ATR (RR 1:3 — breakouts run
    // further), 1% risk.
    atrPeriod:     14,
    atrMultiplier: 1.5,        // SL = 1.5×ATR
    riskReward:    3.0,        // TP = 4.5×ATR (RR 1:3)
    atrMinMult:    0.2,
    atrMaxMult:    5.0,

    higherTf:      "4h",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.25,

    volSmaMultiplier: 1.0,

    // Uniform 1% risk (factory default).
    riskPerTrade:     0.01,
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
  // GROK_AI_TRADING — Experimental / VAULT bonus (NOT a tier umbrella)
  //
  // AF-CONFIG-AUDIT clarification (2026-07-11):
  //   • This IS a real strategy key that generates entry/exit via Grok (xAI).
  //   • It is NOT one of the 4 canonical umbrellas (AF/TS/MD/BS).
  //   • Architecture preference: LLM complementary only (GrokConfirm overlay).
  //   • Kept for VAULT bonus entitlement + admin experiments; do not add to
  //     TIER_COMPONENT_MAP race pools. Prefer GrokConfirm on AF/TS/MD/BS bots.
  // ─────────────────────────────────────────────
  GROK_AI_TRADING: {
    name:          "GROK_AI_TRADING",
    label:         "Grok AI Trading (experimental)",
    description:   "EXPERIMENTAL VAULT bonus: entry/TP/SL via Grok (xAI). Prefer GrokConfirm overlay on canonical strategies for production.",

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

    // Sprint 14 factory reset — SMC is structure-based (PDF: market structure,
    // swing H/L, session H/L, volume, OI, CVD). SL 1.5×ATR, TP 3.0×ATR (RR 1:2).
    atrPeriod:     14,
    atrMultiplier: 1.5,        // SL = 1.5×ATR
    riskReward:    2.0,        // TP = 3.0×ATR (RR 1:2)
    atrMinMult:    0.8,
    atrMaxMult:    5.0,

    higherTf:      "4h",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.15,

    volSmaMultiplier: 1.0,

    // Uniform 1% combined risk (backtest sizes each concurrent component at
    // riskPerTrade/3; live divides per component too). Factory default.
    riskPerTrade:        0.01,
    maxDailyLossPct:     0.03,
    maxTradesPerDay:     8,
    cooldownAfterLoss:   60,
    maxConsecLoss:       3,

    // SAC-specific knobs
    sacEnabledComponents: ["A", "B", "C"],
    sacMinVotes:           1,            // 1 = any qualifying component can fire
    sacMinAggregateConfidence: 0,        // aggregate gate disabled (per-component gates apply)
    // Uniform confidence floor across all 3 legs (factory default).
    sacMinConfidenceA:     60,  // Scalping
    sacMinConfidenceB:     60,  // Intraday
    sacMinConfidenceC:     60,  // Swing

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

    // Sprint 14 factory reset — no per-type overrides. Every leg (Scalping 5m/1h,
    // Intraday 15m/4h, Swing 4h/1w) uses the canonical geometry above
    // (SL 1.5×ATR / TP 3.0×ATR, RR 1:2). The prior over-fit stack (session
    // filters, asymmetric confidence 80/75, funding guards, maker-fee entries,
    // fast-fail SL widening) was removed for a clean baseline.
    typeOverrides: {},
  },

  // ─────────────────────────────────────────────
  // v2.0 UMBRELLA/COMPONENT KEYS
  // Canonical keys are assigned below from parent presets (single source of
  // truth — avoids copy-paste drift). signalType points at the umbrella engine
  // key so StrategyRegistry resolves one instance; per-trade attribution uses
  // the winning racer label (AF_SMC / AF_WYCKOFF / AF_VSA, etc.).
  //
  // NOTE: A / B / C above are PDF trade-type presets (Scalping/Day/Swing), NOT
  // Adaptive Fusion components. Do not confuse with AF_SMC / AF_WYCKOFF / AF_VSA.
  // ─────────────────────────────────────────────
};

// Canonical component keys — derived from parent presets (no null sentinels).
// AF_SMC uses SMART_MONEY_CONCEPTS as the SMC engine preset + AF race flags from
// ADAPTIVE_FUSION (do not wholesale-spread ADAPTIVE_FUSION — different risk knobs).
STRATEGIES.AF_SMC = {
  ...STRATEGIES.SMART_MONEY_CONCEPTS,
  name: "AF_SMC",
  label: "Smart Money Concepts",
  signalType: "AF_SMC",
  afCombinationMode: STRATEGIES.ADAPTIVE_FUSION.afCombinationMode || "race",
  afUseThreeComponentVoting: STRATEGIES.ADAPTIVE_FUSION.afUseThreeComponentVoting !== false,
  afMinVotes: STRATEGIES.ADAPTIVE_FUSION.afMinVotes ?? 2,
  afRejectOnDissent: STRATEGIES.ADAPTIVE_FUSION.afRejectOnDissent !== false,
};
STRATEGIES.AF_WYCKOFF = {
  ...STRATEGIES.AF_SMC,
  name: "AF_WYCKOFF",
  label: "Wyckoff Method",
  signalType: "AF_SMC",
};
STRATEGIES.AF_VSA = {
  ...STRATEGIES.AF_SMC,
  name: "AF_VSA",
  label: "Volume Spread Analysis",
  signalType: "AF_SMC",
};
STRATEGIES.TS_TF  = { ...STRATEGIES.TREND_FOLLOWING, name: "TS_TF",  label: "Trend Following",        signalType: "TS_TF" };
STRATEGIES.TS_MS  = { ...STRATEGIES.TS_TF,           name: "TS_MS",  label: "Dow Theory",             signalType: "TS_TF" };
STRATEGIES.TS_VP  = { ...STRATEGIES.TS_TF,           name: "TS_VP",  label: "Auction Market Theory",  signalType: "TS_TF" };
STRATEGIES.MD_MR  = { ...STRATEGIES.MEAN_REVERSION,  name: "MD_MR",  label: "Mean Reversion",              signalType: "MD_MR" };
STRATEGIES.MD_SD  = { ...STRATEGIES.MEAN_REVERSION,  name: "MD_SD",  label: "Supply and Demand",           signalType: "MD_MR" };
STRATEGIES.MD_SA  = { ...STRATEGIES.MEAN_REVERSION,  name: "MD_SA",  label: "Statistical Arbitrage",       signalType: "MD_MR" };
STRATEGIES.BS_BR  = { ...STRATEGIES.BREAKOUT_RETEST, name: "BS_BR",  label: "Breakout Trading",             signalType: "BS_BR" };
STRATEGIES.BS_ICT = { ...STRATEGIES.BREAKOUT_RETEST, name: "BS_ICT", label: "ICT-style trading",           signalType: "BS_BR" };
STRATEGIES.BS_LS  = { ...STRATEGIES.BREAKOUT_RETEST, name: "BS_LS",  label: "Liquidation/Squeeze Trading", signalType: "BS_BR" };

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
