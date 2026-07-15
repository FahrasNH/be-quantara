// ─────────────────────────────────────────────
// strategyDefaults.js — trade-type parameter presets + strategy engine presets
// (formerly legacyStrategies.js — NOT legacy/unused; actively used as STRATEGIES SSOT)
//
// Berdasarkan: "Dokumentasi Panduan Strategi Trading"
//   Aggressive Scalping, Day Trading, dan Swing Trading
//
// PDF trade-type presets pakai key identitas asli (bukan A/B/C generik):
//   AGGRESSIVE_SCALPING (HTF:15m, Entry:1m)
//   DAY_TRADING         (HTF:1H,  Entry:15m) ⭐ default getStrategy()
//   SWING_TRADING       (HTF:1D,  Entry:4H)
// Key lama "A"/"B"/"C" dipetakan ke identitas ini di getStrategy() (backward-compat).
//
// FOUNDRY / Adaptive Fusion single source of truth:
//   ADAPTIVE_FUSION = canonical root (SMC params + AF race flags). AF_SMC /
//   AF_WYCKOFF / AF_VSA derive FLAT from ADAPTIVE_FUSION (same pattern as MD/BS).
//   Gen1 strategy keys resolve via strategyKeyNormalizer ACL at getStrategy() ingress.
//
// Confidence floors: prefer smcMinConfidenceScalping/Intraday/Swing; legacy
// smcMinConfidenceA/B/C still accepted via smcParamCompat normalizeSmcParams().
// ─────────────────────────────────────────────

const {
  normalizeStrategyKey,
  normalizeTradeTypeKey,
} = require("./strategyKeyNormalizer");

const STRATEGIES = {

  // ─────────────────────────────────────────────
  // Aggressive Scalping  (PDF trade-type preset)
  //
  //   HTF Trend Filter : 15m (EMA9/21 + close vs EMA)
  //   Entry TF         : 1m (default)
  //   EMA              : 9 / 21
  //   RSI              : 7 | Long >50, Short <50
  //   Volume           : Wajib di atas rata-rata
  //   SL               : 0.5x ATR | TP: 1x ATR (RR 1:2)
  //   Risk/trade       : 0.5%–1%
  // ─────────────────────────────────────────────
  AGGRESSIVE_SCALPING: {
    name:          "AGGRESSIVE_SCALPING",
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
  // Day Trading ⭐ RECOMMENDED  (PDF trade-type preset · default getStrategy)
  //
  //   HTF Trend Filter : 1H (EMA9/21 + close vs EMA50)
  //   Entry TF         : 15m (default)
  //   EMA              : 9 / 21 + EMA50 trend filter
  //   RSI              : 14 | Long 50-70, Short 30-50
  //   Volume           : Wajib di atas rata-rata
  //   SL               : 1x ATR | TP: 1.5–3x ATR (RR 1:2)
  //   Risk/trade       : 1%–2%
  // ─────────────────────────────────────────────
  DAY_TRADING: {
    name:          "DAY_TRADING",
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
  // Swing Trading  (PDF trade-type preset)
  //
  //   HTF Trend Filter : 1D (close vs EMA200)
  //   Entry TF         : 4H
  //   EMA              : 21 / 50 + EMA200 trend filter
  //   RSI              : 14 | Sesuai pullback trend (40-60)
  //   Volume           : Wajib di atas rata-rata
  //   SL               : 1.5x ATR | TP: 4.5x ATR (RR 1:3)
  //   Risk/trade       : 1%–2%
  // ─────────────────────────────────────────────
  SWING_TRADING: {
    name:          "SWING_TRADING",
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
  // TS_TF — Multi-TF Momentum (FORGE Tier)
  //
  //   HTF: 1H (EMA trend)
  //   MTF: 15m (MACD + RSI momentum)
  //   Entry: 5m (EMA + RSI + volume confirmation)

  //   Target: 54-58% WR, 100-180% annual
  // ─────────────────────────────────────────────
  TS_TF: {
    name:          "TS_TF",
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

    signalType:    "TS_TF",

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
  // MD_MR — BB Extremes (MINT Tier)
  //
  //   BB: 20 period, 2σ deviation
  //   RSI: 14 period (oversold <25, overbought >75)
  //   Entry: Price touch band + RSI confirmation + 2-bar validate

  //   Target: 55-60% WR, 100-150% annual
  // ─────────────────────────────────────────────
  MD_MR: {
    name:          "MD_MR",
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

    signalType:    "MD_MR",

    trades:        "5-15 trade/minggu",
    winrate:       "~55-60%",
    risk:          "Rendah",
  },

  // ─────────────────────────────────────────────
  // BS_BR — Breakout + Retest (VAULT Tier)
  //
  //   Entry TF  : 15m — deteksi level S&R 20-bar, breakout + retest

  // ─────────────────────────────────────────────
  BS_BR: {
    name:          "BS_BR",
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

    signalType:    "BS_BR",

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
  // ADAPTIVE_FUSION — SMC v3.0 (FOUNDRY tier) · CANONICAL ROOT
  //
  //   SSOT tuning SMC + AF race flags. AF_SMC / AF_WYCKOFF / AF_VSA spread
  //   verbatim below (FLAT pattern). Persisted umbrella key ADAPTIVE_FUSION
  //   resolves to AF_SMC engine via StrategyRegistry.
  //
  //   Legs (Scalping / Intraday / Swing) — smcEnabledComponents slot A/B/C
  //   maps via SmartMoneyConceptsStrategy.COMPONENT_TO_TYPE.
  // ─────────────────────────────────────────────
  ADAPTIVE_FUSION: {
    name:          "ADAPTIVE_FUSION",
    label:         "Adaptive Fusion",
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

    // SMC-specific knobs. Slot "A"/"B"/"C" = leg Scalping/Intraday/Swing
    // (COMPONENT_TO_TYPE) — beda dari preset trade-type top-level A/B/C.
    smcEnabledComponents: ["A", "B", "C"],
    smcMinVotes:           1,            // 1 = any qualifying component can fire
    smcMinAggregateConfidence: 0,        // aggregate gate disabled (per-component gates apply)
    // Uniform confidence floor across all 3 legs (factory default).
    smcMinConfidenceScalping: 60,
    smcMinConfidenceIntraday: 60,
    smcMinConfidenceSwing:    60,
    // Legacy A/B/C keys — kept for persisted configs; canonical names above win on conflict.
    smcMinConfidenceA:     60,
    smcMinConfidenceB:     60,
    smcMinConfidenceC:     60,

    // ── Event-driven SMC sequence engine (v3.0) ──────────────────────────────
    // sweep → CHoCH → displacement/FVG → mitigation → entry (causal, cross-bar)
    smcUseSequenceEngine: true,          // false = legacy independent single-bar checks
    smcSeqWindow:      60,               // max bars back to assemble the full sequence

    // Sweep detector
    smcSwingLookback:  5,
    smcSweepScanBars:  50,
    smcSweepVolMult:   0.9,

    // Order block
    smcOBLookback:     15,
    smcOBDispMult:     1.3,

    // CHoCH
    smcChochLookback:  20,

    // FVG (mitigation zone for the sequence engine)
    smcFvgMinGap:      0.0015,           // 0.3% → 0.15%: catch smaller imbalances (more mitigations)
    smcFvgScanBars:    40,

    // Displacement
    smcDispScanBars:   25,
    smcDispVolMult:    1.8,
    smcDispRangePct:   0.008,            // 1.2% → 0.8%: lower range bar for displacement

    // CVD / VWAP lookback
    vwapLookback:      14,

    leverage:      3,
    interval:      "1h",
    checkInterval: 3_600_000,

    // AF umbrella race flags — SINGLE SOURCE for AF_SMC / AF_WYCKOFF / AF_VSA
    // (dulu di blok ADAPTIVE_FUSION yang duplikatif; sekarang hidup di sini).
    // Default "race" (Sprint 12); "vote" = rollback Sprint 8 (2/3 majority).
    afCombinationMode: "race",
    afUseThreeComponentVoting: true, // false → smc_only passthrough
    afMinVotes:        2,            // vote-mode only; altcoin override → 3
    afRejectOnDissent: true,         // vote-mode only

    signalType:    "ADAPTIVE_FUSION",

    trades:  "~3–8 trade/hari (1h eval)",
    winrate: "Target 52–60%",
    risk:    "Rendah-Sedang",

    // AF-SMC low-TF ATR-gate fix (2026-07-15): the ABSOLUTE atrMinMult floor
    // above (0.8 = 0.8% ATR/price) was calibrated for the 4h chart. Applied
    // uniformly it starves the low-TF legs — 5m BTC ATR is ~0.05-0.25%, 15m
    // ~0.2-0.6% — so the 0.8% floor rejected nearly every bar (Scalping 0
    // trades / 3mo, Intraday ~3 trades / 3mo). Per-leg atrMinMult scales the
    // floor to each TF's real ATR% band while keeping Swing (4h) at the proven
    // 0.8. Intraday smcMinConfidenceB restores the proven 2026-07-03 tuning
    // (60 → 55). These are BACKTEST-only knobs: the triple/multi-type engine
    // spreads typeOverrides[leg] onto the per-type config, so the ATR gate and
    // the SMC confidence floor pick them up. Live gating (BotEngine) reads the
    // TOP-LEVEL atrMinMult (0.8) and smcMinConfidenceB (60) and does NOT merge
    // typeOverrides into those gates — live behaviour is unchanged.
    typeOverrides: {
      Scalping: { atrMinMult: 0.15 },
      Intraday: { atrMinMult: 0.4, smcMinConfidenceIntraday: 55, smcMinConfidenceB: 55 },
      Swing:    { atrMinMult: 0.8 },
    },
  },

  // ─────────────────────────────────────────────
  // v2.0 UMBRELLA/COMPONENT KEYS
  // Canonical keys are assigned below from parent presets (single source of
  // truth — avoids copy-paste drift). signalType points at the umbrella engine
  // key so StrategyRegistry resolves one instance; per-trade attribution uses
  // the winning racer label (AF_SMC / AF_WYCKOFF / AF_VSA, etc.).
  //
  // NOTE: AGGRESSIVE_SCALPING / DAY_TRADING / SWING_TRADING above are PDF trade-type
  // presets, NOT Adaptive Fusion components. Do not confuse with AF_SMC / AF_WYCKOFF /
  // AF_VSA. Old persisted keys "A"/"B"/"C" map to them via getStrategy() below.
  // ─────────────────────────────────────────────
};

// Canonical component keys — FLAT spread from ADAPTIVE_FUSION root (no copy-paste drift).
STRATEGIES.AF_SMC = {
  ...STRATEGIES.ADAPTIVE_FUSION,
  name: "AF_SMC",
  label: "Smart Money Concepts",
  signalType: "AF_SMC",
};
STRATEGIES.AF_WYCKOFF = {
  ...STRATEGIES.ADAPTIVE_FUSION,
  name: "AF_WYCKOFF",
  label: "Wyckoff Method",
  signalType: "AF_SMC",
};
STRATEGIES.AF_VSA = {
  ...STRATEGIES.ADAPTIVE_FUSION,
  name: "AF_VSA",
  label: "Volume Spread Analysis",
  signalType: "AF_SMC",
};
STRATEGIES.TS_MS  = { ...STRATEGIES.TS_TF, name: "TS_MS",  label: "Dow Theory",             signalType: "TS_TF" };
STRATEGIES.TS_VP  = { ...STRATEGIES.TS_TF, name: "TS_VP",  label: "Auction Market Theory",  signalType: "TS_TF" };
STRATEGIES.MD_SD  = { ...STRATEGIES.MD_MR, name: "MD_SD",  label: "Supply and Demand",           signalType: "MD_MR" };
STRATEGIES.MD_SA  = { ...STRATEGIES.MD_MR, name: "MD_SA",  label: "Statistical Arbitrage",       signalType: "MD_MR" };
STRATEGIES.BS_ICT = { ...STRATEGIES.BS_BR, name: "BS_ICT", label: "ICT-style trading",           signalType: "BS_BR" };
STRATEGIES.BS_LS  = { ...STRATEGIES.BS_BR, name: "BS_LS",  label: "Liquidation/Squeeze Trading", signalType: "BS_BR" };

function getStrategy(overrideKey = null) {
  const raw = (overrideKey || "DAY_TRADING").toUpperCase();
  const stratKey = normalizeStrategyKey(raw);
  if (STRATEGIES[stratKey]) return STRATEGIES[stratKey];
  const tradeKey = normalizeTradeTypeKey(raw);
  return STRATEGIES[tradeKey] || STRATEGIES.DAY_TRADING;
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
