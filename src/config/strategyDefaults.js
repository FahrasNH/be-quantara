// ─────────────────────────────────────────────
// strategyDefaults.js — strategy engine presets (STRATEGIES SSOT)
//
// Per-strategy leg tuning lives in typeOverrides (Scalping / Intraday / Swing).
// TIME_STOP OFF by default (no maxHoldHours) — opt-in via typeOverrides if needed.
// Deprecated PDF preset keys (AGGRESSIVE_SCALPING / DAY_TRADING / SWING_TRADING)
// and legacy A/B/C resolve via strategyKeyNormalizer ACL at ingress.
//
// ADAPTIVE_FUSION = umbrella-only (race flags). SMART_MONEY_CONCEPTS owns all
// smc* knobs. Component racers spread from tier COMPONENT_BASE + own knobs — NOT
// full parent engine presets (Donchian/ADX/BB/retest parent knobs stay on parents).
// Gen1 strategy keys resolve via strategyKeyNormalizer at getStrategy() ingress.
// ─────────────────────────────────────────────

const {
  normalizeStrategyKey,
} = require("./strategyKeyNormalizer");
const { getHtfMode } = require("./htfMode");

/**
 * Per-leg ATR gate — absolute floors + Scalping adaptive (atrGateRelative).
 * Relative gate compares ATR to the leg's own rolling baseline so calm 5m
 * markets (ATR% ~0.05–0.12) are not blanket-rejected by a 0.15% absolute floor.
 *
 * Band 0.4–4.0 (Defect A fix, 2026-07-16): the old 0.6–3.0 window rejected the
 * FIRST SMC setup and every subsequent one on real BTC 5m data (0 trades),
 * because real volatility is CLUSTERED — SMC structure entries (sweeps /
 * accumulation) form during quiet legs where ATR sits at 40–60% of a 100-bar
 * SMA that is dragged up by prior expansion clusters (rel < 0.6), while
 * post-sweep displacement bars can spike to 3–4× that baseline (rel > 3.0).
 * Mock data has near-constant vol (rel≈1) so the old band never triggered there.
 * 0.4 still blocks dead/flatlined markets (<40% of avg = no tradeable range) and
 * 4.0 still blocks true blowoffs (>4× = news/liquidation cascade). This is the
 * SHARED SSOT read by backtest, dry-run AND live (validateEntry / checkAtrRangeGate)
 * so all four contexts move together (1:1 parity preserved).
 */
const DEFAULT_LEG_TYPE_OVERRIDES = Object.freeze({
  Scalping: { atrMinMult: 0.15, atrGateRelative: true, atrRelMin: 0.4, atrRelMax: 4.0 },
  Intraday: { atrMinMult: 0.4 },
  Swing:    { atrMinMult: 0.8 },
});

/**
 * Shared Scalping geometry (Sprint 16 — all 4 umbrellas).
 * Planned RR 2.0 (SL 1.5×ATR / TP 3.0×ATR). TIME_STOP OFF (no maxHoldHours).
 * Backtest + live read typeOverrides.Scalping via calculateRiskConfig slAtrMult/tpAtrMult chain.
 */
const SCALP_GEOMETRY = Object.freeze({
  slAtrMult: 1.5,
  tpAtrMult: 3.0,
});

/** Intraday hold knobs — TIME_STOP OFF (empty; re-enable with maxHoldHours). */
const INTRADAY_HOLD = Object.freeze({});

/** Swing hold knobs — TIME_STOP OFF (empty; re-enable with maxHoldHours). */
const SWING_HOLD = Object.freeze({});

/** DEFAULT + per-leg geometry — TS / MD / BS parents + AF Wyckoff/VSA components. */
const STANDARD_LEG_TYPE_OVERRIDES = Object.freeze({
  ...DEFAULT_LEG_TYPE_OVERRIDES,
  Scalping: {
    ...DEFAULT_LEG_TYPE_OVERRIDES.Scalping,
    ...SCALP_GEOMETRY,
    // Session filter OFF + TIME_STOP OFF globally
  },
  Intraday: { ...DEFAULT_LEG_TYPE_OVERRIDES.Intraday, ...INTRADAY_HOLD },
  Swing:    { ...DEFAULT_LEG_TYPE_OVERRIDES.Swing, ...SWING_HOLD },
});

/**
 * SMC-only per-leg overrides — keep atrGateRelative from DEFAULT, PLUS lower
 * confidence floors. Without these, detectSignalMulti falls back to top-level
 * smcMinConfidence*=60 and Scalping stays ~0 trades on real 5m (Defect A).
 *
 * Scalping geometry (Sprint 16 / 5m no-edge fix):
 *   - Planned RR 2.0 via slAtrMult/tpAtrMult (was hardcoded SUB_STRATEGIES 4.5R —
 *     a swing target on a 5m leg → multi-hour winners, fast SL losers, −EV).
 *   - TIME_STOP OFF (no maxHoldHours); Session filter OFF; OB-retest / chop-LONG gates ON.
 * Live remains blocked by liveTradeTypeGate.js until walk-forward clears.
 */
const SMC_LEG_TYPE_OVERRIDES = Object.freeze({
  Scalping: {
    ...DEFAULT_LEG_TYPE_OVERRIDES.Scalping,
    // Sprint 16 edge discovery: absolute ATR% floor (also enforced atop relative gate)
    atrMinMult: 0.287,
    // Use the canonical graded score, but keep a viable research sample. A
    // 75+ floor was too sparse on the current BTC tape; calibration must be
    // done walk-forward rather than by forcing the leg to zero trades.
    smcMinConfidenceScalping: 50,
    smcMinConfidenceA: 50,
    smcSweepVolMult: 1.2,
    // SL 1.5×ATR (fee-drag lever vs 1.0) / TP 3.0×ATR → Planned RR 2.0
    slAtrMult: 1.5,
    tpAtrMult: 3.0,
    // Session filter OFF — Asia block removed (re-enable via smcSessionFilter + noTradeSessions)
    smcSessionFilter: false,
    smcBlockLongInChop: true,
    smcRequireObRetest: true,
    // A reversal setup is invalid when it fights the confirmed 1h direction.
    smcHtfHardBlock: true,
    // A close inside an FVG is not a reversal confirmation. Require the
    // entry candle to reject the mitigation level and close back in direction.
    smcRejectionEntry: true,
    smcRejectionWickRatio: 0.5,
    // Require complete 5m sweep/CHoCH/displacement structure before entry.
    validateEntryTFStructure: true,
  },
  Intraday: {
    ...DEFAULT_LEG_TYPE_OVERRIDES.Intraday,
    ...INTRADAY_HOLD,
    // Canonical graded-score gate. The former 80 floor was calibrated on the
    // pre-canonical sequence score and becomes effectively no-trade after the
    // score alignment; 60 keeps a testable sample for walk-forward validation.
    smcMinConfidenceIntraday: 60,
    smcMinConfidenceB: 60,
    // Sprint 22: enable pivot-structure OB leg (was default false → OB confluence 100% dead)
    smcPivotStructure: true,
    // Explicit geometry — Planned RR ~2.0 (matches ~1.8 realized structure-SL on BNB)
    slAtrMult: 1.8,
    tpAtrMult: 3.6,
    // Session filter OFF — London block removed (re-enable via smcSessionFilter + noTradeSessions)
    smcSessionFilter: false,
    // Sprint 22: both sides lose in CHOP on Intraday — block all entries (not Scalping LONG-only)
    smcBlockAllInChop: true,
    smcHtfHardBlock: true,
    // Use the same causal rejection confirmation as Scalping. Without this,
    // Intraday still enters while price is slicing through the FVG.
    smcRejectionEntry: true,
    smcRejectionWickRatio: 0.4,
    // The shared sequence is too permissive for 15m. Require directional 1h
    // regime and an independent slower 15m structure confirmation.
    regimeMappingStrict: true,
    structureConfirmValidate: true,
    // smcSweepVolMult intentionally unset — Scalping floor (1.2) hurts Intraday PF (Sprint 22 ablation)
  },
  Swing: {
    ...DEFAULT_LEG_TYPE_OVERRIDES.Swing,
    ...SWING_HOLD,
    // Full-history forensics: Swing's VOLATILE entry-TF bucket had PF 0.77
    // and contributed the majority of the 10y loss. Keep the leg focused on
    // NORMAL/STRONG_TREND until a volatility-specific entry model exists.
    smcBlockVolatile: true,
    // Explicit geometry — Planned RR ~3.0 (longer hold needs larger payoff)
    slAtrMult: 1.2,
    tpAtrMult: 3.6,
    // Reject 4h entries that never retest the structural OB/FVG zone.
    smcRequireObRetest: true,
  },
});

/**
 * VSA per-leg overrides — Sprint 23 FOUNDRY fixes.
 * Scalping shelved (fee-bound); Swing LONG-only + conf≥60 or Stopping-Volume.
 * Session filters OFF (no Asia/London blocks).
 */
const VSA_LEG_TYPE_OVERRIDES = Object.freeze({
  Scalping: {
    ...STANDARD_LEG_TYPE_OVERRIDES.Scalping,
    vsaScalpingShelved: true,
    vsaSessionFilter: false,
  },
  Intraday: {
    ...STANDARD_LEG_TYPE_OVERRIDES.Intraday,
    // Fix #4 REVERTED (Sprint 23 post-WF): relative gate unlocked 4–7× trades on
    // sub-0.4% ATR quiet legs with no gross edge — fees drove −89% NET (0/3 BLOCK).
    // Absolute 0.4% floor restored; pre-fix WF was mixed but survivable (+0.7/−38/−26%).
    vsaHtfAlignGate: true,
    vsaHtfHardAlignGate: true,
    // VSA sequence is a reversal setup; HTF sideways has no directional
    // context and was the weakest 10-year bucket (PF 0.71).
    vsaIntradayBlockHtfSideways: true,
    vsaIntradayBlockDailyChop: true,
    // Sequence scorer quality band: avoid weak tests and blow-off extremes.
    vsaMinConfidenceIntraday: 50,
    vsaMaxConfidenceIntraday: 69,
    vsaHtfCounterPenalty: 0.5,
    // Session filter OFF — London block removed
    vsaSessionFilter: false,
    // V3: require a stopping-volume climax followed by a named VSA test.
    vsaIntradayDetectorMode: "sequence",
  },
  Swing: {
    ...STANDARD_LEG_TYPE_OVERRIDES.Swing,
    vsaSessionFilter: false,
    vsaSwingLongOnly: true,
    // Keep opt-in until a Swing-specific WF proves the weekly counter-trend
    // gate does not collapse the already sparse leg to zero trades.
    vsaSwingHtfAlignGate: false,
    vsaMinConfidenceSwing: 70,
  },
});

/** Shared AF component geometry (no smc* — Wyckoff/VSA racers + SMC base). */
const AF_COMPONENT_BASE = {
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
  atrMultiplier: 1.5,
  riskReward:    2.0,
  atrMinMult:    0.8,
  atrMaxMult:    5.0,

  higherTf:      "4h",
  htfEmaFast:    9,
  htfEmaSlow:    21,
  sidewaysThresholdPct: 0.15,

  volSmaMultiplier: 1.0,

  riskPerTrade:        0.05,
  maxDailyLossPct:     0.03,
  maxTradesPerDay:     8,
  cooldownAfterLoss:   60,
  maxConsecLoss:       3,

  leverage:      3,
  interval:      "1h",
  checkInterval: 3_600_000,

  enabledComponents: ["Scalping", "Intraday", "Swing"],
  typeOverrides: { ...STANDARD_LEG_TYPE_OVERRIDES },

  trades:  "~3–8 trade/hari (1h eval)",
  winrate: "Target 52–60%",
  risk:    "Rendah-Sedang",
};

/** Shared TS component geometry (no Donchian/ADX/TF race flags). */
const TS_COMPONENT_BASE = {
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
  atrMultiplier: 1.5,
  riskReward:    2.0,
  atrMinMult:    0.5,
  atrMaxMult:    8.0,

  higherTf:      "1h",
  htfEmaFast:    9,
  htfEmaSlow:    21,
  sidewaysThresholdPct: 0.25,

  volSmaMultiplier: 1.0,

  riskPerTrade:        0.05,
  maxDailyLossPct:     0.06,
  maxTradesPerDay:     4,
  cooldownAfterLoss:   5,
  maxConsecLoss:       3,

  leverage:      2,
  interval:      "5m",
  checkInterval: 60_000,

  enabledComponents: ["Scalping", "Intraday", "Swing"],
  typeOverrides: { ...STANDARD_LEG_TYPE_OVERRIDES },

  trades:  "8-15 trade/hari",
  winrate: "~54-58%",
  risk:    "Sedang",
};

/** Shared MD component geometry (no BB/ADX/MR-specific knobs). */
const MD_COMPONENT_BASE = {
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
  atrMultiplier: 1.5,
  riskReward:    2.0,
  atrMinMult:    0.5,
  atrMaxMult:    6.0,

  higherTf:      "15m",
  htfEmaFast:    9,
  htfEmaSlow:    21,
  sidewaysThresholdPct: 0.3,

  volSmaMultiplier: 0.8,

  riskPerTrade:        0.05,
  maxDailyLossPct:     0.03,
  maxTradesPerDay:     3,
  cooldownAfterLoss:   15,
  maxConsecLoss:       2,

  leverage:      1.0,
  interval:      "15m",
  checkInterval: 60_000,

  enabledComponents: ["Scalping", "Intraday", "Swing"],
  typeOverrides: { ...STANDARD_LEG_TYPE_OVERRIDES },

  trades:  "5-15 trade/minggu",
  winrate: "~55-60%",
  risk:    "Rendah",
};

/** Shared BS component geometry (no breakout/retest BR-specific knobs). */
const BS_COMPONENT_BASE = {
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
  atrMultiplier: 1.5,
  riskReward:    3.0,
  atrMinMult:    0.2,
  atrMaxMult:    5.0,

  higherTf:      "4h",
  htfEmaFast:    9,
  htfEmaSlow:    21,
  sidewaysThresholdPct: 0.25,

  volSmaMultiplier: 1.0,

  riskPerTrade:        0.05,
  maxDailyLossPct:     0.08,
  maxTradesPerDay:     5,
  cooldownAfterLoss:   5,
  maxConsecLoss:       3,

  leverage:      1,
  interval:      "15m",
  checkInterval: 900_000,

  enabledComponents: ["Scalping", "Intraday", "Swing"],
  typeOverrides: { ...STANDARD_LEG_TYPE_OVERRIDES },

  trades:  "2-7 trade/hari",
  winrate: "~51-56%",
  risk:    "Sedang-Tinggi",
};

const STRATEGIES = {

  // ─────────────────────────────────────────────
  // TREND_FOLLOWING — Multi-TF Momentum (FORGE Tier)
  // ─────────────────────────────────────────────
  TREND_FOLLOWING: {
    name:          "TREND_FOLLOWING",
    label:         "Trend Momentum",
    description:   "Multi-TF MACD + RSI momentum. 3-layer confirmation (HTF/MTF/Entry).",

    emaFast:       9,
    emaSlow:       21,
    emaTrend:      50,

    rsiPeriod:     14,

    atrPeriod:     14,
    atrMultiplier: 1.5,
    riskReward:    2.0,
    atrMinMult:    0.5,
    atrMaxMult:    8.0,

    // A 4h regime is materially less noisy than 1h for the low-TF legs.
    // The middle layer remains 1h via the per-leg overrides below.
    higherTf:      "4h",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.25,

    volSmaMultiplier: 1.0,

    riskPerTrade:     0.05,
    maxDailyLossPct:  0.06,
    maxTradesPerDay:  4,
    cooldownAfterLoss: 5,
    maxConsecLoss:    3,

    tpMode:        "fixed",

    leverage:      2,
    interval:      "5m",
    checkInterval: 60000,

    grokConfirmMinEntry: 7,
    grokConfirmMinTp:    7,

    signalType:    "TREND_FOLLOWING",

    enabledComponents: ["Scalping", "Intraday", "Swing"],
    // Spread DEFAULT (incl. Scalping atrGateRelative) — do not hardcode absolute-only floors.
    typeOverrides: {
      ...STANDARD_LEG_TYPE_OVERRIDES,
      Scalping: {
        ...STANDARD_LEG_TYPE_OVERRIDES.Scalping,
        tsSessionFilter: false,
        // Edge repair: do not chase the breakout close. Wait for a causal
        // 1-ATR pullback into the breakout zone, then use a wider 2/4 ATR
        // geometry so 5m noise does not dominate the 4h trend signal.
        higherTf: "4h",
        tfMtfInterval: "1h",
        tfRequireStrongTrend: true,
        adxMinStrength: 30,
        retestEntryEnabled: true,
        retestPullbackAtr: 1.0,
        retestTtlBars: 12,
        slAtrMult: 2.0,
        tpAtrMult: 4.0,
        makerEntry: true,
      },
      Intraday: {
        ...STANDARD_LEG_TYPE_OVERRIDES.Intraday,
        // Same stack as Scalping, with a shallower retest and stricter ADX
        // because 15m entries otherwise admit too many late breakouts.
        higherTf: "4h",
        tfMtfInterval: "1h",
        tfRequireStrongTrend: true,
        adxMinStrength: 35,
        retestEntryEnabled: true,
        retestPullbackAtr: 0.5,
        retestTtlBars: 12,
        slAtrMult: 1.5,
        tpAtrMult: 3.0,
        makerEntry: true,
      },
      Swing: { ...STANDARD_LEG_TYPE_OVERRIDES.Swing, adxMinStrength: 20 },
    },

    // A retest fill is routed through the post-only/maker path in live mode;
    // the backtest uses the same maker fee schedule for the resting entry.
    entryMode:      "maker",

    adxMinStrength:    25,
    donchianPeriod:    20,
    htfRatio:          12,
    mtfRatio:          3,
    minVolRatio:       1.0,
    // Only the first close crossing of a Donchian channel is tradeable.
    // Set false only for a controlled ablation/backward-compatibility run.
    tfRequireFreshBreakout: true,
    // Causal MTF layer is enabled by default; set false only for an ablation.
    tfMtfLayerEnabled: true,
    // Optional candle-quality control; zero preserves the base breakout rule.
    tfMinBreakoutBodyAtr: 0,
    tfHtfLayerEnabled: true,

    tsCombinationMode: "race",
    tsUseStructureGate: false,
    tsUseVwapPrecision: false,
    vwapAtrMult: 0.5,

    trades:        "8-15 trade/hari",
    winrate:       "~54-58%",
    risk:          "Sedang",
  },

  // ─────────────────────────────────────────────
  // MEAN_REVERSION — BB Extremes (MINT Tier)
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
    atrMultiplier: 1.5,
    riskReward:    2.0,
    atrMinMult:    0.5,
    atrMaxMult:    6.0,

    higherTf:      "15m",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.3,

    volSmaMultiplier: 0.8,

    riskPerTrade:     0.05,
    maxDailyLossPct:  0.03,
    maxTradesPerDay:  3,
    cooldownAfterLoss: 15,
    maxConsecLoss:    2,

    leverage:      1.0,
    interval:      "15m",
    checkInterval: 60000,

    grokConfirmMinEntry: 8,
    grokConfirmMinTp:    7,

    signalType:    "MEAN_REVERSION",

    enabledComponents: ["Scalping", "Intraday", "Swing"],
    typeOverrides: {
      ...STANDARD_LEG_TYPE_OVERRIDES,
      Scalping: { ...STANDARD_LEG_TYPE_OVERRIDES.Scalping, mrSessionFilter: false },
    },

    bbPeriod:     20,
    minVolRatio:  0.7,
    bbStdDevA:    1.5,
    rsiOversoldA: 28,
    rsiOverboughtA: 72,
    bbStdDevB:    2.0,
    rsiOversoldB: 32,
    rsiOverboughtB: 68,
    mdAdxGateEnabled: true,
    mdObFvgEnabled:   true,
    mdAdxPeriod:      14,
    mdAdxBalanceMax:  20,
    mdAdxImbalanceMin: 25,
    mdAdxTransitionConfidenceMult: 0.75,
    mdConfluenceAtrMult: 0.5,
    mdNoConfluenceConfidenceMult: 0.7,
    mdWithConfluenceConfidenceBoost: 1.1,
    mdFvgScanBars:    30,
    mdFvgMinGapPct:   0.002,
    mdObLookback:     20,
    mdObDispMult:     1.5,

    trades:        "5-15 trade/minggu",
    winrate:       "~55-60%",
    risk:          "Rendah",
  },

  // ─────────────────────────────────────────────
  // BREAKOUT_RETEST — Breakout + Retest (VAULT Tier)
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
    atrMultiplier: 1.5,
    riskReward:    3.0,
    atrMinMult:    0.2,
    atrMaxMult:    5.0,

    higherTf:      "4h",
    htfEmaFast:    9,
    htfEmaSlow:    21,
    sidewaysThresholdPct: 0.25,

    volSmaMultiplier: 1.0,

    riskPerTrade:     0.05,
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

    enabledComponents: ["Scalping", "Intraday", "Swing"],
    typeOverrides: {
      ...STANDARD_LEG_TYPE_OVERRIDES,
      Scalping: { ...STANDARD_LEG_TYPE_OVERRIDES.Scalping, brSessionFilter: false },
    },

    lookbackBars:          20,
    volumeMultiplier:      1.5,
    maxVolumeRatio:        3.55,
    retestWindow:          96,
    minRetestBars:         16,
    minRejectionWickRatio: 0.5,
    minRetestDepthAtr:     0.17,
    maxRetestDepthAtr:     0.72,
    minDisplacementAtr:    0.30,
    blockedMarketConds:    ["COILED_BREAKOUT", "SQUEEZE_BREAKOUT", "DRY_SQUEEZE"],
    bbPeriod:              20,
    bbStdDev:              2.0,
    squeezeLookback:       10,
    squeezeThreshold:      0.75,
    minBbWidthPct:         0.0076,
    minAtrPct:             0.25,
    requireConsolidation:  true,
    preferredTpMode:       "full",
    minSlAtrFloor:         1.5,
    maxPlannedRR:          2.5,

    trades:        "2-7 trade/hari",
    winrate:       "~51-56%",
    risk:          "Sedang-Tinggi",
  },

  // ─────────────────────────────────────────────
  // GROK_AI_TRADING — Experimental / VAULT bonus
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

    riskPerTrade:        0.05,
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
  // SMART_MONEY_CONCEPTS — SMC v3.0 engine (all smc* SSOT)
  // FE Advance defaultParamsFor MUST mirror these geometry knobs
  // (ablation CLI does not override — see scripts/dataset-expand).
  // ─────────────────────────────────────────────
  SMART_MONEY_CONCEPTS: {
    ...AF_COMPONENT_BASE,
    name:          "SMART_MONEY_CONCEPTS",
    label:         "Smart Money Concepts",
    description:   "3-komponen SMC: Sweep+OB+CVD (scalping), CHoCH+OB+trend (intraday), FVG+displacement (swing). Blok entry berlawanan HTF.",

    smcMinVotes:           1,
    smcMinAggregateConfidence: 0,
    smcMinConfidenceScalping: 60,
    smcMinConfidenceIntraday: 60,
    smcMinConfidenceSwing:    60,
    smcMinConfidenceA:     60,
    smcMinConfidenceB:     60,
    smcMinConfidenceC:     60,

    smcUseSequenceEngine: true,
    smcSeqWindow:      60,

    smcSwingLookback:  5,
    smcSweepScanBars:  50,
    smcSweepVolMult:   0.9,

    smcOBLookback:     15,
    smcOBDispMult:     1.3,

    smcChochLookback:  20,

    smcFvgMinGap:      0.0015,
    smcFvgScanBars:    40,

    smcDispScanBars:   25,
    smcDispVolMult:    1.8,
    smcDispRangePct:   0.008,

    vwapLookback:      14,

    signalType:    "SMART_MONEY_CONCEPTS",

    enabledComponents: ["Scalping", "Intraday", "Swing"],
    typeOverrides: { ...SMC_LEG_TYPE_OVERRIDES },
  },
};

// ─── Umbrella aliases (race flags only — no smc* / leg geometry) ─────────────
STRATEGIES.ADAPTIVE_FUSION = {
  name: "ADAPTIVE_FUSION",
  label: "Adaptive Fusion",
  description: "Umbrella: SMART_MONEY_CONCEPTS + Wyckoff + VSA race-to-confirm.",
  afCombinationMode: "race",
  afEnabledComponents: ["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"],
};
STRATEGIES.TREND_SURGE = {
  name: "TREND_SURGE",
  label: "Trend Surge",
  description: "Umbrella: TREND_FOLLOWING + Dow Theory + AMT race-to-confirm.",
  tsCombinationMode: "race",
};
STRATEGIES.MEAN_DRIFT = {
  name: "MEAN_DRIFT",
  label: "Mean Drift",
  description: "Umbrella: Mean Reversion + Supply/Demand + Stat Arb race-to-confirm.",
  mdCombinationMode: "race",
};
STRATEGIES.BREAKOUT_STORM = {
  name: "BREAKOUT_STORM",
  label: "Breakout Storm",
  description: "Umbrella: Breakout + ICT + Liquidation/Squeeze race-to-confirm.",
  bsCombinationMode: "race",
};

// ─── Component keys — tier COMPONENT_BASE + component-specific knobs ─────────
STRATEGIES.WYCKOFF = {
  ...AF_COMPONENT_BASE,
  name: "WYCKOFF",
  label: "Wyckoff Method",
  signalType: "SMART_MONEY_CONCEPTS",

  minBars: 100,
  lookback: 100,
  volMultiplier: 1.5,
  climaxVolExtra: 0.5,
  zigzagLength: 4,
  springLookback: 20,
  climaxLookback: 30,
  psLookback: 50,
  avgRangePeriod: 20,
  bbPeriod: 20,
  bbStdDev: 2,
  bbWidthLookback: 100,
  bbWidthMeanMult: 0.98,
  bbWidthPercentileMax: 40,
  rangeLookback: 20,
  minRangeWidthPct: 0.005,
  maxRangeWidthPct: 0.045,
  minBarsInRange: 20,
  penetrationAtrMult: 0.85,
  minPenetrationAtrMult: 0.2,
  recoveryWindow: 5,
  volumeConfirmMult: 1.25,
  volumeSmaPeriod: 20,
  cooldownBars: 4,
  entryModel: "balanced",
  priorTrendBars: 40,
  priorTrendMinSlopePct: 0.01,
  rejectionWickRatio: 0.45,
  chochLookback: 12,
  minRr: 2.0,
  maxEntryProximityPct: 0.35,
  eventScanBars: 80,
  requireReclaimOnLastBar: true,
  requireHtfAlign: true,
  allowHtfSideways: true,
  sidewaysShortOnly: true,
  allowHtfSidewaysLong: false,
  longVolumeConfirmMult: 1.45,
  shortVolumeConfirmMult: 1.2,
  minSlAtrMult: 0.9,
  // Development recalibration (2026-09-25): the prior 12m fit used 11% combined
  // risk and forced every leg short. That was not robust on the 9y BTC spot tape:
  // fast-leg losses compounded while the low-R partial bank paid fees. Keep the
  // type ladder, but use a survivable 3% combined cap and a 3% daily loss stop.
  riskPerTrade: 0.03,
  typeRiskWeights: { Scalping: 2.0, Intraday: 3.0, Swing: 0.5 },
  riskSizingBasis: "initial",
  maxDailyLossPct: 0.03,
  maxTradesPerDay: 40,
  atrMinMult: 0.32,
  atrMaxMult: 5.0,
  atrGateRelative: false,
  typeOverrides: {
    ...STANDARD_LEG_TYPE_OVERRIDES,
    // 5m two-sided — 50% @ 1R, 25% @ 2R, runner to the planned 2R TP.
    Scalping: {
      ...STANDARD_LEG_TYPE_OVERRIDES.Scalping,
      tradeType: "Scalping",
      wyckoffSessionFilter: false,
      entryModel: "balanced",
      scalpPatternMode: "ut_and_lpsy",
      atrMinMult: 0.08,
      atrGateRelative: true,
      atrRelMin: 0.30,
      atrRelMax: 3.2,
      volumeConfirmMult: 1.05,
      shortVolumeConfirmMult: 1.05,
      longVolumeConfirmMult: 1.2,
      blockLong: false,
      allowLpsyFlexPrior: true,
      cooldownBars: 0,
      recoveryWindow: 4,
      bbWidthMeanMult: 1.1,
      minBarsInRange: 6,
      minRr: 2.0,
      sidewaysShortOnly: true,
      allowHtfSideways: false,
      allowHtfSidewaysLong: false,
      requireHtfAlign: true,
      // Development session guard from the long tape: keep UTC 01, 08–09 and
      // 12–14, where this leg has the best fee-adjusted follow-through.
      blockedUtcHours: [0, 2, 3, 4, 5, 6, 7, 10, 11, 15, 16, 17, 18, 19, 20, 21, 22, 23],
      makerEntry: true,
      minSlPct: 0.01,
      minSlPctMode: "floor",
      minSlAtrMult: 1.2,
      slAtrMult: SCALP_GEOMETRY.slAtrMult,
      tpAtrMult: SCALP_GEOMETRY.tpAtrMult,
      tpMode: "partial",
      slPlusPartial1Pct: 0.5,
      slPlusPartial2Pct: 0.25,
      slPlusM1R: 1.0,
      slPlusM2R: 2.0,
      slPlusBeOffsetR: 0.25,
      cooldownAfterLoss: 15,
      maxConsecLoss: 3,
    },
    // 15m two-sided — 50% @ 1R, 25% @ 2R, runner to the planned 2.2R TP.
    Intraday: {
      ...STANDARD_LEG_TYPE_OVERRIDES.Intraday,
      entryModel: "balanced",
      atrMinMult: 0.34,
      atrGateRelative: false,
      volumeConfirmMult: 1.15,
      shortVolumeConfirmMult: 1.15,
      longVolumeConfirmMult: 1.3,
      // 15m LONG remains shelved until it proves positive in walk-forward;
      // the long-history tape shows a materially worse loss profile than SHORT.
      blockLong: true,
      allowLpsyFlexPrior: true,
      wyckoffRequireStrongTrend: true,
      cooldownBars: 1,
      minRr: 2.0,
      sidewaysShortOnly: true,
      // Continuation signals must agree with a directional 1h context; the
      // old sideways exception produced a large fee-heavy Intraday bleed.
      allowHtfSideways: false,
      allowHtfSidewaysLong: false,
      blockedUtcHours: [3, 8, 9, 12, 13, 16, 17, 19, 22],
      slAtrMult: 1.0,
      tpAtrMult: 2.2,
      minSlAtrMult: 0.9,
      makerEntry: true,
      tpMode: "partial",
      slPlusPartial1Pct: 0.5,
      slPlusPartial2Pct: 0.25,
      slPlusM1R: 1.0,
      slPlusM2R: 2.0,
      slPlusBeOffsetR: 0.25,
      cooldownAfterLoss: 15,
      maxConsecLoss: 3,
    },
    // 4h volume leg: 50% @ 1R, 25% @ 1.5R, runner to the planned ~1.8R TP.
    Swing: {
      ...STANDARD_LEG_TYPE_OVERRIDES.Swing,
      entryModel: "aggressive",
      requireHtfAlign: true,
      atrMinMult: 0.05,
      atrGateRelative: true,
      atrRelMin: 0.4,
      atrRelMax: 4.0,
      volumeConfirmMult: 0.6,
      shortVolumeConfirmMult: 0.6,
      longVolumeConfirmMult: 1.2,
      blockLong: false,
      blockShort: false,
      wyckoffSwingShelved: false,
      cooldownBars: 0,
      recoveryWindow: 16,
      minBarsInRange: 2,
      bbWidthMeanMult: 1.5,
      minRr: 1.6,
      minRangeWidthPct: 0.001,
      maxRangeWidthPct: 0.15,
      requireReclaimOnLastBar: false,
      sidewaysShortOnly: false,
      allowHtfSideways: false,
      allowHtfSidewaysLong: false,
      wyckoffRequireStrongTrend: true,
      blockedUtcHours: [8, 12],
      slAtrMult: 1.2,
      tpAtrMult: 2.2,
      minSlAtrMult: 1.0,
      makerEntry: true,
      tpMode: "partial",
      slPlusPartial1Pct: 0.5,
      slPlusPartial2Pct: 0.25,
      slPlusM1R: 1.0,
      slPlusM2R: 1.5,
      slPlusBeOffsetR: 0.25,
      riskMult: 0.25,
      cooldownAfterLoss: 0,
      maxConsecLoss: 3,
    },
  },
};
STRATEGIES.VOLUME_SPREAD_ANALYSIS = {
  ...AF_COMPONENT_BASE,
  name: "VOLUME_SPREAD_ANALYSIS",
  label: "Volume Spread Analysis",
  signalType: "SMART_MONEY_CONCEPTS",
  typeOverrides: { ...VSA_LEG_TYPE_OVERRIDES },

  minBars: 20,
  volumeSmaPeriod: 20,
  wideSpreadMult: 1.3,
  narrowSpreadMult: 0.7,
  lowRelVol: 0.7,
  highRelVol: 1.5,
  mismatchSpreadMult: 0.5,
  swingRadius: 5,
  swingLeftLook: 5,
  swingScanBars: 50,
  mismatchConfidencePenalty: 0.25,
};
STRATEGIES.MARKET_STRUCTURE = {
  ...TS_COMPONENT_BASE,
  name: "MARKET_STRUCTURE",
  label: "Dow Theory",
  signalType: "TREND_FOLLOWING",

  leftLook: 2,
  rightLook: 2,
  scanBars: 80,
  minSwingPairs: 2,
  entryPullbackPct: 0.35,
  entryAtrMult: 0.75,
  // DOW is a trend-following pullback model: do not enter while the
  // configured HTF is SIDEWAYS, and require the entry candle to retest HL/LH.
  msAllowHtfSideways: false,
  msRequireLevelRetest: true,
  msLevelTouchAtrMult: 0.5,
  // A newly confirmed fractal is not yet a mature continuation setup. The
  // Intraday leg waits one additional closed HTF bar after confirmation and
  // requires entry-TF trend acceptance. Values remain per-leg so research can
  // ablate them without changing the shared DOW component contract.
  msMinBarsAfterConfirmation: 0,
  msRequireLocalTrendAlignment: false,
  msLocalTrendSlopeLookback: 1,
  msUseStructureStop: false,
  msStructureBufferAtr: 0.25,
  msMinStopAtr: 0.75,
  msMaxStopAtr: 2.5,
  typeOverrides: {
    ...STANDARD_LEG_TYPE_OVERRIDES,
    Scalping: {
      ...STANDARD_LEG_TYPE_OVERRIDES.Scalping,
      msSessionFilter: false,
      msAllowHtfSideways: false,
      msRequireLevelRetest: true,
      // Full-tape research shows negative gross expectancy before fees; keep
      // DOW Scalping out of live/backtest defaults until a separate 5m edge is
      // proven. Override msEnabled=true only for controlled research runs.
      msEnabled: false,
    },
    Intraday: {
      ...STANDARD_LEG_TYPE_OVERRIDES.Intraday,
      msAllowHtfSideways: false,
      msRequireLevelRetest: true,
      msMinBarsAfterConfirmation: 1,
      msRequireLocalTrendAlignment: true,
      msLocalTrendSlopeLookback: 2,
      msUseStructureStop: true,
      msStructureBufferAtr: 0.25,
      msMinStopAtr: 0.75,
      msMaxStopAtr: 2.5,
    },
    Swing: {
      ...STANDARD_LEG_TYPE_OVERRIDES.Swing,
      msAllowHtfSideways: false,
      msRequireLevelRetest: true,
    },
  },
};
STRATEGIES.AUCTION_MARKET_THEORY = {
  ...TS_COMPONENT_BASE,
  name: "AUCTION_MARKET_THEORY",
  label: "Auction Market Theory",
  signalType: "TREND_FOLLOWING",

  bins: 20,
  valueAreaPct: 0.7,
  vwapAtrMult: 0.5,
  vwapTolerancePct: 0.005,
  minSessionBars: 20,
  minSessionBarsSwing: 6,
  // A VWAP cross is only tradeable after closed-candle acceptance. These
  // guards remove one-bar level touches/churn from all AMT entry paths.
  // The planned reward must also clear a conservative round-trip cost multiple
  // in both backtest and live execution.
  minEdgeFeeMultiple: 5,
  amtEntryQualityGate: true,
  amtHtfAlignGate: true,
  amtMinBodyAtr: 0.15,
  amtMinVolumeRatio: 0.8,
  amtMinVwapDistanceAtr: 0.1,
  amtEdgeAtrMult: 0.25,
  // A valid auction edge must be swept, not merely approached. VAH fades are
  // opt-in until a dedicated failed-auction detector is available.
  amtEdgePenetrationAtr: 0.1,
  amtVahRejectEnabled: false,
  // AMT Scalping is temporarily hidden across backtest, dry-run, and live.
  amtScalpingShelved: true,
  typeOverrides: {
    ...STANDARD_LEG_TYPE_OVERRIDES,
    Scalping: {
      ...STANDARD_LEG_TYPE_OVERRIDES.Scalping,
      amtSessionFilter: false,
      amtScalpingShelved: true,
      // BTC 5m AMT is fee-bound below this volatility floor; keep one
      // auction attempt per UTC day instead of recycling the same session.
      atrMinMult: 0.75,
      maxTradesPerDay: 1,
      amtMinBodyAtr: 0.2,
      amtMinVolumeRatio: 1.0,
    },
    Intraday: {
      ...STANDARD_LEG_TYPE_OVERRIDES.Intraday,
      // The 15m edge needs enough range to pay Binance round-trip friction.
      atrMinMult: 0.6,
      maxTradesPerDay: 1,
      amtMinBodyAtr: 0.15,
      amtMinVolumeRatio: 0.9,
    },
    Swing: {
      ...STANDARD_LEG_TYPE_OVERRIDES.Swing,
      maxTradesPerDay: 1,
      // Keep the empirically stable half-week context floor. A six-bar
      // fallback admits too many early-week profiles and is fee-negative on
      // the long-history BTC replay.
      minSessionBars: 20,
      // Weekly AMT needs a real displacement candle; low-body 4h touches were
      // mostly fee drag and did not separate acceptance from noise.
      amtMinBodyAtr: 1.0,
      amtMinVolumeRatio: 0.8,
    },
  },
};
STRATEGIES.SUPPLY_AND_DEMAND = {
  ...MD_COMPONENT_BASE,
  name: "SUPPLY_AND_DEMAND",
  label: "Supply and Demand",
  signalType: "MEAN_REVERSION",

  mdSdConfluenceAtrMult: 0.75,
  mdSdVolConfirmMult: 0.9,
  mdSdBaseConfidence: 0.62,
  mdSdZoneBoost: 0.18,
  mdSdVolBoost: 0.1,
  mdSdScanBars: 40,
  mdSdFvgMinGapPct: 0.0015,
  mdSdObLookback: 25,
  mdSdObDispMult: 1.3,
  minReversalBodyPct: 0.35,
  typeOverrides: {
    ...STANDARD_LEG_TYPE_OVERRIDES,
    Scalping: { ...STANDARD_LEG_TYPE_OVERRIDES.Scalping, sdSessionFilter: false },
  },
};
STRATEGIES.STATISTICAL_ARBITRAGE = {
  ...MD_COMPONENT_BASE,
  name: "STATISTICAL_ARBITRAGE",
  label: "Statistical Arbitrage",
  signalType: "MEAN_REVERSION",

  mdSaLookback: 40,
  mdSaEntryZ: 2.0, // Gelombang 2: band 2.0–2.5σ (post-patch analysis sweet spot)
  mdSaEntryZMax: 2.5, // Gelombang 1: cap |z| — 2.5+σ = breakout/momentum, not revert
  mdSaExitZ: 0.4,
  mdSaMinBars: 50,
  mdSaBaseConfidence: 0.58,
  mdSaZBoostPerUnit: 0, // Gelombang 1: flat confidence — zBoost anti-predictive on swing
  mdSaMaxConfidence: 0.95,
  mdSaUseVwapBlend: true,
  mdSaSkipHtfSideways: true, // REGIME_GATE: skip HTF 1w SIDEWAYS whipsaw
  // Legacy name mdSaHtfAlignGate — REGIME_GATE sideways skip (NOT directional align).
  // Prefer mdSaHtfRegimeGate; both alias the same behaviour in statisticalArbitrageEntry.
  mdSaHtfAlignGate: true,
  mdSaHtfRegimeGate: true,
  mdSaUseBenchmarkResidual: true, // Gelombang 2 #4: BTC-residual z when btcCloses wired
  mdSaExitAtMean: true, // Gelombang 2 #5: exit when |z| <= mdSaExitZ
  mdSaRequireTransitionRegime: true, // Sprint 20: SA Swing edge in daily TRANSITION band only
  typeOverrides: {
    ...STANDARD_LEG_TYPE_OVERRIDES,
    Scalping: { ...STANDARD_LEG_TYPE_OVERRIDES.Scalping, saSessionFilter: false },
  },
};
STRATEGIES.ICT_STYLE_TRADING = {
  ...BS_COMPONENT_BASE,
  name: "ICT_STYLE_TRADING",
  label: "ICT-style trading",
  signalType: "BREAKOUT_RETEST",

  bsIctSessionLookback: 20,
  bsIctVolumeMult: 1.25,
  bsIctRaidConfirmBars: 1,
  bsIctBaseConfidence: 0.7,
  bsIctOutsideKzConfidence: 0.45,
  bsIctRequireKillZone: false,
  bsIctMinWickBeyondPct: 0.0005,
  typeOverrides: {
    ...STANDARD_LEG_TYPE_OVERRIDES,
    Scalping: { ...STANDARD_LEG_TYPE_OVERRIDES.Scalping, ictSessionFilter: false },
  },
};
STRATEGIES.LIQUIDATION_SQUEEZE = {
  ...BS_COMPONENT_BASE,
  name: "LIQUIDATION_SQUEEZE",
  label: "Liquidation/Squeeze Trading",
  signalType: "BREAKOUT_RETEST",

  bsLsOiLookback: 20,
  bsLsExtremeFundingLong: 0.0005,
  bsLsExtremeFundingShort: -0.0005,
  bsLsOiChangeConfirmPct: 1.0,
  bsLsWickLookback: 20,
  bsLsWickVolMult: 1.2,
  bsLsMinWickBodyRatio: 1.5,
  bsLsBaseConfidence: 0.55,
  bsLsFundingBoost: 0.2,
  bsLsOiBoost: 0.15,
  bsLsDisplacementOnlyConfidence: 0.5,
  bsLsMaxConfidence: 0.92,
  typeOverrides: {
    ...STANDARD_LEG_TYPE_OVERRIDES,
    Scalping: { ...STANDARD_LEG_TYPE_OVERRIDES.Scalping, lsSessionFilter: false },
  },
};

const DEFAULT_STRATEGY_KEY = "SMART_MONEY_CONCEPTS";

/** Merge canonical engine defaults with umbrella-only overrides when key is an alias. */
function resolveStrategyDefaults(strategyKey) {
  const raw = String(strategyKey || DEFAULT_STRATEGY_KEY).toUpperCase();
  const canonical = normalizeStrategyKey(raw);
  const engine = STRATEGIES[canonical] || STRATEGIES[DEFAULT_STRATEGY_KEY];
  const htfMode = getHtfMode(canonical);
  if (raw !== canonical && STRATEGIES[raw]) {
    return { ...engine, ...STRATEGIES[raw], htfMode };
  }
  return { ...engine, htfMode };
}

function getStrategy(overrideKey = null) {
  return resolveStrategyDefaults(overrideKey);
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

module.exports = {
  getStrategy,
  resolveStrategyDefaults,
  listStrategies,
  STRATEGIES,
  AF_COMPONENT_BASE,
  TS_COMPONENT_BASE,
  MD_COMPONENT_BASE,
  BS_COMPONENT_BASE,
  DEFAULT_LEG_TYPE_OVERRIDES,
  SCALP_GEOMETRY,
  INTRADAY_HOLD,
  SWING_HOLD,
  STANDARD_LEG_TYPE_OVERRIDES,
  SMC_LEG_TYPE_OVERRIDES,
  VSA_LEG_TYPE_OVERRIDES,
  DEFAULT_STRATEGY_KEY,
};
