// ─────────────────────────────────────────────
// strategyDefaults.js — strategy engine presets (STRATEGIES SSOT)
//
// Per-strategy leg tuning lives in typeOverrides (Scalping / Intraday / Swing).
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

/** Per-leg ATR% floor — calibrated to 5m / 15m / 4h entry stacks (backtest merge). */
const DEFAULT_LEG_TYPE_OVERRIDES = Object.freeze({
  Scalping: { atrMinMult: 0.15 },
  Intraday: { atrMinMult: 0.4 },
  Swing:    { atrMinMult: 0.8 },
});

/** SMC-only leg overrides (confidence floors stay on SMART_MONEY_CONCEPTS only). */
const SMC_LEG_TYPE_OVERRIDES = Object.freeze({
  Scalping: { atrMinMult: 0.15 },
  Intraday: { atrMinMult: 0.4, smcMinConfidenceIntraday: 55, smcMinConfidenceB: 55 },
  Swing:    { atrMinMult: 0.8 },
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

  riskPerTrade:        0.01,
  maxDailyLossPct:     0.03,
  maxTradesPerDay:     8,
  cooldownAfterLoss:   60,
  maxConsecLoss:       3,

  leverage:      3,
  interval:      "1h",
  checkInterval: 3_600_000,

  enabledComponents: ["Scalping", "Intraday", "Swing"],
  typeOverrides: { ...DEFAULT_LEG_TYPE_OVERRIDES },

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

  riskPerTrade:        0.01,
  maxDailyLossPct:     0.06,
  maxTradesPerDay:     4,
  cooldownAfterLoss:   5,
  maxConsecLoss:       3,

  leverage:      2,
  interval:      "5m",
  checkInterval: 60_000,

  enabledComponents: ["Scalping", "Intraday", "Swing"],
  typeOverrides: { ...DEFAULT_LEG_TYPE_OVERRIDES },

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

  riskPerTrade:        0.01,
  maxDailyLossPct:     0.03,
  maxTradesPerDay:     3,
  cooldownAfterLoss:   15,
  maxConsecLoss:       2,

  leverage:      1.0,
  interval:      "15m",
  checkInterval: 60_000,

  enabledComponents: ["Scalping", "Intraday", "Swing"],
  typeOverrides: { ...DEFAULT_LEG_TYPE_OVERRIDES },

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

  riskPerTrade:        0.01,
  maxDailyLossPct:     0.08,
  maxTradesPerDay:     5,
  cooldownAfterLoss:   5,
  maxConsecLoss:       3,

  leverage:      1,
  interval:      "15m",
  checkInterval: 900_000,

  enabledComponents: ["Scalping", "Intraday", "Swing"],
  typeOverrides: { ...DEFAULT_LEG_TYPE_OVERRIDES },

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

    riskPerTrade:     0.01,
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
    typeOverrides: {
      Scalping: { atrMinMult: 0.15 },
      Intraday: { atrMinMult: 0.4 },
      Swing:    { atrMinMult: 0.8, adxMinStrength: 20 },
    },

    adxMinStrength:    25,
    donchianPeriod:    20,
    htfRatio:          12,
    mtfRatio:          3,
    minVolRatio:       1.0,
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

    riskPerTrade:     0.01,
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
    typeOverrides: { ...DEFAULT_LEG_TYPE_OVERRIDES },

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

    enabledComponents: ["Scalping", "Intraday", "Swing"],
    typeOverrides: { ...DEFAULT_LEG_TYPE_OVERRIDES },

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
  // SMART_MONEY_CONCEPTS — SMC v3.0 engine (all smc* SSOT)
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
  afUseThreeComponentVoting: true,
  afMinVotes: 2,
  afRejectOnDissent: true,
  afEnabledComponents: ["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"],
};
STRATEGIES.TREND_SURGE = {
  name: "TREND_SURGE",
  label: "Trend Surge",
  description: "Umbrella: TREND_FOLLOWING + Dow Theory + AMT race-to-confirm.",
  tsCombinationMode: "race",
  tsUseStructureGate: false,
  tsUseVwapPrecision: false,
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
  bbWidthMeanMult: 1.05,
  bbWidthPercentileMax: 40,
  rangeLookback: 20,
  minRangeWidthPct: 0.005,
  maxRangeWidthPct: 0.05,
  minBarsInRange: 20,
  penetrationAtrMult: 0.8,
  recoveryWindow: 5,
  volumeConfirmMult: 1.0,
  volumeSmaPeriod: 20,
  cooldownBars: 5,
  entryModel: "aggressive",
  priorTrendBars: 40,
  priorTrendMinSlopePct: 0.01,
  rejectionWickRatio: 0.45,
  chochLookback: 12,
  minRr: 2.0,
  maxEntryProximityPct: 0.35,
  eventScanBars: 80,
};
STRATEGIES.VOLUME_SPREAD_ANALYSIS = {
  ...AF_COMPONENT_BASE,
  name: "VOLUME_SPREAD_ANALYSIS",
  label: "Volume Spread Analysis",
  signalType: "SMART_MONEY_CONCEPTS",

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
};
STRATEGIES.STATISTICAL_ARBITRAGE = {
  ...MD_COMPONENT_BASE,
  name: "STATISTICAL_ARBITRAGE",
  label: "Statistical Arbitrage",
  signalType: "MEAN_REVERSION",

  mdSaLookback: 40,
  mdSaEntryZ: 1.6,
  mdSaExitZ: 0.4,
  mdSaMinBars: 50,
  mdSaBaseConfidence: 0.58,
  mdSaZBoostPerUnit: 0.12,
  mdSaMaxConfidence: 0.95,
  mdSaUseVwapBlend: true,
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
};

const DEFAULT_STRATEGY_KEY = "SMART_MONEY_CONCEPTS";

/** Merge canonical engine defaults with umbrella-only overrides when key is an alias. */
function resolveStrategyDefaults(strategyKey) {
  const raw = String(strategyKey || DEFAULT_STRATEGY_KEY).toUpperCase();
  const canonical = normalizeStrategyKey(raw);
  const engine = STRATEGIES[canonical] || STRATEGIES[DEFAULT_STRATEGY_KEY];
  if (raw !== canonical && STRATEGIES[raw]) {
    return { ...engine, ...STRATEGIES[raw] };
  }
  return engine;
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
  DEFAULT_STRATEGY_KEY,
};
