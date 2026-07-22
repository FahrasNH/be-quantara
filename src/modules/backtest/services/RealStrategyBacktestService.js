/**
 * RealStrategyBacktestService.js — Server-side 1:1 backtest engine.
 *
 * Replays historical candles through the REAL strategy classes
 * (AdaptiveFusionStrategy.detectSignal / calculateRiskConfig) + the REAL HTF
 * trend filter (detectHTFTrend) + the REAL risk gates, mirroring the decision
 * path of AdaptiveStrategyEngine._tick() / BotEngine._checkRiskGates().
 *
 * WHY: the legacy backtest ran a SIMPLIFIED re-implementation in the browser
 * (fe/src/engine/strategyBacktest.js) that drifted from live — different voting
 * logic, only an HTF *strength* gate (no directional block), flat SL/TP (not
 * component-aware), an EMA-reversal "Signal" exit that live does NOT have, and
 * single-timeframe (no 15m-entry + 1h-HTF layering). This engine removes that
 * drift by calling the same code live uses.
 *
 * Intentionally EXCLUDED (live-execution concerns, not strategy decisions —
 * they don't change which trades the strategy takes):
 *   - live ticker price / stale-signal guard (backtest fills at candle close)
 *   - signal idempotency cache (only matters for the 15-min live tick cache)
 *   - group coordinator / cross-bot account gates
 *   - exchange min-lot / margin-budget feasibility
 *
 * Exit model mirrors live AF: SL or TP only (intrabar high/low, SL checked
 * first = conservative). No opposite-signal exit.
 */

const fs = require("fs");
const path = require("path");
const { calcIndicators, detectHTFTrend, calcEMA, calcATR, calcRSI, calcSMA, calcADX } = require("../../../core/analytics-engine/indicators");
const { strategyRegistry } = require("../../../core/strategy-engine/index");
const { STRATEGIES, resolveStrategyDefaults } = require("#config/strategyDefaults.js");
const { normalizeSmcParams } = require("../../../core/strategy-engine/af/smcParamCompat");
const { meanReversionRegimeFilter } = require("../../../core/signal-engine/htfRegimeFilter");
const { computeStatisticalArbitrageZ } = require("../../../core/strategy-engine/md/statisticalArbitrageEntry");
const { riskShareForType } = require("../../../core/risk-engine/typeRiskLadder");
const { buildAtrBaseline, checkNoTradeSessionGate } = require("../../../core/risk-engine/entryRiskGates");
const { computeDailyTrendStrength, getRegimeForDate, applyRegimeGate } = require("../../../core/signal-engine/dailyRegimeGate");
const {
  resolveScalpingGateFlags,
  resolveSwingGateFlags,
  buildSmcEntryFeatures,
  applySmcSideRegimeGate,
  applySmcFundingGuard,
  buildCostModelMeta,
  holdHoursBetween,
} = require("../../../core/strategy-engine/af/smcEntry");
const {
  initPositionExcursions,
  updatePositionExcursions,
  computeExcursionFields,
} = require("../../../shared/backtest/tradeExcursion");
const { buildBacktestEntryContext } = require("../../analytics/domain/engineTradeMlAdapter");
const { resolveEntryReasons } = require("../../../server/services/csv/strategyReasonFormatters");
const { resolveFeeSchedule } = require("../../../shared/constants/exchangeFeeSchedules");
const { normalizeStrategyKey } = require("../../../config/strategyKeyNormalizer");

const TRADE_LEG_NAMES = new Set(["Scalping", "Intraday", "Swing", "A", "B", "C"]);
const LEG_ABC = Object.freeze({ A: "Scalping", B: "Intraday", C: "Swing" });

/** Resolve Scalping/Intraday/Swing for typeOverrides (TIME_STOP, fees). position.component is the winning racer key, not the leg. */
function resolvePositionTradeLeg(position, cfg = {}) {
  return position?.tradeType
    || position?.entryMeta?.tradeType
    || (TRADE_LEG_NAMES.has(position?.entryMeta?.component) ? position.entryMeta.component : null)
    || cfg.tradeType
    || LEG_ABC[position?.component]
    || (TRADE_LEG_NAMES.has(position?.component) ? position.component : null);
}

/** Coerce indicator snapshots to a finite scalar (reject arrays / absurd values). */
function scalarIndicator(v, { min = -Infinity, max = Infinity } = {}) {
  if (v == null || v === "") return null;
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) {
      const n = Number(v[i]);
      if (Number.isFinite(n) && n >= min && n <= max) return n;
    }
    return null;
  }
  if (typeof v === "object") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

// Strategy-key checks normalize ingress aliases via ACL — FE may send Gen2 component keys.
const MR_COMPONENTS = new Set(["MEAN_REVERSION", "SUPPLY_AND_DEMAND", "STATISTICAL_ARBITRAGE"]);
const BR_COMPONENTS = new Set(["BREAKOUT_RETEST", "ICT_STYLE_TRADING", "LIQUIDATION_SQUEEZE"]);
const TF_COMPONENTS = new Set(["TREND_FOLLOWING", "MARKET_STRUCTURE", "AUCTION_MARKET_THEORY"]);
const SMC_COMPONENTS = new Set(["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"]);

const isMRKey = (k) => {
  const n = normalizeStrategyKey(String(k || "").toUpperCase());
  return MR_COMPONENTS.has(n)
    || ["SUPPLY_AND_DEMAND", "STATISTICAL_ARBITRAGE"].includes(String(k || "").toUpperCase());
};
const isBRKey = (k) => {
  const u = String(k || "").toUpperCase();
  const n = normalizeStrategyKey(u);
  return BR_COMPONENTS.has(n)
    || ["BREAKOUT_TRADING", "ICT", "LIQUIDATION_SQUEEZE"].includes(u);
};
const isTFKey = (k) => TF_COMPONENTS.has(normalizeStrategyKey(String(k || "").toUpperCase()));
const isSmcKey = (k) => {
  const n = normalizeStrategyKey(String(k || "").toUpperCase());
  return SMC_COMPONENTS.has(n) || n === "ADAPTIVE_FUSION";
};

const isSaKey = (k) => String(k || "").toUpperCase() === "STATISTICAL_ARBITRAGE";

/** Align benchmark (BTC) closes to entry-TF bar timestamps for SA residual z-score. */
function alignBenchmarkCloses(entryCandles, benchmarkCandles) {
  if (!Array.isArray(entryCandles) || !Array.isArray(benchmarkCandles) || !benchmarkCandles.length) {
    return null;
  }
  const byTs = new Map();
  for (const c of benchmarkCandles) byTs.set(c.timestamp, c.close);
  return entryCandles.map((c) => {
    const v = byTs.get(c.timestamp);
    return v == null ? null : v;
  });
}

/**
 * Deep-merge per-leg typeOverrides so a partial/empty client payload cannot
 * wipe SSOT knobs (atrGateRelative, atrMinMult, conf floors, …).
 *
 * Shallow `{ ...base, ...opts }` replaces the whole typeOverrides object —
 * dataset-expand used to send `{ Scalping: {} }` and FE Advance sends
 * `typeOverrides: {}`, both of which deleted Scalping.atrGateRelative and
 * fell back to absolute atrMinMult=0.8 → 100% ATR gate rejects on real 5m.
 */
function mergeTypeOverrides(baseOv, overrideOv) {
  const base = (baseOv && typeof baseOv === "object" && !Array.isArray(baseOv)) ? baseOv : {};
  if (!overrideOv || typeof overrideOv !== "object" || Array.isArray(overrideOv)) {
    return { ...base };
  }
  const legs = new Set([...Object.keys(base), ...Object.keys(overrideOv)]);
  const out = {};
  for (const leg of legs) {
    const b = base[leg];
    const o = overrideOv[leg];
    if (o && typeof o === "object" && !Array.isArray(o)) {
      out[leg] = { ...(b && typeof b === "object" ? b : {}), ...o };
    } else if (o !== undefined) {
      out[leg] = o;
    } else if (b && typeof b === "object" && !Array.isArray(b)) {
      out[leg] = { ...b };
    } else {
      out[leg] = b;
    }
  }
  return out;
}

function mergeBacktestCfg(base, optsConfig, feeModel) {
  const opts = optsConfig || {};
  const { typeOverrides: optsTypeOverrides, ...optsRest } = opts;
  return normalizeSmcParams({
    ...base,
    ...optsRest,
    typeOverrides: mergeTypeOverrides(base?.typeOverrides, optsTypeOverrides),
    makerFeeRate: opts.makerFeeRate ?? feeModel.makerFeeRate,
    fundingRate8h: feeModel.fundingRate8h,
    _feeModel: feeModel,
  });
}

/**
 * Resolve MD race participants from Advance selectedComponents.
 */
function resolveMdCombination(cfg = {}) {
  const mode = String(cfg.mdCombinationMode || "race").toLowerCase();
  const comps = cfg.selectedComponents || cfg.activeStrategyComponents || null;
  const mdComps = Array.isArray(comps)
    ? comps.filter((c) => isMRKey(c))
    : [];
  const upper = mdComps.map((c) => String(c).toUpperCase());
  const selectedComponents = upper.length
    ? upper.map((c) => {
      if (c === "SUPPLY_AND_DEMAND") return "SUPPLY_AND_DEMAND";
      if (c === "STATISTICAL_ARBITRAGE") return "STATISTICAL_ARBITRAGE";
      return normalizeStrategyKey(c);
    }).filter((c) => MR_COMPONENTS.has(c))
    : null;
  return {
    mdCombinationMode: mode === "layering" || mode === "pipeline" ? "pipeline" : mode,
    selectedComponents,
    mdActiveRacers: selectedComponents || cfg.mdActiveRacers || null,
  };
}

/**
 * Resolve BS race participants from Advance selectedComponents.
 */
function resolveBsCombination(cfg = {}) {
  const mode = String(cfg.bsCombinationMode || "race").toLowerCase();
  const comps = cfg.selectedComponents || cfg.activeStrategyComponents || null;
  const bsComps = Array.isArray(comps)
    ? comps.filter((c) => isBRKey(c))
    : [];
  const upper = bsComps.map((c) => String(c).toUpperCase());
  const selectedComponents = upper.length
    ? upper.map((c) => {
      if (c === "BREAKOUT_TRADING") return "BREAKOUT_RETEST";
      if (c === "ICT") return "ICT_STYLE_TRADING";
      if (c === "LIQUIDATION_SQUEEZE") return "LIQUIDATION_SQUEEZE";
      return normalizeStrategyKey(c);
    }).filter((c) => BR_COMPONENTS.has(c))
    : null;
  return {
    bsCombinationMode: mode === "single" || mode === "pipeline" ? "single" : mode,
    selectedComponents,
    bsActiveRacers: selectedComponents || cfg.bsActiveRacers || null,
  };
}

/** Sprint 14: BREAKOUT_RETEST enrichment for CSV / WinPredictor (from getLastSignalMeta). */
function extractBsBrEnrichment(meta) {
  if (!meta) return {};
  return {
    bbSqueezeWidthAtr: meta.bbSqueezeWidthAtr ?? null,
    breakoutVolumeRatio: meta.breakoutVolumeRatio ?? null,
    retestDepthAtr: meta.retestDepthAtr ?? null,
    rejectionWickPct: meta.rejectionWickPct ?? null,
    consolidationBars: meta.consolidationBars ?? null,
    breakoutCandleAtr: meta.breakoutCandleAtr ?? null,
    bbWidth: meta.bbWidth ?? meta.squeezeWidthPct ?? null,
    volumeRatio: meta.volumeRatio ?? meta.breakoutVolumeRatio ?? null,
  };
}

const {
  extractTsVpEnrichment,
  extractTsTfEnrichment,
  extractTsMsEnrichment,
  extractMdMrEnrichment,
  extractMdSdEnrichment,
  extractMdSaEnrichment,
  extractBsIctEnrichment,
  extractBsLsEnrichment,
  extractAfVsaEnrichment,
  extractAfWyckoffEnrichment,
  extractSmcEnrichment,
  extractBrEnrichment,
  extractGradedScoreEnrichment,
  ALL_ML_ENRICH_KEYS,
} = require("../../../shared/csv/strategyMlEnrichment");
const { enrichMetaWithGradedScore } = require("../../../core/strategy-engine/scoring/ComponentScoringEngine");

/**
 * Resolve the winning racer/component key for trade attribution.
 * Never treat trade-leg names (Scalping/Intraday/Swing) as strategy components.
 * Prefer explicit winningComponent / afRace / getLastRaceMeta over stale meta.component
 * (Wyckoff evaluate always stamps component:"WYCKOFF" even when SMC wins the race).
 */
function resolveWinningComponentKey(meta, strategy, strategyKey) {
  if (meta?.winningComponent) return meta.winningComponent;
  if (meta?.afRace?.winningComponent) return meta.afRace.winningComponent;
  const raceMeta = typeof strategy?.getLastRaceMeta === "function"
    ? strategy.getLastRaceMeta()
    : null;
  if (raceMeta?.winningComponent) return raceMeta.winningComponent;
  const comp = meta?.component;
  if (comp && !TRADE_LEG_NAMES.has(comp)) {
    const n = normalizeStrategyKey(String(comp).toUpperCase());
    if (n && n !== "ADAPTIVE_FUSION") return n;
  }
  return strategyKey;
}

/** Sprint 16: enrich signal meta with graded 0-100 score (live/backtest parity). */
function resolveEnrichedSignalMeta(strategy, strategyKey, rawMeta = null, tradeType = null) {
  const signalMeta = typeof strategy?.getLastSignalMeta === "function"
    ? strategy.getLastSignalMeta()
    : null;
  // AF detectSignalMulti attaches gate/race overlays on multi.meta; merge with
  // getLastSignalMeta() so Wyckoff/VSA ML fields propagate to positions/CSV.
  const meta = rawMeta
    ? {
        ...(signalMeta || {}),
        ...rawMeta,
        winningComponent: resolveWinningComponentKey(
          { ...(signalMeta || {}), ...rawMeta },
          strategy,
          strategyKey,
        ),
      }
    : signalMeta;
  if (!meta) return null;
  const key = resolveWinningComponentKey(meta, strategy, strategyKey);
  const leg = tradeType ?? meta.tradeType ?? (
    TRADE_LEG_NAMES.has(meta.component) ? meta.component : null
  );
  return enrichMetaWithGradedScore({
    ...meta,
    winningComponent: key,
    tradeType: leg,
    component: leg ?? (TRADE_LEG_NAMES.has(meta.component) ? meta.component : key),
  }, key);
}

/** Drop null/empty enrichment keys so later spreads do not clobber computed mlFeatures. */
function definedEnrichmentOnly(obj) {
  if (!obj || typeof obj !== "object") return {};
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v != null && v !== ""),
  );
}

/** Sprint 15 + Sprint 16: collect all strategy ML enrichments from signal meta. */
function extractStrategyMlEnrichment(meta) {
  if (!meta) return {};
  return {
    ...extractSmcEnrichment(meta),
    ...extractBrEnrichment(meta),
    ...extractGradedScoreEnrichment(meta),
    ...extractTsTfEnrichment(meta),
    ...extractTsMsEnrichment(meta),
    ...extractTsVpEnrichment(meta),
    ...extractMdMrEnrichment(meta),
    ...extractMdSdEnrichment(meta),
    ...extractMdSaEnrichment(meta),
    ...extractBsIctEnrichment(meta),
    ...extractBsLsEnrichment(meta),
    ...extractAfVsaEnrichment(meta),
    ...extractAfWyckoffEnrichment(meta),
  };
}

/** Defaults = Bitget retail schedule (historical hardcode; prefer resolveFeeModel). */
const _DEFAULT_FEE = resolveFeeSchedule("bitget");
const FEE_RATE_PER_SIDE = _DEFAULT_FEE.takerFeeRate; // Bitget USDT-M taker ~0.06%/side
const DEFAULT_SLIPPAGE = 0.0005;
/** Typical crypto perpetual funding ~0.01% per 8h (conservative cost model). */
const FUNDING_RATE_8H = _DEFAULT_FEE.fundingRate8h;
const MS_PER_8H = 8 * 60 * 60 * 1000;

/**
 * Resolve taker/maker/funding from opts.feeSchedule, opts.exchangeType, or Bitget default.
 * @param {{ exchangeType?: string, feeSchedule?: object, enableFees?: boolean }} opts
 */
function resolveFeeModel(opts = {}) {
  const schedule = opts.feeSchedule?.takerFeeRate != null
    ? opts.feeSchedule
    : resolveFeeSchedule(opts.exchangeType);
  const enableFees = opts.enableFees !== false;
  return {
    schedule,
    exchange: schedule.exchange,
    exchangeLabel: schedule.label,
    takerFeeRate: schedule.takerFeeRate,
    makerFeeRate: schedule.makerFeeRate,
    fundingRate8h: schedule.fundingRate8h,
    feeRate: enableFees ? schedule.takerFeeRate : 0,
  };
}

/** Accrue absolute funding cost over hold time (parity with live funding drag). */
function estimateFundingCost(entryPrice, size, openTs, closeTs, enabled, fundingRate8h = FUNDING_RATE_8H) {
  if (!enabled || !(entryPrice > 0) || !(size > 0)) return 0;
  const holdMs = Math.max(0, (closeTs || 0) - (openTs || 0));
  const periods = holdMs / MS_PER_8H;
  const rate = Number.isFinite(fundingRate8h) ? fundingRate8h : FUNDING_RATE_8H;
  return periods * rate * entryPrice * size;
}

/** Map an entry-bar timestamp → index of last CLOSED htf candle at/just before it. */
function buildHtfIndexPointer(entryCandles, htfCandles) {
  const out = new Array(entryCandles.length).fill(-1);
  let j = 0;
  for (let i = 0; i < entryCandles.length; i++) {
    const t = entryCandles[i].timestamp;
    while (j < htfCandles.length && htfCandles[j].timestamp <= t) j++;
    out[i] = j - 1; // last htf candle whose open-time <= entry bar time
  }
  return out;
}

function isoOf(c) {
  if (c.date) return c.date;
  const ts = c.timestamp ?? c.openTime ?? c.time;
  return ts != null ? new Date(ts).toISOString() : null;
}

/** Attach full entryContext for RAG gate / WinPredictor (mirrors live ML pipeline). */
function withBacktestEntryContext(tradeObj, position, strategyKey, displayName) {
  const label = displayName || strategyKey;
  const entryMeta = tradeObj.entryMeta ?? position?.entryMeta ?? null;
  if (tradeObj.entryMeta == null && entryMeta != null) tradeObj.entryMeta = entryMeta;

  const entry = tradeObj.entry ?? position?.entry;
  // Guard against array/object bleed into CSV numeric columns (ATR/RSI showing 1e15+).
  const atr = scalarIndicator(position?.atr ?? tradeObj.atr, { min: 0, max: 1e9 });
  const entryRsi = scalarIndicator(position?.entryRsi ?? tradeObj.entryRsi, { min: 0, max: 100 });
  const entryPx = scalarIndicator(entry, { min: 0, max: 1e12 });
  const slPx = scalarIndicator(tradeObj.sl ?? position?.sl, { min: 0, max: 1e12 });
  const tpPx = scalarIndicator(tradeObj.tp ?? position?.tp, { min: 0, max: 1e12 });
  if (atr != null) tradeObj.atr = atr;
  else if (tradeObj.atr != null) tradeObj.atr = null;
  if (entryRsi != null) tradeObj.entryRsi = entryRsi;
  else if (tradeObj.entryRsi != null) tradeObj.entryRsi = null;
  if (entryPx != null) tradeObj.entry = entryPx;
  if (slPx != null) tradeObj.sl = slPx;
  else if (tradeObj.sl != null) tradeObj.sl = null;
  if (tpPx != null) tradeObj.tp = tpPx;
  else if (tradeObj.tp != null) tradeObj.tp = null;

  const winner =
    position?.winningComponent
    ?? tradeObj.winningComponent
    ?? resolveWinningComponentKey(entryMeta, null, strategyKey);
  if (winner) {
    tradeObj.winningComponent = winner;
    tradeObj.strategyKey = winner;
  } else {
    tradeObj.strategyKey = strategyKey;
  }

  const ctxSource = {
    entry: entryPx ?? entry,
    atr:        atr ?? 0,
    entryRsi:   entryRsi ?? 50,
    htfTrend:   position?.htfTrend ?? tradeObj.htfTrend ?? null,
    marketCond: position?.marketCond ?? tradeObj.marketCond ?? null,
    confidence: position?.confidence ?? tradeObj.confidence ?? null,
    tradeType:  tradeObj.tradeType ?? tradeObj.component ?? position?.component,
    strategy:   label,
  };
  tradeObj.strategy = label;
  tradeObj.strategyLabel = label;

  // Sprint 14/15: pass through strategy ML enrichment columns for CSV / WinPredictor
  const ENRICH_KEYS = [
    "bbSqueezeWidthAtr", "breakoutVolumeRatio", "retestDepthAtr",
    "rejectionWickPct", "consolidationBars", "breakoutCandleAtr",
    "bbWidth", "volumeRatio",
    ...ALL_ML_ENRICH_KEYS,
  ];
  for (const k of ENRICH_KEYS) {
    if (tradeObj[k] == null && position?.[k] != null) tradeObj[k] = position[k];
  }

  // Compute human-readable entryReasons at close so FE client CSV + archive
  // export both see a string (FE previously only passthrough'd entryReasons).
  const reasonKey =
    tradeObj.winningComponent
    || position?.winningComponent
    || resolveWinningComponentKey(entryMeta, null, strategyKey);
  if (tradeObj.entryReasons == null || tradeObj.entryReasons === "") {
    const resolved = resolveEntryReasons(reasonKey, entryMeta);
    tradeObj.entryReasons = resolved || null;
  }

  tradeObj.entryContext = buildBacktestEntryContext(ctxSource, {
    strategyKey,
    openTime: tradeObj.openTime,
    price:    ctxSource.entry,
  });
  return tradeObj;
}

/**
 * Resolve TS combination mode + racer set from Advance selectedComponents.
 *
 * Sprint 12 default: race-to-confirm (independent TREND_FOLLOWING / MARKET_STRUCTURE / AUCTION_MARKET_THEORY).
 * Gate flags only apply when tsCombinationMode is "gate" or "hybrid".
 */
function resolveTsCombination(cfg = {}) {
  const mode = String(cfg.tsCombinationMode || "race").toLowerCase();
  const comps = cfg.selectedComponents || cfg.activeStrategyComponents || null;
  const tsComps = Array.isArray(comps)
    ? comps.filter((c) => isTFKey(c))
    : [];
  const upper = tsComps.map((c) => normalizeStrategyKey(String(c).toUpperCase()));
  const selectedComponents = upper.length ? upper.filter((c) => TF_COMPONENTS.has(c)) : null;

  // Legacy gate-flag resolution (only meaningful for gate/hybrid modes).
  let tsUseStructureGate = cfg.tsUseStructureGate;
  let tsUseVwapPrecision = cfg.tsUseVwapPrecision;
  if (upper.length) {
    const onlyTrigger = upper.every((c) => c === "TREND_FOLLOWING");
    if (onlyTrigger) {
      tsUseStructureGate = false;
      tsUseVwapPrecision = false;
    } else if (mode === "gate" || mode === "layering" || mode === "hybrid") {
      tsUseStructureGate = upper.includes("MARKET_STRUCTURE");
      tsUseVwapPrecision = upper.includes("AUCTION_MARKET_THEORY");
    }
  }

  return {
    tsCombinationMode: mode === "layering" ? "gate" : mode,
    selectedComponents,
    tsUseStructureGate,
    tsUseVwapPrecision,
  };
}

/** @deprecated Use resolveTsCombination — kept for older callers/tests. */
function resolveTsLayerFlags(cfg = {}) {
  const r = resolveTsCombination(cfg);
  return {
    tsUseStructureGate: r.tsUseStructureGate,
    tsUseVwapPrecision: r.tsUseVwapPrecision,
  };
}

function resolveStrategyDisplayName(strategyKey, cfg = {}) {
  if (cfg.strategyDisplayName) return cfg.strategyDisplayName;
  if (cfg.displayLabel) return cfg.displayLabel;
  const comps = cfg.selectedComponents || cfg.activeStrategyComponents;
  if (Array.isArray(comps) && comps.length) {
    // Race mode: run header lists the unlocked pool; per-trade labels come from
    // the winning racer via getLastSignalMeta().strategyLabel.
    const labels = comps.map((c) => {
      const s = STRATEGIES[c];
      return s?.label || c;
    });
    if (labels.length === 1) return labels[0];
    if (labels.length > 1) {
      const tsMode = String(cfg.tsCombinationMode || "race").toLowerCase();
      const afMode = String(cfg.afCombinationMode || "race").toLowerCase();
      const isTs = comps.some((c) => isTFKey(c));
      const isAf = comps.some((c) => isSmcKey(c));
      if (isTs && tsMode === "race") return `Trend Surge race (${labels.join(", ")})`;
      if (isAf && afMode === "race") return `Adaptive Fusion race (${labels.join(", ")})`;
      const mdMode = String(cfg.mdCombinationMode || "race").toLowerCase();
      const bsMode = String(cfg.bsCombinationMode || "race").toLowerCase();
      const isMd = comps.some((c) => isMRKey(c));
      const isBs = comps.some((c) => isBRKey(c));
      if (isMd && mdMode === "race") return `Mean Drift race (${labels.join(", ")})`;
      if (isBs && bsMode === "race") return `Breakout Storm race (${labels.join(", ")})`;
      return labels.join(" + ");
    }
  }
  return STRATEGIES[strategyKey]?.label || strategyKey;
}

function resolveTradeDisplayName(strategyKey, cfg, meta, fallbackDisplayName) {
  if (meta?.strategyLabel) return meta.strategyLabel;
  if (meta?.winningComponent && STRATEGIES[meta.winningComponent]?.label) {
    return STRATEGIES[meta.winningComponent].label;
  }
  return fallbackDisplayName || resolveStrategyDisplayName(strategyKey, cfg);
}

/**
 * Run a faithful server-side backtest.
 *
 * @param {Object}   opts
 * @param {Array}    opts.entryCandles  - entry-TF candles {timestamp,open,high,low,close,volume}
 * @param {Array}    opts.htfCandles    - HTF candles (null = no HTF filter)
 * @param {string}   opts.strategyKey   - e.g. "ADAPTIVE_FUSION"
 * @param {number}   opts.capital       - starting capital
 * @param {Object}   [opts.config]      - override of the canonical strategy config
 * @param {boolean}  [opts.enableFees=true]
 * @param {boolean}  [opts.enableSlippage=false]
 * @returns {{trades:Array, equity:Array, stats:Object, meta:Object}}
 */
// Multi-position backtest (v3.0): each AF component opens independent positions
// Pass opts.debug=true to get a per-bar rejection log (capped at 500 entries).

// AF-SCALP-02: rolling mean of ATR — per-leg baseline for the relative ATR gate.
// cfg.atrMinMult/atrMaxMult are ABSOLUTE price-% bounds calibrated for a ~1h
// chart (SMC: 0.8-5%). Applied TF-agnostically they starve low-TF legs: 5m BTC
// ATR is 0.05-0.15%, so the 0.8% floor only passes during flash crashes
// (Scalping = 3 trades / 12 months, all in extreme candles, worst-possible
// fee+slippage conditions). The relative gate compares each bar's ATR to the
// leg's OWN recent baseline instead — "market not dead / not panicking" means
// the same thing on every timeframe.
async function _runMultiPositionBacktest(opts, strategy, cfg, feeRate, slip, entryCandles, htfCandles) {
  const strategyKey = opts.strategyKey || "ADAPTIVE_FUSION";
  const startCapital = opts.capital || 1000;
  const strategyDisplayName = resolveStrategyDisplayName(strategyKey, cfg);

  // AF umbrella is a process singleton — clear ablation counters between runs.
  if (typeof strategy.resetAblation === "function") strategy.resetAblation();

  const indicators = calcIndicators(entryCandles, {
    emaFast: cfg.emaFast ?? 9,
    emaSlow: cfg.emaSlow ?? 21,
    emaTrend: cfg.emaTrend ?? 50,
    rsiPeriod: cfg.rsiPeriod ?? 14,
    atrPeriod: cfg.atrPeriod ?? 14,
  });

  // SMART_MONEY_CONCEPTS entry-TF ADX (chop gate) + MEAN_REVERSION ADX regime gate (MD-SUB-01):
  // calcIndicators does not populate adx — attach it for strategies that need it.
  if (isSmcKey(strategyKey) || isMRKey(strategyKey)) {
    indicators.adx = calcADX(indicators.highs, indicators.lows, indicators.closes, 14).adx;
  }

  const htfPtr = htfCandles?.length ? buildHtfIndexPointer(entryCandles, htfCandles) : null;
  const htfTrendCache = new Map();

  // Pre-compute HTF EMA fast/slow + ATR arrays for htfTrendStrength (mirrors BotEngine live calc)
  let htfEmaFastArr = null, htfEmaSlowArr = null, htfAtrArr = null;
  if (htfCandles?.length) {
    const htfCloses = htfCandles.map(c => c.close);
    const htfHighs  = htfCandles.map(c => c.high);
    const htfLows   = htfCandles.map(c => c.low);
    htfEmaFastArr = calcEMA(htfCloses, cfg.htfEmaFast ?? 9);
    htfEmaSlowArr = calcEMA(htfCloses, cfg.htfEmaSlow ?? 21);
    htfAtrArr     = calcATR(htfHighs, htfLows, htfCloses, cfg.atrPeriod ?? 14);
  }

  // Pre-compute daily trend strength for regime gate
  let dailyTrendCache = null;
  if (opts.dailyCandles?.length) {
    const dailyCloses = opts.dailyCandles.map(c => c.close);
    const dailyHighs = opts.dailyCandles.map(c => c.high);
    const dailyLows = opts.dailyCandles.map(c => c.low);
    const dailyTrend = computeDailyTrendStrength({
      close: dailyCloses,
      high: dailyHighs,
      low: dailyLows,
    });

    // Build dateMap for quick lookup
    const dailyDateMap = new Map();
    for (let i = 0; i < opts.dailyCandles.length; i++) {
      const dateStr = new Date(opts.dailyCandles[i].timestamp).toISOString().split("T")[0];
      dailyDateMap.set(dateStr, i);
    }

    dailyTrendCache = { dailyTrend, dateMap: dailyDateMap };
  }

  function htfStrengthAt(i) {
    if (!htfPtr || !htfEmaFastArr) return null;
    const j = htfPtr[i];
    if (j < 0) return null;
    const hEmaF = htfEmaFastArr[j];
    const hEmaS = htfEmaSlowArr[j];
    const hAtr  = htfAtrArr[j];
    if (hEmaF == null || hEmaS == null || hAtr == null || hAtr <= 0) return null;
    return Math.min(Math.abs(hEmaF - hEmaS) / hAtr, 1.0);
  }

  function htfTrendAt(i) {
    if (!htfPtr) return null;
    const j = htfPtr[i];
    if (j < 0) return "UNKNOWN";
    if (htfTrendCache.has(j)) return htfTrendCache.get(j);
    const window = htfCandles.slice(0, j + 1);
    const trend = detectHTFTrend(window, {
      htfEmaFast: cfg.htfEmaFast ?? 9,
      htfEmaSlow: cfg.htfEmaSlow ?? 21,
      sidewaysThresholdPct: cfg.sidewaysThresholdPct ?? 0.2,
    });
    htfTrendCache.set(j, trend);
    return trend;
  }

  const trades = [];
  const equity = [{ date: isoOf(entryCandles[0]), value: startCapital }];
  const debugLog = opts.debug ? [] : null; // per-bar rejection log (debug mode only)

  // Multi-position state: Map<componentId, { side, entry, sl, tp, size, openIdx, ... }>
  const positions = new Map();
  const componentCooldown = new Map();
  const componentConsecLoss = new Map();

  // EXECUTION-STAGE ablation — instruments the gap between "signal fired inside
  // detectSignalMulti" and "position actually opened". The strategy-internal
  // funnel (SmartMoneyConceptsStrategy._ablation) stops at "passed"; these
  // counters make every `continue` in the execution loop below visible, so a
  // "N passed → 0 trades" run can be attributed to a specific execution gate.
  // Purely observational — does NOT change any gate logic or threshold.
  const execAbl = {
    signalBars: 0,     // bars where multiSignal[componentId] was non-null
    rejRegimeGate: 0,  // applyRegimeGate → allow:false (daily regime hard-block)
    rejSideRegime: 0,  // applySmcSideRegimeGate → allow:false (Side×Regime)
    rejFunding: 0,     // Swing funding guard → allow:false
    rejPositionOpen: 0,// component already has an open position
    rejCooldown: 0,    // post-loss cooldown still active
    rejConsecLoss: 0,  // max consecutive losses reached
    rejDailyTrades: 0, // maxTradesPerDay reached
    rejDailyLoss: 0,   // maxDailyLossPct (incl floating) reached
    rejAtrGate: 0,     // ATR relative/absolute range gate
    rejSlTp: 0,        // sl/tp not finite
    rejSize: 0,        // computed position size <= 0
    opened: 0,         // positions.set(...) actually executed
  };

  let capital = startCapital;
  let dayKey = null;
  let dailyTradeCount = 0;
  let dailyLoss = 0;
  let dailyStartCapital = startCapital;

  const maxConsecLoss = cfg.maxConsecLoss ?? 3;
  const maxTradesPerDay = cfg.maxTradesPerDay ?? 6;
  const maxDailyLossPct = cfg.maxDailyLossPct ?? 0.03;
  const atrMinPct = cfg.atrMinMult ?? 0;
  const atrMaxPct = cfg.atrMaxMult ?? Infinity;

  // atrGateRelative is a PER-LEG flag (typeOverrides[componentId].atrGateRelative),
  // not a top-level one — this engine races multiple components (Scalping/Intraday/
  // Swing) in the SAME loop, so the relative-vs-absolute decision must be resolved
  // per componentId below, not once here off cfg.atrGateRelative (which is never
  // set at top level and previously made the relative gate permanently dead code).
  // Precompute unconditionally — building the array is cheap (single pass over ATR).
  const atrBaselineArr = buildAtrBaseline(indicators.atr);
  const cooldownMs = (cfg.cooldownAfterLoss ?? 0) * 60000;
  const riskPerTrade = cfg.riskPerTrade ?? 0.01;

  const warmup = Math.max(cfg.emaSlow ?? 21, cfg.atrPeriod ?? 14, 30) + 2;


  // (see checkPartialMilestones in runRealBacktest). Previously this multi-position
  // engine — the one SMART_MONEY_CONCEPTS/triple-type backtests actually use — had NO partial-TP
  // path at all: "Is Partial" was always false regardless of the FE tpMode toggle.
  const tpModeCfg = cfg.tpMode ?? "full";
  const slPlusEnabled = tpModeCfg === "partial" && (cfg.slPlusEnabled ?? true);
  const slPlusPartial1Pct = cfg.slPlusPartial1Pct ?? 0.40;
  const slPlusPartial2Pct = cfg.slPlusPartial2Pct ?? 0.275;
  // Ladder trigger points in R-multiples. Per-leg via typeOverrides[type] (cfg
  // here is already the per-type merged config in runTripleTypeBacktest) — the
  // milestone 1/2 R-thresholds were hardcoded 1.0/2.0 regardless of tradeType,
  // so a leg-specific ladder (e.g. Swing 1.5R/2.67R) could never be tested.
  const slPlusM1R = cfg.slPlusM1R ?? 1.0;
  const slPlusM2R = cfg.slPlusM2R ?? 2.0;

  function checkPartialMilestones(componentId, position, c, exitIdx) {
    if (!slPlusEnabled || !position || position.remainingSize <= 0) return;
    const R = position.R;
    if (!Number.isFinite(R) || R <= 0) return;

    const favorableExtreme = position.side === "LONG" ? c.high : c.low;
    const gain = position.side === "LONG" ? favorableExtreme - position.entry : position.entry - favorableExtreme;
    const rMult = gain / R;

    const partialAt = (price, size, reason, newSL) => {
      let px = price;
      if (slip) px = position.side === "LONG" ? px * (1 - slip) : px * (1 + slip);
      const grossPnl = position.side === "LONG" ? (px - position.entry) * size : (position.entry - px) * size;
      const fee = feeRate * (position.entry + px) * size;
      const pnl = grossPnl - fee;
      capital += pnl;
      position.remainingSize -= size;
      position.slCurrent = newSL;
      const tradeTypeLabel = typeof strategy.getTradeTypeLabel === "function"
        ? strategy.getTradeTypeLabel(componentId)
        : componentId;
      trades.push(withBacktestEntryContext({
        date: isoOf(c),
        openTime: isoOf(entryCandles[position.openIdx]),
        closeTime: isoOf(c),
        side: position.side,
        strategy: strategyKey,
        component: tradeTypeLabel,
        tradeType: tradeTypeLabel,
        marketCond: position.marketCond,
        entry: position.entry,
        exit: px,
        sl: position.sl,
        tp: position.tp,
        size,
        grossPnl,
        fee,
        pnl,
        pnlPct: (pnl / (position.entry * size)) * 100,
        plannedRR: position.plannedRR,
        confidence: position.confidence ?? null,
        atr: position.atr ?? null,
        entryRsi: position.entryRsi ?? null,
        htfTrend: position.htfTrend ?? null,
        dailyRegime: position.dailyRegime ?? null,
        entryMeta: position.entryMeta ?? null,
        reason,
        result: pnl > 0 ? "win" : "loss",
        isPartial: true,
      }, position, position.winningComponent || strategyKey, position.strategyLabel || strategyDisplayName));
    };

    // Milestone 1: +slPlusM1R → partial 40%, SL → +0.3R (NOT pure BEP — see runRealBacktest note).
    if (!position.m1 && rMult >= slPlusM1R) {
      position.m1 = true;
      const partial = position.originalSize * slPlusPartial1Pct;
      const newSL = position.side === "LONG" ? position.entry + 0.3 * R : position.entry - 0.3 * R;
      if (partial > 0 && partial < position.remainingSize) {
        partialAt(position.entry + (position.side === "LONG" ? slPlusM1R * R : -slPlusM1R * R), partial, "Partial_1R", newSL);
      } else {
        position.slCurrent = newSL;
      }
    }

    // Milestone 2: +slPlusM2R → partial 27.5% of ORIGINAL (capped to 90% of remaining), SL → +1R
    if (position.m1 && !position.m2 && rMult >= slPlusM2R) {
      position.m2 = true;
      const fromOriginal = position.originalSize * slPlusPartial2Pct;
      const partial = Math.min(fromOriginal, position.remainingSize * 0.90);
      const newSL = position.side === "LONG" ? position.entry + R : position.entry - R;
      if (partial > 0 && partial < position.remainingSize) {
        partialAt(position.entry + (position.side === "LONG" ? slPlusM2R * R : -slPlusM2R * R), partial, "Partial_2R", newSL);
      } else {
        position.slCurrent = newSL;
      }
    }

    // Milestone 3: +3R → log-only marker, no partial (mirrors live)
    if (position.m1 && position.m2 && !position.m3 && rMult >= 3.0) {
      position.m3 = true;
    }
  }

  function closePosition(componentId, position, exitPrice, reason, exitIdx) {

    //   entry (limit-at-level)  → maker, no slippage
    //   TP exit (limit order)   → maker, no slippage
    //   SL / TIME_STOP (market) → taker, slippage applies
    // CSV3 forensics: gross PF 1.23 but net 0.95 — the whole gap is execution
    // cost. 26 wins were paying taker on a TP that fills as a maker limit.
    const compOv = cfg.typeOverrides?.[componentId] || {};
    const useMaker = compOv.makerEntry === true || cfg.makerEntry === true;
    const makerRate = cfg.makerFeeRate ?? 0.0002;
    const isLimitExit = reason === "TP"; // TP = resting limit (maker); SL/time = market (taker)


    const closeSize = position.remainingSize ?? position.size;

    let px = exitPrice;
    // Slippage only on MARKET exits (stop/time). Limit fills execute at the level.
    if (slip && !(useMaker && isLimitExit)) {
      px = position.side === "LONG" ? px * (1 - slip) : px * (1 + slip);
    }
    const grossPnl = position.side === "LONG"
      ? (px - position.entry) * closeSize
      : (position.entry - px) * closeSize;
    const entryFeeRate = useMaker ? makerRate : feeRate;
    const exitFeeRate  = (useMaker && isLimitExit) ? makerRate : feeRate;
    const fee = entryFeeRate * position.entry * closeSize + exitFeeRate * px * closeSize;
    const openTs = entryCandles[position.openIdx]?.timestamp ?? 0;
    const closeTs = entryCandles[exitIdx]?.timestamp ?? 0;
    const funding = estimateFundingCost(
      position.entry, closeSize, openTs, closeTs,
      cfg.simulateFunding !== false && feeRate > 0,
      cfg.fundingRate8h ?? FUNDING_RATE_8H
    );
    const pnl = grossPnl - fee - funding;
    capital += pnl;

    // Sprint 13 Fee=0 audit: if cost model is ON, never emit silent zero fees
    // on a real-sized close (guards against makerRate/feeRate misconfig).
    let feeOut = fee;
    if (feeRate > 0 && closeSize > 0 && feeOut === 0) {
      feeOut = feeRate * (position.entry + px) * closeSize;
    }

    if (pnl < 0) {
      const compLoss = (componentConsecLoss.get(componentId) || 0) + 1;
      componentConsecLoss.set(componentId, compLoss);
      dailyLoss += Math.abs(pnl);
      componentCooldown.set(componentId, (entryCandles[exitIdx].timestamp ?? 0) + cooldownMs);
    } else {
      componentConsecLoss.set(componentId, 0);
    }

    const closeTime = isoOf(entryCandles[exitIdx]);
    // Use human-readable trade type label if strategy supports it
    const tradeTypeLabel = typeof strategy.getTradeTypeLabel === "function"
      ? strategy.getTradeTypeLabel(componentId)
      : componentId;

    const holdHours = holdHoursBetween(openTs, closeTs);
    const excursions = computeExcursionFields(position, px);

    trades.push(withBacktestEntryContext({
      date: closeTime,
      openTime: isoOf(entryCandles[position.openIdx]),
      closeTime,
      side: position.side,
      strategy: strategyKey,
      component: tradeTypeLabel,
      tradeType: tradeTypeLabel,
      marketCond: position.marketCond || "NORMAL",
      entry: position.entry,
      exit: px,
      sl: position.sl,
      tp: position.tp,
      size: closeSize,
      grossPnl,
      fee: feeOut,
      funding,
      pnl,
      pnlPct: closeSize > 0 ? (pnl / (position.entry * closeSize)) * 100 : 0,
      plannedRR: position.plannedRR,
      confidence: position.confidence ?? null,
      // GROK-FIX: entry-context snapshot forwarded for post-hoc Grok Confirm Gate.
      atr: position.atr ?? null,
      entryRsi: position.entryRsi ?? null,
      htfTrend: position.htfTrend ?? null,
      dailyRegime: position.dailyRegime ?? "UNKNOWN",
      entryMeta: position.entryMeta ?? null,
      // Sprint 13 ML / confidence component columns
      sweepStrength: position.sweepStrength ?? null,
      fvgSizeAtr: position.fvgSizeAtr ?? null,
      obDistanceAtr: position.obDistanceAtr ?? null,
      displacementPct: position.displacementPct ?? null,
      htfAdx: position.htfAdx ?? null,
      hourUtc: position.hourUtc ?? null,
      volumeRatio: position.volumeRatio ?? null,
      bbWidth: position.bbWidth ?? null,
      bbSqueezeWidthAtr: position.bbSqueezeWidthAtr ?? null,
      breakoutVolumeRatio: position.breakoutVolumeRatio ?? null,
      retestDepthAtr: position.retestDepthAtr ?? null,
      rejectionWickPct: position.rejectionWickPct ?? null,
      consolidationBars: position.consolidationBars ?? null,
      breakoutCandleAtr: position.breakoutCandleAtr ?? null,
      fundingRateAtEntry: position.fundingRateAtEntry ?? null,
      fundingForecast24h: position.fundingForecast24h ?? null,
      holdHours,
      confSweepStrength: position.confSweepStrength ?? null,
      confFvgSize: position.confFvgSize ?? null,
      confDisplacementPct: position.confDisplacementPct ?? null,
      confHtfAlignment: position.confHtfAlignment ?? null,
      confMitigationDepth: position.confMitigationDepth ?? null,
      confObConfluence: position.confObConfluence ?? null,
      sweepAgeBars: position.sweepAgeBars ?? null,
      sweepToChochBars: position.sweepToChochBars ?? null,
      chochToEntryBars: position.chochToEntryBars ?? null,
      mfe: excursions.mfe,
      mae: excursions.mae,
      mfePercent: excursions.mfePercent,
      maePercent: excursions.maePercent,
      exitEfficiency: excursions.exitEfficiency,
      vpVwapLevel: position.vpVwapLevel ?? null,
      vpVahLevel: position.vpVahLevel ?? null,
      vpValLevel: position.vpValLevel ?? null,
      vpPocLevel: position.vpPocLevel ?? null,
      vpTriggerType: position.vpTriggerType ?? null,
      // Sprint 15 ML enrichments — only defined position keys (null must not
      // overwrite explicit mfe/mae/sweepAgeBars set above).
      ...Object.fromEntries(
        ALL_ML_ENRICH_KEYS
          .filter((k) => !k.startsWith("vp"))
          .filter((k) => position[k] != null)
          .map((k) => [k, position[k]])
      ),
      reason,
      result: pnl > 0 ? "win" : "loss",
      isPartial: false,
    }, position, position.winningComponent || strategyKey, position.strategyLabel || strategyDisplayName));
    positions.delete(componentId);
  }

  const totalBars = entryCandles.length;
  const progressEvery = Math.max(500, Math.floor(totalBars / 100));

  // Main loop
  for (let i = warmup; i < entryCandles.length; i++) {
    // Abort check + progress emit
    if (opts.abortSignal?.aborted) break;
    if (i % progressEvery === 0 && opts.onProgress) {
      opts.onProgress(Math.round(i / totalBars * 100), i, totalBars);
    }
    // BT-FIX: yield every 250 bars on large runs (was 500). AF Wyckoff+VSA is ~3×
    // heavier per bar; keep the main/worker event loop free for health + job polls.
    // Child-process isolation (BacktestJobService) is the primary 502 guard; this
    // yield still matters for BACKTEST_ISOLATE=0 and for IPC progress flush.
    const yieldEvery = totalBars > 20_000 ? 250 : 500;
    if (i % yieldEvery === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const c = entryCandles[i];
    const price = c.close;
    const atr = scalarIndicator(indicators.atr[i], { min: 0, max: 1e9 });
    if (atr == null || price == null) {
      equity.push({ date: isoOf(c), value: round2(capital) });
      continue;
    }

    const dk = (isoOf(c) || "").slice(0, 10);
    if (dk !== dayKey) {
      dayKey = dk;
      dailyTradeCount = 0;
      dailyLoss = 0;
      dailyStartCapital = capital;
      // Daily reset: consecutive loss counters reset each day (mirrors live bot daily restart).
      // Prevents one bad day from permanently blocking a component across months of backtest.
      componentConsecLoss.clear();
    }

    // Monitor all open positions for SL/TP / TIME_STOP (maxHoldHours)
    for (const [componentId, pos] of positions.entries()) {

      // the SL/TP check below (mirrors runRealBacktest's single-position order).
      updatePositionExcursions(pos, c);
      checkPartialMilestones(componentId, pos, c, i);
      if (!positions.has(componentId)) continue; // safety: milestone logic never fully closes, but guard anyway

      // TIME_STOP: typeOverrides[leg].maxHoldHours (Scalping 2h / Intraday 6h / Swing 120h).
      const holdOv = cfg.typeOverrides?.[pos.component || componentId] || {};
      const maxHoldHours = holdOv.maxHoldHours
        ?? holdOv.scalpingMaxHoldHours
        ?? holdOv.swingMaxHoldHours
        ?? (componentId === "Scalping" ? cfg.maxHoldHours : undefined);
      if (maxHoldHours) {
        const openTs = entryCandles[pos.openIdx]?.timestamp ?? 0;
        const holdMs = (c.timestamp ?? 0) - openTs;
        if (holdMs > maxHoldHours * 3600 * 1000) {
          closePosition(componentId, pos, price, "TIME_STOP", i);
          continue;
        }
      }

      const stopLevel = pos.slCurrent;
      const hitSL = pos.side === "LONG" ? c.low <= stopLevel : c.high >= stopLevel;
      const hitTP = pos.side === "LONG" ? c.high >= pos.tp : c.low <= pos.tp;
      if (hitSL) {
        closePosition(componentId, pos, stopLevel, pos.m1 ? "SL_TRAIL" : "SL", i);
      } else if (hitTP) {
        closePosition(componentId, pos, pos.tp, "TP", i);
      }
    }

    // Check market conditions
    const emaF = indicators.emaFast?.[i];
    const emaS = indicators.emaSlow?.[i];
    const volatility = atr && price ? (atr / price) * 100 : 1.0;
    const emaDelta = emaS > 0 ? Math.abs(emaF - emaS) / emaS : 0;
    const trendStrength = Math.min(emaDelta * 50, 1.0);

    const htfTrend = htfTrendAt(i);
    if (htfTrend === "UNKNOWN") continue; // fail-closed

    const entryDate = new Date(c.timestamp).toISOString().split("T")[0];
    const dailyRegime = dailyTrendCache ? getRegimeForDate(entryDate, dailyTrendCache) : "UNKNOWN";

    // Detect multi-component signals (AF v3.0 / SMC v3.1)
    const multiSignal = strategy.detectSignalMulti(indicators, i, {
      // BT-FIX: spread full strategy config so SMC knobs (smcMinConfidenceA/B/C,
      // smcEnabledComponents, smcSweepVolMult, smcOBDispMult, …) actually reach
      // the detector. Previously only af* keys were forwarded, so detectSignalMulti
      // used its internal `?? 60` defaults and ignored our tuned gates → Scalping 0.
      ...cfg,
      balance: capital,
      volatility,
      trend_strength: trendStrength,
      htfTrend,
      htfTrendStrength: htfStrengthAt(i), // v3.3 fix: was missing → htfTrendStrengthMin gate blocked all
      maxEntryExtensionATR: cfg.maxEntryExtensionATR,
      afRejectOnDissent: cfg.afRejectOnDissent,
      pairTier: cfg.pairTier,
      tierOverrides: cfg.tierOverrides,
      volSmaMultiplier: cfg.volSmaMultiplier,
      marketThresholds: cfg.marketThresholds,
      afEnabledComponents: cfg.afEnabledComponents,
      afMinComponentConfidence: cfg.afMinComponentConfidence,
      afMinAggregateConfidence: cfg.afMinAggregateConfidence,

      regimeDetection: cfg.regimeDetection, // EMA gap thresholds, ADX strength
      typeOverrides: cfg.typeOverrides, // per-leg overrides (Scalping/Intraday/Swing)
      candleTimestamp: c.timestamp, // Sprint 13 session filter
      dailyRegime,
    });


    const nowMs = c.timestamp ?? 0; // backtest "now" = current candle time (NOT wall-clock)

    // Debug: log rejection reason for each bar (capped at 500 to avoid huge responses)
    if (debugLog != null && debugLog.length < 500) {
      const anyFired = ["Scalping", "Intraday", "Swing"].some(k => multiSignal[k]);
      if (!anyFired) {
        const blockReasons = [];
        const mc = multiSignal.meta?.marketCond;
        if (mc === "DEAD_MARKET")     blockReasons.push("DEAD_MARKET");
        if (mc === "CHOPPY_VOLATILE") blockReasons.push("CHOPPY_VOLATILE");
        if (htfTrend === "UNKNOWN")   blockReasons.push("htfTrend=UNKNOWN");
        const conf = multiSignal.meta?.confidence || {};
        const compSigs = {};
        // Re-run with gate off to see what the raw signal would have been
        const rawMulti = strategy.detectSignalMulti(indicators, i, {
          ...cfg,
          balance: capital, volatility, trend_strength: trendStrength,
          htfTrend, htfTrendStrength: htfStrengthAt(i),
          maxEntryExtensionATR: cfg.maxEntryExtensionATR,
          afEnabledComponents: cfg.afEnabledComponents,
          regimeDetection: cfg.regimeDetection,
          typeOverrides: cfg.typeOverrides,
          // gates OFF for diagnosis:
          smcMinConfidenceA: 0, smcMinConfidenceB: 0, smcMinConfidenceC: 0,
          afMinComponentConfidence: 0, afMinAggregateConfidence: 0,
        });
        for (const k of ["Scalping", "Intraday", "Swing"]) {
          compSigs[k] = rawMulti[k] ?? "null";
          if (rawMulti[k] && !multiSignal[k]) {
            const c_ = conf[k];
            if (c_ != null && c_ < (cfg.afMinComponentConfidence ?? 60)) {
              blockReasons.push(`${k}: conf=${c_}<${cfg.afMinComponentConfidence ?? 60}`);
            } else {
              blockReasons.push(`${k}: htf/chase/netEdge block`);
            }
          }
        }
        debugLog.push({
          date: isoOf(c), bar: i, marketCond: mc, htfTrend,
          volatility: +volatility.toFixed(3), trendStrength: +trendStrength.toFixed(3),
          rawSignals: compSigs, confidence: conf, blockReasons,
        });
      }
    }

    // Check each trade type for independent entry (type names + legacy letters deduped by position Map).
    // opts.activeComponents restricts which components can open (used by triple-TF backtest so each
    // trade-type run only opens its own component on the correct TF data).
    const tradeTypeKeys = opts.activeComponents ?? ["Scalping", "Intraday", "Swing"];
    for (const componentId of tradeTypeKeys) {
      const signal = multiSignal[componentId];
      if (!signal) continue;
      execAbl.signalBars += 1;

      // Apply daily regime gate — block momentum strategies during chop, reduce size for structure
      const entryDate = new Date(c.timestamp).toISOString().split("T")[0];
      const dailyRegime = dailyTrendCache ? getRegimeForDate(entryDate, dailyTrendCache) : "UNKNOWN";
      const scalpFlags = componentId === "Scalping"
        ? resolveScalpingGateFlags({ ...cfg, ...(cfg.typeOverrides?.Scalping || {}) })
        : {};
      const swingFlags = componentId === "Swing"
        ? resolveSwingGateFlags({ ...cfg, ...(cfg.typeOverrides?.Swing || {}) })
        : {};
      const regimeResult = applyRegimeGate({
        signal,
        strategyKey,
        regime: dailyRegime,
        riskPerTrade,
        // Sprint 13: Side×Regime — block LONG in CHOP for Scalping (config flag)
        blockLongInChop: componentId === "Scalping" && scalpFlags.smcBlockLongInChop === true,
      });
      if (!regimeResult.allow) { execAbl.rejRegimeGate += 1; continue; }

      // Redundant explicit check (same gate) so unit tests / future callers that
      // bypass applyRegimeGate still see the Side×Regime contract.
      if (componentId === "Scalping") {
        const sideGate = applySmcSideRegimeGate({
          signal,
          dailyRegime,
          enabled: scalpFlags.smcBlockLongInChop === true,
        });
        if (!sideGate.allow) { execAbl.rejSideRegime += 1; continue; }
      }

      // Sprint 13 Swing: skip entry on extreme perp funding premium
      const fundingRateNow = cfg.fundingRate ?? indicators.fundingRate?.[i] ?? null;
      if (componentId === "Swing" && swingFlags.smcFundingGuard) {
        const fundGate = applySmcFundingGuard({
          signal,
          fundingRate: fundingRateNow,
          enabled: true,
          maxAbsRate: swingFlags.smcMaxFundingRate,
        });
        if (!fundGate.allow) { execAbl.rejFunding += 1; continue; }
      }

      // AF-SWING-V3: confidence/RVOL/ATR-tiered position size (SWING_ENGINE_V3.md
      // improvement 9). No-op (multiplier 1) unless typeOverrides.Swing.smcSwingV3Gate
      // is enabled — see SmartMoneyConceptsStrategy._evaluateSwingV3Gate.
      const swingV3Mult = componentId === "Swing" ? (multiSignal.meta?.swingV3?.sizeMultiplier ?? 1) : 1;
      const adjustedRiskPerTrade = regimeResult.riskPerTrade * swingV3Mult;

      // Skip if component already has open position
      if (positions.has(componentId)) { execAbl.rejPositionOpen += 1; continue; }

      // Skip if component in cooldown (use candle time, not Date.now())
      const cooldown = componentCooldown.get(componentId);
      if (cooldown && nowMs < cooldown) { execAbl.rejCooldown += 1; continue; }

      // Skip if component exceeded max consecutive loss
      const compLoss = componentConsecLoss.get(componentId) || 0;
      if (compLoss >= maxConsecLoss) { execAbl.rejConsecLoss += 1; continue; }

      // Check daily limits — include floating loss (live BotEngine._checkRiskGates parity)
      if (dailyTradeCount >= maxTradesPerDay) { execAbl.rejDailyTrades += 1; continue; }
      const floatingLoss = [...positions.values()].reduce((s, p) => {
        const sz = p.remainingSize ?? p.size ?? 0;
        const u = p.side === "LONG"
          ? (price - p.entry) * sz
          : (p.entry - price) * sz;
        return u < 0 ? s + Math.abs(u) : s;
      }, 0);
      const dailyBase = dailyStartCapital || capital;
      if (dailyBase > 0 && (dailyLoss + floatingLoss) / dailyBase >= maxDailyLossPct) { execAbl.rejDailyLoss += 1; continue; }

      // Check ATR gate — relative to the leg's own baseline when enabled.
      // Per-leg atrMinMult/atrMaxMult/atrGateRelative (typeOverrides[componentId])
      // let each TF use its own band (e.g. 5m Scalping adaptive baseline ratio,
      // 15m Intraday / 4h Swing absolute floor 0.4%/0.8%). Falls back to the
      // top-level atrMinPct/atrMaxPct/cfg.atrGateRelative when a leg has no
      // override, so non-SMC strategies and live gating are unaffected.
      const compAtr = cfg.typeOverrides?.[componentId] || {};
      const compAtrMin = compAtr.atrMinMult ?? atrMinPct;
      const compAtrMax = compAtr.atrMaxMult ?? atrMaxPct;
      const compAtrGateRelative = compAtr.atrGateRelative ?? cfg.atrGateRelative ?? false;
      const compAtrRelMin = compAtr.atrRelMin ?? cfg.atrRelMin ?? 0.4;
      const compAtrRelMax = compAtr.atrRelMax ?? cfg.atrRelMax ?? 4.0;
      const atrPct = (atr / price) * 100;
      if (compAtrGateRelative && atrBaselineArr) {
        const base = atrBaselineArr[i];
        const rel = base > 0 ? atr / base : 1;
        if (rel < compAtrRelMin || rel > compAtrRelMax) { execAbl.rejAtrGate += 1; continue; }
      } else if (atrPct < compAtrMin || atrPct > compAtrMax) { execAbl.rejAtrGate += 1; continue; }

      // Calculate risk config for this component. Pass the REAL regime so
      // strongTrendTPMult (let winners run in STRONG_TREND) can fire — it was
      // hardcoded "NORMAL", so the ×1.8 TP extension never applied and every
      // winner was capped at the base RR.
      // Sprint 13 field SSOT:
      //   marketCond  = entry-TF vol/trend bucket (SMC meta)
      //   dailyRegime = daily ADX-proxy (STRONG_TREND/CHOP/TRANSITION/UNKNOWN)
      const marketCond = multiSignal.meta?.marketCond || "NORMAL";


      // Backtest uses full type names (Scalping/Intraday/Swing), not legacy A/B/C
      const typeOverride = cfg.typeOverrides?.[componentId] || {};
      const slMult = typeOverride.slAtrMult ?? cfg.slAtrMult;
      const tpMult = typeOverride.tpAtrMult ?? cfg.tpAtrMult;

      const riskCfg = strategy.calculateRiskConfig(price, atr, signal, componentId, {
        marketCond,
        strongTrendTPMult: cfg.strongTrendTPMult ?? 1,

        // typeConfig → cfg). Merged from typeOverrides per componentId.
        // Undefined = strategy's SUB_STRATEGIES defaults, so live and non-overridden legs are unchanged.
        slMultiplier: slMult,
        tpMultiplier: tpMult,
      });

      // Apply pair-tier SL/TP adjustments for STABLE/VOLATILE classification
      // (live parity: BotEngine.js:2601-2602). cfg.pairSlMultiplier set by
      // PairClassifier.classify(...).paramOverrides.slMultiplier — a CONTINUOUS
      // function of the hybrid volatility score (v2.4, 1.0×-1.5×), not a fixed
      // per-tier step. Backtest must match live so tier backtest results align
      // with live trade behavior.
      const pairSlMult = cfg.pairSlMultiplier || 1;
      const slDist = riskCfg.slDistance * pairSlMult;
      const tpDist = riskCfg.tpDistance * pairSlMult;
      const sl = signal === "LONG" ? price - slDist : price + slDist;
      const tp = signal === "LONG" ? price + tpDist : price - tpDist;

      if (!Number.isFinite(sl) || !Number.isFinite(tp)) { execAbl.rejSlTp += 1; continue; }

      // Calculate position size — risk-based: the loss when SL is hit must equal
      // riskAmt. size = riskAmt / slDist. Dividing by the FULL SL→TP span (as
      // before) shrank every position ~2.8× → effective risk ~0.18% instead of
      // the configured 0.5%, which is why return + drawdown were both tiny.
      const riskAmt = capital * adjustedRiskPerTrade;
      const size = slDist > 0 ? riskAmt / slDist : 0;

      if (size <= 0) { execAbl.rejSize += 1; continue; }

      const lastMeta = resolveEnrichedSignalMeta(strategy, strategyKey, null, componentId);
      const meta = multiSignal.meta
        ? resolveEnrichedSignalMeta(strategy, strategyKey, multiSignal.meta, componentId)
        : lastMeta;
      const tradeLabel = resolveTradeDisplayName(strategyKey, cfg, meta, strategyDisplayName);
      const winningComponent = resolveWinningComponentKey(meta, strategy, strategyKey);

      // Sprint 13: granular ML features + confidence components for CSV
      const seqMeta = meta?.sequenceMeta ? { ...meta.sequenceMeta } : null;
      if (seqMeta && meta?.confidenceComponents && !seqMeta.confidenceComponents) {
        seqMeta.confidenceComponents = meta.confidenceComponents;
      }
      if (seqMeta && atr > 0 && seqMeta.obDistanceAbs != null) {
        seqMeta.obDistanceAtr = seqMeta.obDistanceAbs / atr;
      }
      const mlFeatures = buildSmcEntryFeatures(indicators, i, seqMeta, {
        atr,
        price,
        timestamp: c.timestamp,
        htfAdx: indicators.adx?.[i] ?? null,
        fundingRate: fundingRateNow,
        confidenceComponents: meta?.confidenceComponents ?? seqMeta?.confidenceComponents ?? null,
      });
      const brEnrich = extractBsBrEnrichment(meta || lastMeta);
      const mlEnrich = extractStrategyMlEnrichment(meta || lastMeta);

      // Open position
      positions.set(componentId, {
        side: signal,
        entry: price,
        sl,
        tp,
        size,
        riskAmt,
        openIdx: i,
        component: componentId,
        marketCond,
        plannedRR: riskCfg.riskReward,

        confidence: multiSignal.meta?.confidence?.[componentId]
          ?? meta?.gradedScore
          ?? meta?.componentConfidence
          ?? lastMeta?.gradedScore
          ?? lastMeta?.componentConfidence
          ?? null,
        // GROK-FIX: entry-context snapshot so the trade can be Grok-confirmed post-hoc.
        atr,
        entryRsi: indicators.rsi?.[i] ?? null,
        htfTrend,
        dailyRegime: dailyRegime || "UNKNOWN",
        entryMeta: lastMeta || multiSignal.meta || null,
        strategyLabel: tradeLabel,
        winningComponent,
        ...mlFeatures,
        ...brEnrich,
        ...definedEnrichmentOnly(mlEnrich),

        // is the live stop (moves to +0.3R/+1R as milestones fire), remainingSize
        // shrinks as partials execute; originalSize stays fixed for milestone %.
        R: slDist,
        slCurrent: sl,
        originalSize: size,
        remainingSize: size,
        m1: false,
        m2: false,
        m3: false,
        ...initPositionExcursions(),
      });
      execAbl.opened += 1;

      dailyTradeCount += 1;
    }

    equity.push({ date: isoOf(c), value: round2(capital) });
  }

  // Compile stats
  const wins = trades.filter(t => t.result === "win");
  const losses = trades.filter(t => t.result === "loss");
  const totalReturn = ((capital - startCapital) / startCapital) * 100;

  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? "Inf" : "0.00");

  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const riskReward = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : "0.00";

  // Max drawdown
  let peak = startCapital, bal = startCapital, mdd = 0;
  for (const t of trades) {
    bal += t.pnl;
    peak = Math.max(peak, bal);
    mdd = Math.max(mdd, peak > 0 ? (peak - bal) / peak : 0);
  }

  // Sharpe
  const rets = trades.map(t => t.pnl);
  const avg = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1
    ? Math.sqrt(rets.reduce((s, r) => s + (r - avg) ** 2, 0) / (rets.length - 1))
    : 0;
  const sharpe = std > 0 ? ((avg / std) * Math.sqrt(252)).toFixed(2) : "0.00";

  return {
    ok: true,
    trades,
    equity,
    debugLog: debugLog ?? undefined, // only present when opts.debug=true
    execAblation: execAbl, // execution-stage funnel (signal → opened position)
    stats: {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : "0.0",
      totalReturn: totalReturn.toFixed(2),
      finalCapital: capital.toFixed(2),
      profitFactor,
      avgWin: avgWin.toFixed(2),
      avgLoss: avgLoss.toFixed(2),
      riskReward,
      maxDrawdown: (mdd * 100).toFixed(2),
      sharpe,
      totalFees: trades.reduce((s, t) => s + (t.fee || 0), 0).toFixed(2),
    },
    meta: {
      strategyKey,
      entryBars: entryCandles.length,
      htfBars: htfCandles?.length ?? 0,
      higherTf: cfg.higherTf || null,
      feeRate: cfg._feeModel?.takerFeeRate ?? FEE_RATE_PER_SIDE,
      slippage: slip,
      // Sprint 13 Fee=0 audit — every window documents cost-model assumptions
      costModel: buildCostModelMeta({
        enableFees: feeRate > 0,
        feeRate: feeRate || (cfg._feeModel?.takerFeeRate ?? FEE_RATE_PER_SIDE),
        simulateFunding: cfg.simulateFunding !== false,
        fundingRate8h: cfg.fundingRate8h ?? FUNDING_RATE_8H,
      }),
      exchange: cfg._feeModel?.exchange,
      exchangeLabel: cfg._feeModel?.exchangeLabel,
      feeSchedule: cfg._feeModel ? {
        takerFeeRate: cfg._feeModel.takerFeeRate,
        makerFeeRate: cfg._feeModel.makerFeeRate,
        fundingRate8h: cfg._feeModel.fundingRate8h,
      } : undefined,
    },
  };
}

/**
 * Compute equity curve + summary stats purely from a (chronological) trades array.
 * Extracted so the Grok Confirm Gate can filter trades and recompute stats identically.
 */
function _computeTripleStats(trades, startCapital) {
  let capital = startCapital;
  const firstDate = trades[0]?.openTime || trades[0]?.date;
  const equity = [{ date: firstDate, value: startCapital }];
  for (const t of trades) {
    capital += t.pnl;
    equity.push({ date: t.closeTime || t.date, value: round2(capital) });
  }

  const wins   = trades.filter(t => t.result === "win");
  const losses = trades.filter(t => t.result === "loss");
  const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  let peak = startCapital, mdd = 0, bal = startCapital;
  for (const t of trades) {
    bal  += t.pnl;
    peak  = Math.max(peak, bal);
    mdd   = Math.max(mdd, peak > 0 ? (peak - bal) / peak : 0);
  }

  const rets = trades.map(t => t.pnl);
  const avg  = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std  = rets.length > 1
    ? Math.sqrt(rets.reduce((s, r) => s + (r - avg) ** 2, 0) / (rets.length - 1))
    : 0;

  return {
    equity,
    stats: {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : "0.0",
      totalReturn: ((capital - startCapital) / startCapital * 100).toFixed(2),
      finalCapital: capital.toFixed(2),
      profitFactor: grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? "Inf" : "0.00"),
      avgWin:  wins.length   ? (grossWin  / wins.length).toFixed(2)   : "0.00",
      avgLoss: losses.length ? (grossLoss / losses.length).toFixed(2) : "0.00",
      riskReward: (losses.length && wins.length)
        ? ((grossWin / wins.length) / (grossLoss / losses.length)).toFixed(2)
        : "0.00",
      maxDrawdown: (mdd * 100).toFixed(2),
      sharpe: std > 0 ? ((avg / std) * Math.sqrt(252)).toFixed(2) : "0.00",
      totalFees: trades.reduce((s, t) => s + (t.fee || 0), 0).toFixed(2),
    },
  };
}

// SMART_MONEY_CONCEPTS ingress normalizes to ADAPTIVE_FUSION for Grok prompt/validation.
const GROK_KEY_ALIAS = {
  SMART_MONEY_CONCEPTS: "ADAPTIVE_FUSION",
};

/**
 * Post-hoc Grok Confirm Gate for the real (triple-TF) engine.
 * Each produced trade's ENTRY is sent to Grok; rejected entries are dropped, then
 * stats are recomputed over the survivors. Fail-open: any Grok error keeps the trade
 * (a backtest must never break because the AI is slow/unavailable).
 *
 * @param {Array}  trades          chronological trades from the engine
 * @param {Object} ctx
 * @param {string} ctx.strategyKey
 * @param {string} [ctx.symbol]
 * @param {string} [ctx.userId]
 * @param {Function} [ctx.grokConfirmFn] injectable `(signals) => Promise<{decisions,stats}>` (for tests)
 * @param {Function} [ctx.onGrokProgress]
 * @returns {Promise<{trades:Array, rejected:number, logs:Array, stats:Object}>}
 */
async function _applyGrokGate(trades, ctx = {}) {
  const grokKey = GROK_KEY_ALIAS[ctx.strategyKey] || ctx.strategyKey;

  // Map each trade → the signal shape the Grok batch processor expects.
  const signals = trades.map((t, idx) => ({
    id: idx,
    side: t.side,
    price: t.entry,
    entry: t.entry,
    atr: t.atr,
    sl: t.sl,
    tp: t.tp,
    rsi: t.entryRsi ?? undefined,
    htfTrend: t.htfTrend ?? undefined,
    confidence: t.confidence ?? undefined,
    signalReason: `${t.tradeType || t.component} real-engine entry`,
  }));

  const confirmFn = ctx.grokConfirmFn || (async (sigs) => {
    // Lazy require avoids a load-time cycle (batch → GrokConfirmService → config).
    const GrokConfirmBatchProcessor = require("../../research/services/GrokConfirmBatchProcessor");
    return GrokConfirmBatchProcessor.processBatch({
      userId: ctx.userId,
      strategyKey: grokKey,
      symbol: ctx.symbol || "BACKTEST",
      signals: sigs,
      onProgress: ctx.onGrokProgress,
    });
  });

  let decisions = {};
  try {
    const res = await confirmFn(signals);
    decisions = res?.decisions || {};
  } catch (err) {
    // Fail-open: keep every trade, surface the reason in a single log entry.
    return {
      trades,
      rejected: 0,
      logs: [{ error: true, message: `Grok gate failed (fail-open): ${err.message}` }],
      stats: { total: trades.length, approved: trades.length, rejected: 0, apiCalls: 0, failOpen: true },
    };
  }

  const kept = [];
  const logs = [];
  let approved = 0, rejected = 0;
  trades.forEach((t, idx) => {
    const d = decisions[String(idx)];
    // No decision (e.g. seeded/skipped) → fail-open keep.
    const isApproved = d ? Boolean(d.approved) : true;
    logs.push({
      time: new Date(t.openTime || t.date).getTime() || idx,
      symbol: ctx.symbol || "BACKTEST",
      side: t.side,
      tradeType: t.tradeType || t.component,
      approved: isApproved,
      confidence: d?.confidence ?? t.confidence ?? null,
      reason: d?.reason ?? (d ? null : "no-decision (kept)"),
    });
    if (isApproved) { kept.push(t); approved += 1; }
    else rejected += 1;
  });

  return {
    trades: kept,
    rejected,
    logs,
    stats: { total: trades.length, approved, rejected, apiCalls: approved + rejected },
  };
}

const RAG_CONSERVATIVE_DISCOUNT = 0.9;
const RAG_APPROVE_THRESHOLD = 0.5;

let _ragGateDeps = null;
function getRagGateDeps() {
  if (_ragGateDeps) return _ragGateDeps;
  try {
    const FeatureEngineer = require("../../ml/domain/FeatureEngineer");
    const WinPredictor    = require("../../ml/domain/WinPredictor");
    const VectorStore     = require("../../../infrastructure/db/VectorStore");
    const { _pool }       = require("../../../infrastructure/db/database");
    const fe = new FeatureEngineer();
    const wp = new WinPredictor();
    wp.load().catch(() => {});
    _ragGateDeps = { fe, wp, vs: new VectorStore(_pool) };
  } catch (err) {
    console.warn("[Backtest] RAG gate deps unavailable:", err.message);
  }
  return _ragGateDeps;
}

function _applyConservativeDiscount(score) {
  if (!Number.isFinite(score)) return 0.5;
  if (score > 0.5) return 0.5 + (score - 0.5) * RAG_CONSERVATIVE_DISCOUNT;
  return score;
}

/**
 * Post-hoc RAG / ML gate over produced backtest trades (mirrors Grok gate pattern).
 * Uses WinPredictor + time-aware pgvector similarity; fail-open when ML unavailable.
 *
 * @param {Array}  trades
 * @param {Object} ctx — { strategyKey, symbol, onRagProgress }
 */
async function _applyRagGate(trades, ctx = {}) {
  const deps = getRagGateDeps();
  if (!deps) {
    return {
      trades,
      rejected: 0,
      logs: [{ error: true, message: "RAG gate unavailable (fail-open)" }],
      stats: {
        total: trades.length,
        approved: trades.length,
        rejected: 0,
        skipped: trades.length,
        avgScore: null,
        failOpen: true,
        ineffective: true,
        message: "RAG gate deps unavailable — results match baseline (fail-open)",
      },
    };
  }

  const { fe, wp, vs } = deps;
  // Ensure model load has settled (getRagGateDeps fires load() without awaiting).
  await wp.load().catch(() => {});
  const hasModel = !!wp.model;
  // Pre-check: no model and empty/unavailable vector store → still run fail-open
  // path so ragStats are honest (skipped/failOpen/ineffective), without inventing filters.
  let vectorLikelyEmpty = false;
  try {
    const available = await vs.checkAvailability();
    if (!available) {
      vectorLikelyEmpty = true;
    } else {
      const cnt = await vs.count().catch(() => 0);
      vectorLikelyEmpty = cnt < 1;
    }
  } catch {
    vectorLikelyEmpty = true;
  }

  const sorted = [...trades].sort((a, b) => new Date(a.openTime || a.date) - new Date(b.openTime || b.date));
  const kept = [];
  const logs = [];
  let approved = 0;
  let rejected = 0;
  let skipped = 0;
  let scoreSum = 0;
  let scoreCount = 0;

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const tradeTime = new Date(t.openTime || t.date || Date.now());
    const entryContext = t.entryContext || {
      rsi: t.entryRsi,
      side: t.side,
      confidence: t.confidence,
      regime: t.regime || t.marketCond,
    };
    const tradeMetadata = {
      strategyKey: ctx.strategyKey,
      symbol: ctx.symbol || t.symbol,
      side: t.side,
    };

    let lgbScore = null;
    let ragScore = null;

    try {
      const features = fe.buildFeatureVector(entryContext, tradeMetadata);
      if (wp.model) lgbScore = wp.predict(features).pWin;
    } catch { /* ignore */ }

    try {
      const features = fe.buildFeatureVector(entryContext, tradeMetadata);
      const similar = await vs.findSimilar(features, 20, {
        symbol: tradeMetadata.symbol,
        beforeDate: tradeTime.toISOString(),
      });
      if (similar.length > 0) {
        const wins = similar.filter((s) => s.metadata?.outcome === "win").length;
        const withOutcome = similar.filter(
          (s) => s.metadata?.outcome === "win" || s.metadata?.outcome === "loss"
        ).length;
        if (withOutcome > 0) ragScore = wins / withOutcome;
      }
    } catch { /* ignore */ }

    let rawScore;
    if (lgbScore !== null && ragScore !== null) rawScore = 0.5 * lgbScore + 0.5 * ragScore;
    else if (lgbScore !== null) rawScore = lgbScore;
    else if (ragScore !== null) rawScore = ragScore;
    else {
      kept.push(t);
      approved += 1;
      skipped += 1;
      logs.push({
        time: tradeTime.getTime(),
        symbol: ctx.symbol,
        side: t.side,
        approved: true,
        reason: "no-ml-signal (kept)",
        ragScore: null,
        lgbScore: null,
      });
      if (ctx.onRagProgress) ctx.onRagProgress(i + 1, sorted.length);
      continue;
    }

    const adjusted = _applyConservativeDiscount(rawScore);
    scoreSum += adjusted;
    scoreCount += 1;
    const isApproved = adjusted >= RAG_APPROVE_THRESHOLD;

    logs.push({
      time: tradeTime.getTime(),
      symbol: ctx.symbol,
      side: t.side,
      approved: isApproved,
      adjustedScore: adjusted,
      ragScore,
      lgbScore,
      reason: isApproved ? "score >= threshold" : "score below threshold",
    });

    if (isApproved) { kept.push(t); approved += 1; }
    else rejected += 1;

    if (ctx.onRagProgress) ctx.onRagProgress(i + 1, sorted.length);
  }

  // Fail-open visibility: every trade skipped with 0 scores → ON == OFF metrics.
  const allSkippedNoScores =
    trades.length > 0 && skipped === trades.length && scoreCount === 0 && rejected === 0;
  const depsIneffective = !hasModel && vectorLikelyEmpty;
  const ineffective = allSkippedNoScores || depsIneffective;
  const failOpen = allSkippedNoScores || depsIneffective;

  const stats = {
    total: trades.length,
    approved,
    rejected,
    skipped,
    avgScore: scoreCount > 0 ? scoreSum / scoreCount : null,
    failOpen,
  };
  if (ineffective) {
    stats.ineffective = true;
    stats.message = !hasModel && vectorLikelyEmpty
      ? "No WinPredictor model and empty TradeEmbedding store — RAG ON matches baseline (fail-open)"
      : "All entries had no ML signal (kept) — RAG ON matches baseline; train a model or seed embeddings";
  }

  return {
    trades: kept,
    rejected,
    logs,
    stats,
  };
}

/**
 * Build the Scalping "filter funnel" text — SSOT so the server job, the
 * dataset-expand CLI and the inline logger all render an IDENTICAL breakdown.
 *
 * Two sections:
 *  A) STRATEGY gates (from SmartMoneyConceptsStrategy._ablation `a`) — now also
 *     surfaces the previously-hidden OB-retest gate so the setups→signals math
 *     is fully transparent.
 *  B) EXECUTION gates (from _runMultiPositionBacktest `execAbl`) — turns
 *     "N passed → 0 trades" into a precise per-gate breakdown of the loop that
 *     was previously a blind spot (signal fired vs. position opened).
 *
 * @param {Object}  a       strategy ablation counters (may be null)
 * @param {Object}  execAbl execution-stage counters (may be null)
 * @param {string}  headerLine  first line, e.g. "Scalping filter funnel (via-api, 0 trades):"
 * @returns {string}
 */
/**
 * Shared EXECUTION-stage section for the funnel. Handles BOTH engine shapes:
 *  - multi-position engine (AF): `execAbl.signalBars` + rejBy* counters
 *  - single-position engine (TS/MD/BS): the `diag` object (`barsEvaluated` + *Block)
 * so every strategy — not only SMC — gets an execution funnel.
 * @returns {string[]} lines (empty when execAbl is null/unknown-shape)
 */
function formatExecSection(execAbl) {
  const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) : "0.0");
  if (!execAbl) return [];
  // Multi-position engine (AF detectSignalMulti → positions).
  if (Object.prototype.hasOwnProperty.call(execAbl, "signalBars")) {
    return [
      `  ── Execution stage (PASSED signal → opened position) ──`,
      `  - Signals reaching execution : ${execAbl.signalBars}`,
      `  - Daily regime gate : -${execAbl.rejRegimeGate}`,
      `  - Side×Regime gate : -${execAbl.rejSideRegime}`,
      `  - Funding guard (Swing) : -${execAbl.rejFunding}`,
      `  - Position already open : -${execAbl.rejPositionOpen}`,
      `  - Cooldown after loss : -${execAbl.rejCooldown}`,
      `  - Consecutive-loss stop : -${execAbl.rejConsecLoss}`,
      `  - Max trades/day : -${execAbl.rejDailyTrades}`,
      `  - Daily-loss limit : -${execAbl.rejDailyLoss}`,
      `  - ATR range gate : -${execAbl.rejAtrGate} (${pct(execAbl.rejAtrGate, execAbl.signalBars)}% of signals)`,
      `  - SL/TP not finite : -${execAbl.rejSlTp}`,
      `  - Position size <= 0 : -${execAbl.rejSize}`,
      `  - OPENED (positions) : ${execAbl.opened}`,
    ];
  }
  // Single-position engine (strategy.detectSignal → position).
  if (Object.prototype.hasOwnProperty.call(execAbl, "barsEvaluated")) {
    return [
      `  ── Execution stage (signal → opened position) ──`,
      `  - Bars evaluated : ${execAbl.barsEvaluated}`,
      `  - HTF unknown skip : -${execAbl.htfUnknownSkip}`,
      `  - No signal this bar : -${execAbl.signalNull}`,
      `  - HTF direction block : -${execAbl.htfDirBlock}`,
      `  - HTF ADX gate : -${execAbl.adxHTFGate ?? 0}`,
      `  - Cooldown after loss : -${execAbl.cooldownBlock}`,
      `  - Consecutive-loss stop : -${execAbl.consecLossBlock}`,
      `  - Max trades/day : -${execAbl.maxTradesBlock}`,
      `  - Daily-loss limit : -${execAbl.dailyLossBlock}`,
      `  - ATR range gate : -${execAbl.atrGateBlock} (${pct(execAbl.atrGateBlock, execAbl.barsEvaluated)}% of bars)`,
      `  - validateEntry block : -${execAbl.validateBlock}`,
      `  - OPENED (positions) : ${execAbl.opened}`,
    ];
  }
  return [];
}

function normalizeFunnelLabel(label) {
  const raw = String(label || "").trim();
  const noNumber = raw.replace(/^\d+[a-z]?\.\s*/, "");
  const noArrow = noNumber.replace(/^->\s*/, "");
  const noEquals = noArrow.replace(/^=\s*/, "");
  return noEquals.trim();
}

function formatScalpingFunnel(a, execAbl, headerLine) {
  const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) : "0.0");
  const lines = [headerLine];
  if (a) {
    lines.push(
      `  - Raw setups (FVG+mitigation) : ${a.seqCandidate}`,
      `  - Rejection-wick gate : -${a.rejByRejection} (${pct(a.rejByRejection, a.seqCandidate)}% of setups)`,
      `  - OB/FVG retest gate : -${a.rejByObRetest} (${pct(a.rejByObRetest, a.seqCandidate)}% of setups)`,
      `  - Signals after rejection : ${a.seqSignal}`,
      `  - Regime hard-block : -${a.rejByRegime} (${pct(a.rejByRegime, a.seqSignal)}% of signals)`,
      `  - 5m CHoCH validation : -${a.rejByChoch}`,
      `  - UTC session filter : -${a.rejBySession ?? 0}`,
      `  - Confidence floor : -${a.rejByConf}`,
      `  - PASSED (tradeable signals) : ${a.passed}`,
    );
  }
  lines.push(...formatExecSection(execAbl));
  return lines.join("\n");
}

/**
 * Resolve the ACTIVE ablation strategy/component key for a job. Umbrella keys
 * (SMART_MONEY_CONCEPTS/TREND_FOLLOWING/MEAN_REVERSION/BREAKOUT_RETEST/ADAPTIVE_FUSION)
 * resolve to the active racer (config afActiveRacers/tsActiveRacers/… → highest-priority
 * present, default primary). Component keys (WYCKOFF, MARKET_STRUCTURE, ICT_STYLE_TRADING, …)
 * resolve to themselves. Generalizes the SMC-only smcAblationApplies() so EVERY
 * strategy surfaces its OWN funnel.
 * @returns {string|null} canonical component key, or null when unknown
 */
function resolveAblationStrategyKey(strategyKey, config = {}) {
  const strat = strategyRegistry.get(strategyKey);
  if (!strat || typeof strat.getComponentKeys !== "function") {
    return normalizeStrategyKey(strategyKey) || strategyKey || null;
  }
  const compKeys = strat.getComponentKeys();
  const upper = String(strategyKey || "").toUpperCase();
  // Direct NON-primary component selection wins (e.g. WYCKOFF, LIQUIDATION_SQUEEZE).
  if (compKeys.includes(upper) && upper !== compKeys[0]) return upper;
  // Umbrella key → resolve active racers → highest-priority present.
  let active = null;
  if (typeof strat._resolveActiveRacers === "function") {
    try { active = strat._resolveActiveRacers(config); } catch { active = null; }
  }
  if (active && active.size) {
    for (const k of compKeys) if (active.has(k)) return k;
    const first = [...active][0];
    if (first) return first;
  }
  return compKeys[0] || null;
}

/** Ordered ablation schema for a resolved component key (via registry → umbrella → component). */
function getAblationSchemaFor(componentKey) {
  const strat = strategyRegistry.get(componentKey);
  if (!strat || typeof strat.getAblationSchema !== "function") return null;
  try { return strat.getAblationSchema(componentKey); } catch { return null; }
}

/**
 * Strategy-dispatching funnel formatter. `componentKey` is the ALREADY-RESOLVED
 * active component (see resolveAblationStrategyKey). SMC keeps its bespoke,
 * byte-stable formatter; every other strategy renders from its ordered schema.
 * The shared execution-stage section is appended for all.
 */
function formatStrategyFunnel(componentKey, abl, execAbl, headerLine) {
  if (componentKey === "SMART_MONEY_CONCEPTS") {
    return formatScalpingFunnel(abl, execAbl, headerLine);
  }
  const schema = getAblationSchemaFor(componentKey);
  const lines = [headerLine];
  if (abl && Array.isArray(schema) && schema.length) {
    for (const step of schema) lines.push(`  - ${normalizeFunnelLabel(step.label)} : ${abl[step.key] ?? 0}`);
  } else if (abl) {
    for (const [k, v] of Object.entries(abl)) lines.push(`  - ${normalizeFunnelLabel(k)} : ${v}`);
  }
  lines.push(...formatExecSection(execAbl));
  return lines.join("\n");
}

/**
 * Whether the SMC "Scalping filter funnel" ablation should be emitted/attributed
 * for this job. SSOT for the 3 funnel print sites (server job, via-api CLI, inline
 * logger) so attribution is consistent across ablation + backtest + dry-run.
 *
 * The AF umbrella shares ONE SMC component instance across all racers: its
 * detectSignalMulti runs SMC's sequence EVERY bar as a side-effect (incrementing
 * SMC ablation counters) and getAblation() ALWAYS delegates to SMC — even when the
 * active racer is WYCKOFF/VSA only. So the counters are real SMC numbers but would
 * be wrongly attributed to a non-SMC racer. Gate on SMC actually racing:
 *   - non SMC/AF-umbrella keys (incl. WYCKOFF / VOLUME_SPREAD_ANALYSIS) → never
 *   - SMC/AF key whose explicit racer/voter set EXCLUDES SMC → no. This closes the
 *     FE edge case where WYCKOFF is collapsed into strategy_key
 *     "SMART_MONEY_CONCEPTS" with afActiveRacers/afActiveVoters: ["WYCKOFF"].
 *   - otherwise (SMC present, or default all-racers) → yes
 *
 * @param {string} strategyKey  canonical strategy key
 * @param {object} [config]     merged job config (afActiveRacers/afActiveVoters/…)
 * @returns {boolean}
 */
function smcAblationApplies(strategyKey, config = {}) {
  if (strategyKey !== "SMART_MONEY_CONCEPTS" && strategyKey !== "ADAPTIVE_FUSION") return false;
  const raw = config?.afActiveRacers || config?.afActiveVoters
    || config?.selectedComponents || config?.activeStrategyComponents || null;
  if (!Array.isArray(raw) || raw.length === 0) return true; // default: all racers → SMC active
  return raw.some((c) => {
    const u = String(c || "").toUpperCase();
    return u === "SMC" || normalizeStrategyKey(u) === "SMART_MONEY_CONCEPTS";
  });
}

/**
 * Run SMART_MONEY_CONCEPTS triple-timeframe backtest:
 * Each trade type (Scalping/Intraday/Swing) runs on its own candle set independently.
 * Results are merged and sorted by open time.
 *
 * @param {Object} opts
 * @param {{ Scalping: Array, Intraday: Array, Swing: Array }} opts.entryCandles - candles per type
 * @param {{ Scalping: Array, Intraday: Array, Swing: Array }} opts.htfCandles   - HTF candles per type
 * @param {string}  opts.strategyKey
 * @param {number}  opts.capital
 * @param {Object}  [opts.config]
 * @param {boolean} [opts.enableFees]
 * @param {boolean} [opts.enableSlippage]
 * @param {boolean} [opts.grokGate]     - post-hoc Grok Confirm Gate over produced trades
 * @param {string}  [opts.userId]
 * @param {string}  [opts.symbol]
 * @param {Function}[opts.grokConfirmFn]- injectable confirm fn (tests)
 * @param {Function}[opts.onGrokProgress]
 */
async function runTripleTypeBacktest(opts = {}) {
  const { strategyKey = "SMART_MONEY_CONCEPTS", capital: startCapital = 1000, enableFees = true, enableSlippage = false } = opts;

  const validation = strategyRegistry.validate(strategyKey);
  if (!validation.valid) throw new Error(`Invalid strategy "${strategyKey}": ${validation.error}`);
  const strategy = validation.strategy;

  const feeModel = resolveFeeModel({ ...opts, enableFees });
  const base = resolveStrategyDefaults(strategyKey);
  const cfg = mergeBacktestCfg(base, opts.config, feeModel);
  const feeRate = feeModel.feeRate;
  const slip    = enableSlippage ? (cfg.slippagePct ?? DEFAULT_SLIPPAGE) : 0;

  // opts.typeOrder: Advance-config subset (e.g. ["Swing"]); risk weights normalize
  // over the ACTIVE types only, so a single active type gets the full combined cap.
  const typeOrder = Array.isArray(opts.typeOrder) && opts.typeOrder.length
    ? opts.typeOrder
    : ["Scalping", "Intraday", "Swing"];
  const allTrades = [];
  const perTypeStats = {};

  // Capital is shared across types (concurrent risk).
  // riskPerTrade = COMBINED cap across all concurrent components; v2.8 splits it
  // by TYPE_RISK_WEIGHTS (Scalping 0.5 : Intraday 1 : Swing 2) instead of equally,
  // so Swing runners get full size and Scalping chop gets the least. Live parity:
  // BotEngine._handleMultiPositionSignal uses the SAME riskShareForType helper.
  // FULL PARITY: keep cooldownAfterLoss / maxConsecLoss from strategy config
  // (previously forced cooldown=0 and maxConsecLoss≥5 — broke 1:1 with live).
  const baseTypeConfig = {
    ...cfg,
  };


  // combined cap), normalized over the strategy's natural type set — running a
  // SUBSET (Advance type filter) must not inflate the remaining legs' risk.
  const riskTypeOrder = Array.isArray(opts.naturalTypeOrder) && opts.naturalTypeOrder.length
    ? opts.naturalTypeOrder
    : ["Scalping", "Intraday", "Swing"];
  for (const tradeType of typeOrder) {
    const typeConfig = {
      ...baseTypeConfig,

      // Lets the FE A/B new entry-engine flags on Scalping/Intraday while the
      // proven Swing leg keeps EXACT baseline behaviour. Ladder risk stays
      // authoritative (applied after the spread).
      ...(cfg.typeOverrides?.[tradeType] ?? {}),
      riskPerTrade: riskShareForType(tradeType, riskTypeOrder, cfg.riskPerTrade ?? 0.01),
    };
    const entryCandles = opts.entryCandles?.[tradeType];
    const htfCandles   = opts.htfCandles?.[tradeType];

    if (!entryCandles?.length || entryCandles.length < 60) {
      perTypeStats[tradeType] = { skipped: true, reason: "Insufficient candles" };
      continue;
    }


    // can report exactly which gate throttles trade frequency in this run.
    if (typeof strategy.resetAblation === "function") {
      strategy.resetAblation();
    }


    // the most liquid pair — 0.05% default overstates fills; Scalping can set 0.02%.
    const typeSlip = enableSlippage
      ? (typeConfig.slippagePct ?? cfg.slippagePct ?? DEFAULT_SLIPPAGE)
      : 0;

    const typeResult = await _runMultiPositionBacktest(
      {
        ...opts,
        strategyKey,
        config: typeConfig,
        debug: false,
        activeComponents: [tradeType],
        abortSignal: opts.abortSignal,
        onProgress: opts.onProgress
          ? (pct, bar, total) => opts.onProgress(pct, bar, total, tradeType)
          : undefined,
      },
      strategy,
      typeConfig,
      feeRate,
      typeSlip,
      entryCandles,
      htfCandles || null,
    );

    // Tag each trade with its type (overwrite component field)
    for (const t of typeResult.trades) {
      allTrades.push({ ...t, component: tradeType, tradeType });
    }
    perTypeStats[tradeType] = {
      trades: typeResult.trades.length,
      wins: typeResult.trades.filter(t => t.result === "win").length,
      entryBars: entryCandles.length,
      htfBars: htfCandles?.length ?? 0,
      // Execution-stage funnel — how PASSED (strategy-gate) signals turn into
      // opened positions. Surfaces the blind spot between detectSignalMulti and
      // positions.set (e.g. the ATR relative gate eating every signal on real data).
      execAblation: typeResult.execAblation ?? null,
    };


    // exactly how many raw setups each gate removed → identifies the throttle
    // without running an N-way ablation.
    // Each AF component owns its OWN funnel counters. Resolve the ACTIVE racer
    // (SMC / WYCKOFF / VSA) so WYCKOFF/VSA jobs now surface THEIR own funnel
    // instead of SMC's (SMC's sequence still runs every bar as a side-effect, but
    // we read+attribute the active racer's counters).
    const ablKey = resolveAblationStrategyKey(strategyKey, typeConfig);
    if (ablKey && typeof strategy.getAblation === "function") {
      const a = strategy.getAblation(ablKey);
      if (a || perTypeStats[tradeType].execAblation) {
        const funnelText = formatStrategyFunnel(
          ablKey,
          a,
          perTypeStats[tradeType].execAblation,
          `${ablKey} filter funnel (${tradeType}, ${entryCandles.length} bars, ${allTrades.length} trades so far):`,
        );
        console.log(funnelText);
        perTypeStats[tradeType].ablation = a;
        perTypeStats[tradeType].ablationKey = ablKey;


        // clean file instead of grepping the noisy shared PM2 log. Includes the
        // running commit hash so we can confirm WHICH backend produced it (the
        // prod-vs-staging confusion). Overwritten each run.
        try {
          const outPath = path.join(process.cwd(), "ablation.txt");
          let commit = "unknown";
          try {
            commit = require("child_process")
              .execSync("git rev-parse --short HEAD", { cwd: process.cwd() })
              .toString().trim();
          } catch { /* git not available — ignore */ }
          const meta = opts.ablationMeta || {};
          const header = [
            `commit: ${commit}`,
            `strategy: ${ablKey}`,
            `tradeType: ${tradeType}`,
            `symbol: ${opts.symbol ?? "?"}`,
            `dataSource: ${opts.dataSource ?? "ui-backtest"}`,
            meta.exchange ? `exchange: ${meta.exchange}` : (opts.exchangeType ? `exchange: ${opts.exchangeType}` : null),
            meta.entryTf && meta.htfTf ? `timeframes: ${meta.entryTf}/${meta.htfTf}` : null,
            meta.entryBars != null ? `entryBars: ${meta.entryBars}` : null,
            meta.htfBars != null ? `htfBars: ${meta.htfBars}` : null,
            meta.coverage != null ? `coverage: ${meta.coverage}%` : null,
          ].filter(Boolean).join("\n");
          fs.writeFileSync(
            outPath,
            `${header}\n\n${funnelText}\n`,
            "utf8",
          );
        } catch (e) {
          console.log("gagal tulis file ablation:", e.message);
        }
      }
    }
  }

  // Sort all trades by openTime
  allTrades.sort((a, b) => new Date(a.openTime || a.date) - new Date(b.openTime || b.date));

  // ── GROK CONFIRM GATE (post-hoc, AF real engine) ──────────────────────────
  // Send each produced entry to Grok; drop rejected trades, then recompute stats
  // over the survivors. This is what makes the "Grok Confirm Gate (AI)" toggle
  // actually affect Adaptive Fusion (previously bypassed).
  let grokResult = null;
  if (opts.grokGate) {
    grokResult = await _applyGrokGate(allTrades, {
      strategyKey,
      symbol: opts.symbol,
      userId: opts.userId,
      grokConfirmFn: opts.grokConfirmFn,
      onGrokProgress: opts.onGrokProgress,
    });
  }
  let workingTrades = grokResult ? grokResult.trades : allTrades;

  let ragResult = null;
  if (opts.ragGate) {
    ragResult = await _applyRagGate(workingTrades, {
      strategyKey,
      symbol: opts.symbol,
      onRagProgress: opts.onRagProgress,
    });
    workingTrades = ragResult.trades;
  }
  const finalTrades = workingTrades;

  const { equity, stats } = _computeTripleStats(finalTrades, startCapital);

  return {
    ok: true,
    trades: finalTrades,
    equity,
    perTypeStats,
    stats,
    grokGate: !!opts.grokGate,
    grokStats: grokResult?.stats ?? null,
    grokLogs: grokResult?.logs ?? null,
    ragGate: !!opts.ragGate,
    ragStats: ragResult?.stats ?? null,
    ragLogs: ragResult?.logs ?? null,
    meta: {
      strategyKey,
      mode: "triple-timeframe",
      perTypeStats,
      grokGate: !!opts.grokGate,
      grokStats: grokResult?.stats ?? null,
      ragGate: !!opts.ragGate,
      ragStats: ragResult?.stats ?? null,
      exchange: feeModel.exchange,
      exchangeLabel: feeModel.exchangeLabel,
      feeSchedule: {
        takerFeeRate: feeModel.takerFeeRate,
        makerFeeRate: feeModel.makerFeeRate,
        fundingRate8h: feeModel.fundingRate8h,
      },
    },
  };
}

async function runRealBacktest(opts = {}) {
  const {
    entryCandles = [],
    htfCandles = null,
    strategyKey = "ADAPTIVE_FUSION",
    capital: startCapital = 1000,
    enableFees = true,
    enableSlippage = false,
  } = opts;

  const validation = strategyRegistry.validate(strategyKey);
  if (!validation.valid) {
    throw new Error(`Invalid strategy "${strategyKey}": ${validation.error}`);
  }
  const strategy = validation.strategy;

  // Canonical live config (legacyStrategies) merged with caller overrides.
  const feeModel = resolveFeeModel({ ...opts, enableFees });
  const base = resolveStrategyDefaults(strategyKey);
  const cfg = mergeBacktestCfg(base, opts.config, feeModel);

  const feeRate = feeModel.feeRate;
  const slip = enableSlippage ? (cfg.slippagePct ?? DEFAULT_SLIPPAGE) : 0;

  // Multi-position mode (v3.0): ADAPTIVE_FUSION opens up to 3 concurrent positions
  const multiPosMode = opts.useMultiPosition || strategyKey === "ADAPTIVE_FUSION";

  if (multiPosMode) {
    return await _runMultiPositionBacktest(opts, strategy, cfg, feeRate, slip, entryCandles, htfCandles);
  }

  return await _runSinglePositionBacktest(opts, strategy, cfg, feeRate, slip, entryCandles, htfCandles);
}

/**
 * Single-position engine (strategy.detectSignal contract — SL/TP only, no fusion
 * voting). Used by runRealBacktest's non-AF single-TF path, and by
 * runMultiTypeBacktest below (TREND_FOLLOWING/MEAN_REVERSION running as a subset of AF's own
 * Scalping/Intraday/Swing "types" — one call per type — so a failing type
 * degrades to 0 trades instead of killing the whole backtest, mirroring AF's
 * triple-TF resilience without AF's detectSignalMulti fusion logic).
 */
async function _runSinglePositionBacktest(opts, strategy, cfg, feeRate, slip, entryCandles, htfCandles) {
  const strategyKey = opts.strategyKey || "ADAPTIVE_FUSION";
  const startCapital = opts.capital || 1000;
  const tsCombo = resolveTsCombination(cfg);
  const tsCombinationMode = tsCombo.tsCombinationMode;
  const tsUseStructureGate = tsCombo.tsUseStructureGate;
  const tsUseVwapPrecision = tsCombo.tsUseVwapPrecision;
  const tsSelectedComponents = tsCombo.selectedComponents || cfg.selectedComponents;
  const mdCombo = resolveMdCombination(cfg);
  const bsCombo = resolveBsCombination(cfg);
  const mdSelectedComponents = mdCombo.selectedComponents || cfg.selectedComponents;
  const bsSelectedComponents = bsCombo.selectedComponents || cfg.selectedComponents;
  const raceSelected =
    (isTFKey(strategyKey) && tsSelectedComponents)
    || (isMRKey(strategyKey) && mdSelectedComponents)
    || (isBRKey(strategyKey) && bsSelectedComponents)
    || cfg.selectedComponents;
  const strategyDisplayName = resolveStrategyDisplayName(strategyKey, {
    ...cfg,
    selectedComponents: raceSelected,
    tsCombinationMode,
    mdCombinationMode: mdCombo.mdCombinationMode,
    bsCombinationMode: bsCombo.bsCombinationMode,
  });

  // TrendSurge/TF is a process singleton — reset directional state between runs
  // so a prior SHORT streak cannot contaminate the next backtest.
  if (typeof strategy.resetTrendState === "function") {
    strategy.resetTrendState();
  } else if (strategy._tf && typeof strategy._tf.resetTrendState === "function") {
    strategy._tf.resetTrendState();
  }

  // Per-strategy ablation counters — reset every run (umbrella resets ALL its
  // component racers). detectSignal below increments the active racer's OWN funnel.
  if (typeof strategy.resetAblation === "function") strategy.resetAblation();
  const ablComponentKey = resolveAblationStrategyKey(strategyKey, cfg);

  const indicators = calcIndicators(entryCandles, {
    emaFast: cfg.emaFast ?? 9,
    emaSlow: cfg.emaSlow ?? 21,
    emaTrend: cfg.emaTrend ?? 50,
    rsiPeriod: cfg.rsiPeriod ?? 14,
    atrPeriod: cfg.atrPeriod ?? 14,
  });

  if (isSaKey(strategyKey) && opts.btcEntryCandles?.length) {
    const sym = String(opts.symbol || "").toUpperCase();
    if (sym && sym !== "BTCUSDT") {
      const aligned = alignBenchmarkCloses(entryCandles, opts.btcEntryCandles);
      if (aligned?.some((v) => v != null)) {
        indicators.btcCloses = aligned;
        indicators.benchmarkCloses = aligned;
      }
    }
  }

  // MEAN_REVERSION entry-TF ADX regime gate (MD-SUB-01)
  const isMeanReversion = isMRKey(strategyKey);
  if (isMeanReversion) {
    indicators.adx = calcADX(indicators.highs, indicators.lows, indicators.closes, 14).adx;
  }

  // MR regime filter (FIX-MR-01): precompute HTF indicators once for regime checks
  // per-bar (O(1) lookup). Live BotEngine computes these fresh per tick, but
  // backtest can cache since HTF data is static.
  let htfIndicators = null;

  // tfHtfLayerEnabled gates the whole TF Layer-1 path (injection + ADX gate) so
  // A/B harnesses can run a true control; default ON per TREND_FOLLOWING config defaults.
  const tfHtfLayer = isTFKey(strategyKey) && cfg.tfHtfLayerEnabled !== false;
  const needsHTF = isMeanReversion || tfHtfLayer;
  if (needsHTF && htfCandles?.length >= 30) {
    const htfCloses = htfCandles.map(c => c.close);
    const htfHighs  = htfCandles.map(c => c.high);
    const htfLows   = htfCandles.map(c => c.low);
    const htfAtrArr = calcATR(htfHighs, htfLows, htfCloses, 14);
    const htfAtrSma = calcSMA(htfAtrArr.filter(v => v != null), 20);
    // calcADX returns { adx, plusDI, minusDI } — keep only the adx ARRAY.
    // (First cut stored the whole object: adx[j] was then always undefined and
    // the fail-closed gate below skipped EVERY entry → 0 trades on all legs.)
    const htfAdx = calcADX(htfHighs, htfLows, htfCloses, 14).adx;
    htfIndicators = {
      emaFast: calcEMA(htfCloses, 9),
      emaSlow: calcEMA(htfCloses, 21),
      rsi: calcRSI(htfCloses, 14),
      atr: htfAtrArr,
      atrSma: htfAtrSma, // rolling SMA of ATR for ratio check
      adx: htfAdx,
      close: htfCloses,
    };

    // (TrendFollowingStrategy.detectSignal reads closesHTF, emaFastHTF, emaMidHTF,
    // emaSlowHTF, adxHTF). Index alignment comes from config.htfIdx per bar — the
    // strategy's built-in ratio-12 mapping assumes 5m→1h and reads FUTURE bars on
    // the 15m→4h / 4h→1w legs (measured: PF 0.83 → 0.49 when misaligned).
    if (tfHtfLayer) {
      indicators.closesHTF = htfCloses;
      indicators.highsHTF = htfHighs;
      indicators.lowsHTF = htfLows;
      indicators.emaFastHTF = htfIndicators.emaFast;
      indicators.emaMidHTF = htfIndicators.emaSlow;
      indicators.emaSlowHTF = calcEMA(htfCloses, 50); // 50-bar EMA for HTF slow
      indicators.adxHTF = htfAdx;
    }
  }

  // Session VWAP (AUCTION_MARKET_THEORY) needs timestamps even when HTF layer is off.
  if (!indicators.timestamps) {
    indicators.timestamps = entryCandles.map(c => c.timestamp ?? c.openTime ?? c.time ?? null);
  }

  const htfPtr = htfCandles?.length
    ? buildHtfIndexPointer(entryCandles, htfCandles)
    : null;
  const htfTrendCache = new Map(); // htfIdx → trend string (recompute only on advance)

  function htfTrendAt(i) {
    if (!htfPtr) return null;
    const j = htfPtr[i];
    if (j < 0) return "UNKNOWN"; // no closed HTF candle yet → fail-closed (live parity)
    if (htfTrendCache.has(j)) return htfTrendCache.get(j);
    const window = htfCandles.slice(0, j + 1);
    const trend = detectHTFTrend(window, {
      htfEmaFast: cfg.htfEmaFast ?? 9,
      htfEmaSlow: cfg.htfEmaSlow ?? 21,
      sidewaysThresholdPct: cfg.sidewaysThresholdPct ?? 0.2,
    });
    htfTrendCache.set(j, trend);
    return trend;
  }

  // Pre-compute daily trend strength for regime gate (single-position engine)
  let dailyTrendCache = null;
  if (opts.dailyCandles?.length) {
    const dTrend = computeDailyTrendStrength({
      close: opts.dailyCandles.map(c => c.close),
      high: opts.dailyCandles.map(c => c.high),
      low: opts.dailyCandles.map(c => c.low),
    });
    const dMap = new Map();
    for (let di = 0; di < opts.dailyCandles.length; di++) {
      dMap.set(new Date(opts.dailyCandles[di].timestamp).toISOString().split("T")[0], di);
    }
    dailyTrendCache = { dailyTrend: dTrend, dateMap: dMap };
  }

  // ── Replay state (mirror BotEngine state used by _checkRiskGates) ──────────
  let capital = startCapital;
  const trades = [];
  const equity = [{ date: isoOf(entryCandles[0]), value: capital }];

  let position = null; // { side, entry, sl, tp, slDist, size, openIdx, component, marketCond }

  // truth `close > EMA9` on the breakout bar — it fires at the EXTENDED price and
  // parks the SL inside the retest zone (geometry diagnostic: edge only exists at
  // tight SL, and fee/R at 15m eats it). retestEntryEnabled converts the signal
  // into a resting limit `retestPullbackAtr × ATR` behind the signal close: fills
  // only if price pulls back (better entry, maker by construction), cancels after
  // retestTtlBars if the move runs away without a retest.
  let pendingOrder = null; // { side, limit, slDist, tpDist, expiresIdx, ... }
  let cooldownUntil = 0; // ms epoch
  let consecLoss = 0;
  let dayKey = null;
  let dailyTradeCount = 0;
  let dailyLoss = 0;
  let dailyStartCapital = capital;

  const maxConsecLoss = cfg.maxConsecLoss ?? 3;
  const maxTradesPerDay = cfg.maxTradesPerDay ?? 6;
  const maxDailyLossPct = cfg.maxDailyLossPct ?? 0.03;
  // Per-leg atrMinMult/atrMaxMult (typeOverrides[tradeType]) override the
  // absolute floor so each TF gets its own band. runMultiTypeBacktest already
  // spreads the override onto cfg.atrMinMult; this lookup makes the resolution
  // explicit and safe even if a full (un-spread) config reaches this engine.
  const legAtrOv = cfg.typeOverrides?.[cfg.tradeType] || {};
  const atrMinPct = legAtrOv.atrMinMult ?? cfg.atrMinMult ?? 0;
  const atrMaxPct = legAtrOv.atrMaxMult ?? cfg.atrMaxMult ?? Infinity;

  // atrGateRelative is a PER-LEG flag (typeOverrides[tradeType].atrGateRelative) —
  // read it off legAtrOv (already resolved above), falling back to top-level cfg
  // for callers that flattened it there. Previously this read cfg.atrGateRelative
  // only, which is never set at top level, permanently disabling the relative gate.
  // Band defaults 0.4–4.0 mirror strategyDefaults DEFAULT_LEG_TYPE_OVERRIDES.Scalping
  // (the SSOT the flattened via-api config carries) so backtest == dry-run == live.
  const legAtrGateRelative = legAtrOv.atrGateRelative ?? cfg.atrGateRelative ?? false;
  const atrBaseline = legAtrGateRelative === true ? buildAtrBaseline(indicators.atr) : null;
  const atrRelMin = legAtrOv.atrRelMin ?? cfg.atrRelMin ?? 0.4;
  const atrRelMax = legAtrOv.atrRelMax ?? cfg.atrRelMax ?? 4.0;
  const cooldownMs = (cfg.cooldownAfterLoss ?? 0) * 60000;
  const riskPerTrade = cfg.riskPerTrade ?? 0.01;
  const higherTf = cfg.higherTf ?? null;

  const warmup = Math.max(cfg.emaSlow ?? 21, cfg.atrPeriod ?? 14, 30) + 2;
  const totalBars = entryCandles.length;
  const progressEvery = Math.max(500, Math.floor(totalBars / 100));

  // Gate funnel — counts WHY candles don't become trades (diagnose 0-trade runs).
  const diag = {
    barsEvaluated: 0, htfUnknownSkip: 0, signalNull: 0, htfDirBlock: 0,
    cooldownBlock: 0, consecLossBlock: 0, maxTradesBlock: 0, dailyLossBlock: 0,
    atrGateBlock: 0, validateBlock: 0, sessionBlock: 0, opened: 0,
  };

  // SL+ Trailing Partial Take Profit (mirrors BotEngine._checkSLPlusMilestones).
  // BREAKOUT_RETEST Sprint 14 QA: prefer full TP; if partial forced, first take ≤33%.
  const brPartialCap = isBRKey(strategyKey);
  const tpModeCfg = cfg.tpMode ?? "full";
  const slPlusEnabled = tpModeCfg === "partial" && (cfg.slPlusEnabled ?? true);
  const slPlusPartial1Pct = cfg.slPlusPartial1Pct ?? (brPartialCap ? 0.33 : 0.40);
  const slPlusPartial2Pct = cfg.slPlusPartial2Pct ?? 0.275;
  // Ladder trigger R-multiples, per-leg tunable via typeOverrides (cfg here is
  // the per-type merged config). Mirrors the multi-position engine — the knob
  // was added there first and this single-position engine (the one TREND_FOLLOWING/MEAN_REVERSION
  // actually run through) kept the hardcoded 1.0/2.0, silently ignoring it.
  const slPlusM1R = cfg.slPlusM1R ?? 1.0;
  const slPlusM2R = cfg.slPlusM2R ?? 2.0;

  function checkPartialMilestones(c, exitIdx) {
    if (!slPlusEnabled || !position || position.remainingSize <= 0) return;
    const R = position.R;
    if (!Number.isFinite(R) || R <= 0) return;

    const favorableExtreme = position.side === "LONG" ? c.high : c.low;
    const gain = position.side === "LONG" ? favorableExtreme - position.entry : position.entry - favorableExtreme;
    const rMult = gain / R;

    const partialAt = (price, size, reason, newSL) => {
      let px = price;
      if (slip) px = position.side === "LONG" ? px * (1 - slip) : px * (1 + slip);
      const grossPnl = position.side === "LONG" ? (px - position.entry) * size : (position.entry - px) * size;
      const fee = feeRate * (position.entry + px) * size;
      const pnl = grossPnl - fee;
      capital += pnl;
      position.remainingSize -= size;
      position.slCurrent = newSL;
      trades.push(withBacktestEntryContext({
        date: isoOf(c),
        openTime: isoOf(entryCandles[position.openIdx]),
        closeTime: isoOf(c),
        side: position.side,
        strategy: strategyKey,
        component: position.component,
        marketCond: position.marketCond,
        entry: position.entry,
        exit: px,
        sl: position.sl,
        tp: position.tp,
        size,
        grossPnl,
        fee,
        pnl,
        pnlPct: (pnl / (position.entry * size)) * 100,
        plannedRR: position.plannedRR,
        confidence: position.confidence ?? null,
        atr: position.atr ?? null,
        entryRsi: position.entryRsi ?? null,
        htfTrend: position.htfTrend ?? null,
        dailyRegime: position.dailyRegime ?? null,
        entryMeta: position.entryMeta ?? null,
        reason,
        result: pnl > 0 ? "win" : "loss",
        isPartial: true,
      }, position, strategyKey, position.strategyLabel || strategyDisplayName));
    };

    // Milestone 1: +slPlusM1R → partial 40%, SL → +0.3R (NOT pure BEP).
    // 4yr VAULT backtest showed runners parked at exact BEP died on the first
    // shallow pullback: TF 4/5 and MR 3/3 partial-triggered trades exited via
    // SL_TRAIL at ~breakeven and never reached +2R/full TP. +0.3R keeps a small
    // locked profit while giving the runner breathing room below +1R.
    if (!position.m1 && rMult >= slPlusM1R) {
      position.m1 = true;
      const partial = position.originalSize * slPlusPartial1Pct;
      const newSL = position.side === "LONG"
        ? position.entry + 0.3 * R
        : position.entry - 0.3 * R; // +0.3R buffer
      if (partial > 0 && partial < position.remainingSize) {
        partialAt(position.entry + (position.side === "LONG" ? slPlusM1R * R : -slPlusM1R * R), partial, "Partial_1R", newSL);
      } else {
        position.slCurrent = newSL;
      }
    }

    // Milestone 2: +slPlusM2R → partial 27.5% of ORIGINAL (capped to 90% of remaining), SL → +1R
    if (position.m1 && !position.m2 && rMult >= slPlusM2R) {
      position.m2 = true;
      const fromOriginal = position.originalSize * slPlusPartial2Pct;
      const partial = Math.min(fromOriginal, position.remainingSize * 0.90);
      const newSL = position.side === "LONG" ? position.entry + R : position.entry - R; // +1R
      if (partial > 0 && partial < position.remainingSize) {
        partialAt(position.entry + (position.side === "LONG" ? slPlusM2R * R : -slPlusM2R * R), partial, "Partial_2R", newSL);
      } else {
        position.slCurrent = newSL;
      }
    }

    // Milestone 3: +3R → log-only marker, no partial (mirrors live)
    if (position.m1 && position.m2 && !position.m3 && rMult >= 3.0) {
      position.m3 = true;
    }
  }

  function closePosition(exitPrice, reason, exitIdx) {

    // entry limit → maker; TP limit → maker (no slip); SL/time market → taker (slip).
    const compOv = cfg.typeOverrides?.[position.component] || {};
    const useMaker = compOv.makerEntry === true || cfg.makerEntry === true;
    const makerRate = cfg.makerFeeRate ?? 0.0002;
    const isLimitExit = reason === "TP";
    const closeSize = position.remainingSize;

    let px = exitPrice;
    if (slip && !(useMaker && isLimitExit)) {
      px = position.side === "LONG" ? px * (1 - slip) : px * (1 + slip);
    }
    const grossPnl = position.side === "LONG"
      ? (px - position.entry) * closeSize
      : (position.entry - px) * closeSize;
    const entryFeeRate = useMaker ? makerRate : feeRate;
    const exitFeeRate  = (useMaker && isLimitExit) ? makerRate : feeRate;
    const fee = entryFeeRate * position.entry * closeSize + exitFeeRate * px * closeSize;
    const openTs = entryCandles[position.openIdx]?.timestamp ?? 0;
    const closeTs = entryCandles[exitIdx]?.timestamp ?? 0;
    const funding = estimateFundingCost(
      position.entry, closeSize, openTs, closeTs,
      cfg.simulateFunding !== false && feeRate > 0,
      cfg.fundingRate8h ?? FUNDING_RATE_8H
    );
    const pnl = grossPnl - fee - funding;
    capital += pnl;

    let feeOut = fee;
    if (feeRate > 0 && closeSize > 0 && feeOut === 0) {
      feeOut = feeRate * (position.entry + px) * closeSize;
    }

    if (pnl < 0) {
      consecLoss += 1;
      dailyLoss += Math.abs(pnl);
      cooldownUntil = (entryCandles[exitIdx].timestamp ?? 0) + cooldownMs;
    } else {
      consecLoss = 0;
    }

    const closeTime = isoOf(entryCandles[exitIdx]);
    const holdHours = holdHoursBetween(openTs, closeTs);
    const excursions = computeExcursionFields(position, px);
    trades.push(withBacktestEntryContext({
      date: closeTime, // display field (FE trade table reads t.date) — close-bar date
      openTime: isoOf(entryCandles[position.openIdx]),
      closeTime,
      side: position.side,
      strategy: strategyKey,
      component: position.component,
      marketCond: position.marketCond,
      entry: position.entry,
      exit: px,
      sl: position.sl,
      tp: position.tp,
      size: closeSize,
      grossPnl,
      fee: feeOut,
      funding,
      pnl,
      pnlPct: closeSize > 0 ? (pnl / (position.entry * closeSize)) * 100 : 0,
      plannedRR: position.plannedRR,
      confidence: position.confidence ?? null,
      atr: position.atr ?? null,
      entryRsi: position.entryRsi ?? null,
      htfTrend: position.htfTrend ?? null,
      dailyRegime: position.dailyRegime ?? null,
      entryMeta: position.entryMeta ?? null,
      holdHours,
      fundingRateAtEntry: position.fundingRateAtEntry ?? null,
      fundingForecast24h: position.fundingForecast24h ?? null,
      mfe: excursions.mfe,
      mae: excursions.mae,
      mfePercent: excursions.mfePercent,
      maePercent: excursions.maePercent,
      exitEfficiency: excursions.exitEfficiency,
      reason,
      result: pnl > 0 ? "win" : "loss",
      isPartial: false,
    }, position, position.winningComponent || strategyKey, position.strategyLabel || strategyDisplayName));
    position = null;
  }

  for (let i = warmup; i < entryCandles.length; i++) {
    // Abort + progress + event-loop yield (BT-FIX parity with the multi-position
    // path). Without these, a large 5m/15m dataset (TF/MR) runs the whole loop
    // SYNCHRONOUSLY → blocks Node's single thread → job-status polls hang → the
    // FE aborts at ~10s → "Request timed out".
    if (opts.abortSignal?.aborted) break;
    if (i % progressEvery === 0 && opts.onProgress) {
      opts.onProgress(Math.round(i / totalBars * 100), i, totalBars);
    }
    const yieldEvery = totalBars > 20_000 ? 250 : 500;
    if (i % yieldEvery === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const c = entryCandles[i];
    const price = c.close;
    const atr = scalarIndicator(indicators.atr[i], { min: 0, max: 1e9 });
    if (atr == null || price == null) {
      equity.push({ date: isoOf(c), value: round2(capital) });
      continue;
    }

    // Daily counters reset (UTC day) — mirror BotEngine daily roll.
    const dk = (isoOf(c) || "").slice(0, 10);
    if (dk !== dayKey) {
      dayKey = dk;
      dailyTradeCount = 0;
      dailyLoss = 0;
      dailyStartCapital = capital;
      // Daily reset: live BotEngine's maxConsecLoss means "stop trading HARI INI"
      // (state resets each day). Without this reset the single-position engine
      // blocked a strategy FOREVER after one bad streak — e.g. BREAKOUT_RETEST stopped
      // trading after 3 straight SLs in week 1 of a 12-month run.
      consecLoss = 0;
    }

    // ── 1. Manage open position FIRST (intrabar SL/TP, SL checked first) ─────
    if (position) {
      updatePositionExcursions(position, c);
      checkPartialMilestones(c, i);
    }
    if (position) {
      const stopLevel = position.slCurrent;
      const hitSL = position.side === "LONG" ? c.low <= stopLevel : c.high >= stopLevel;
      const hitTP = position.side === "LONG" ? c.high >= position.tp : c.low <= position.tp;

      let hitMeanExit = false;
      if (isSaKey(strategyKey) && cfg.mdSaExitAtMean !== false) {
        const exitZ = cfg.mdSaExitZ ?? 0.4;
        const zNow = computeStatisticalArbitrageZ({
          closes: indicators.closes,
          vwap: indicators.vwap,
          benchmarkCloses: indicators.benchmarkCloses || indicators.btcCloses,
          lastIdx: i,
          config: cfg,
        });
        if (zNow != null && Math.abs(zNow) <= exitZ) {
          hitMeanExit = true;
          closePosition(price, "MEAN_EXIT", i);
        }
      }

      // typeOverrides[tradeLeg].maxHoldHours (was Scalping-only/scalpingMaxHoldHours;
      // TREND_FOLLOWING forensics showed >=24h-underwater positions accounted for -76.8 of the
      // -230.8 net loss on the Intraday/Swing legs — a hung thesis is a dead thesis).
      // Exit at market price if time exceeded to prevent slot-blocking.
      let hitTimeStop = false;
      const tradeLeg = resolvePositionTradeLeg(position, cfg);
      const holdOv = cfg.typeOverrides?.[tradeLeg] || {};
      const maxHoldHours = holdOv.maxHoldHours
        ?? holdOv.scalpingMaxHoldHours
        ?? holdOv.swingMaxHoldHours
        ?? (tradeLeg === "Scalping" ? cfg.maxHoldHours : undefined);
      // MEAN_EXIT / partial close may null `position` mid-block — guard before
      // TIME_STOP (W4-W5 SA Swing walk-forward crashed on position.openIdx here).
      if (position && maxHoldHours) {
        const openTs = entryCandles[position.openIdx]?.timestamp ?? 0;
        const holdMs = (c.timestamp ?? 0) - openTs;
        const maxHoldMs = maxHoldHours * 3600 * 1000;
        if (holdMs > maxHoldMs) {
          hitTimeStop = true;
          closePosition(price, "TIME_STOP", i);  // exit at market price
        }
      }

      if (position && !hitTimeStop && !hitMeanExit) {
        if (hitSL) closePosition(stopLevel, position.m1 ? "SL_TRAIL" : "SL", i);
        else if (hitTP) closePosition(position.tp, "TP", i);
      }
    }

    if (position) { // still open → no new entry
      equity.push({ date: isoOf(c), value: round2(capital) });
      continue;
    }


    if (pendingOrder) {
      if (i > pendingOrder.expiresIdx) {
        pendingOrder = null; // move ran away without a retest — no chase
      } else {
        const touched = pendingOrder.side === "LONG"
          ? c.low <= pendingOrder.limit
          : c.high >= pendingOrder.limit;
        if (touched) {
          const entry = pendingOrder.limit; // limit fill — no slippage, maker
          const size = (capital * pendingOrder.riskPerTrade) / pendingOrder.slDist;
          const openSl = pendingOrder.side === "LONG" ? entry - pendingOrder.slDist : entry + pendingOrder.slDist;
          position = {
            side: pendingOrder.side,
            entry,
            sl: openSl,
            tp: pendingOrder.side === "LONG" ? entry + pendingOrder.tpDist : entry - pendingOrder.tpDist,
            slDist: pendingOrder.slDist,
            size,
            openIdx: i,
            component: pendingOrder.component,
            tradeType: pendingOrder.tradeType ?? resolvePositionTradeLeg(pendingOrder, cfg),
            marketCond: pendingOrder.marketCond,
            plannedRR: pendingOrder.plannedRR,
            confidence: pendingOrder.confidence,
            atr: pendingOrder.atr ?? null,
            entryRsi: pendingOrder.entryRsi ?? null,
            htfTrend: pendingOrder.htfTrend ?? null,
            dailyRegime: pendingOrder.dailyRegime ?? null,
            entryMeta: pendingOrder.entryMeta ?? null,
            strategyLabel: pendingOrder.strategyLabel || strategyDisplayName,
            winningComponent: pendingOrder.winningComponent || pendingOrder.component,
            // Sprint 14/15 ML enrichments carried on the pending order
            ...Object.fromEntries(
              ["bbSqueezeWidthAtr", "breakoutVolumeRatio", "retestDepthAtr",
                "rejectionWickPct", "consolidationBars", "breakoutCandleAtr",
                "bbWidth", "volumeRatio", ...ALL_ML_ENRICH_KEYS]
                .map((k) => [k, pendingOrder[k] ?? null])
            ),
            R: pendingOrder.slDist,
            slCurrent: openSl,
            remainingSize: size,
            originalSize: size,
            m1: false, m2: false, m3: false,
            ...initPositionExcursions(),
          };
          pendingOrder = null;
          dailyTradeCount += 1;
          diag.opened += 1;
          // Same-bar stop-through: if the retest bar keeps going past the SL,
          // the fill and the stop both happen inside this bar (conservative).
          const sbSL = position.side === "LONG" ? c.low <= position.sl : c.high >= position.sl;
          if (sbSL) closePosition(position.sl, "SL", i);
          equity.push({ date: isoOf(c), value: round2(capital) });
          continue; // filled (or filled+stopped) this bar — no fresh signal eval
        }
      }
    }

    diag.barsEvaluated += 1;

    // ── 2. Market conditions (mirror AdaptiveStrategyEngine._tick step 4) ───
    const emaF = indicators.emaFast?.[i];
    const emaS = indicators.emaSlow?.[i];
    const volatility = atr && price ? (atr / price) * 100 : 1.0;
    const emaDelta = emaS > 0 ? Math.abs(emaF - emaS) / emaS : 0;
    const trendStrength = Math.min(emaDelta * 50, 1.0);

    // ── 3. HTF trend + fail-closed (mirror step 6b/6c) ──────────────────────
    const htfTrend = htfTrendAt(i);
    if (higherTf && htfTrend === "UNKNOWN") {
      diag.htfUnknownSkip += 1;
      equity.push({ date: isoOf(c), value: round2(capital) });
      continue;
    }

    // ── 4. REAL signal detection (same call signature live uses) ────────────
    const entryDate = new Date(c.timestamp).toISOString().split("T")[0];
    const dailyRegime = dailyTrendCache ? getRegimeForDate(entryDate, dailyTrendCache) : "UNKNOWN";

    const signal = strategy.detectSignal(indicators, i, {
      ...cfg,
      balance: capital,
      volatility,
      trend_strength: trendStrength,
      htfTrend,
      maxEntryExtensionATR: cfg.maxEntryExtensionATR,
      afRejectOnDissent: cfg.afRejectOnDissent,
      afMinVotes: cfg.afMinVotes,
      afMinComponentConfidence: cfg.afMinComponentConfidence,
      afMinAggregateConfidence: cfg.afMinAggregateConfidence,
      pairTier: cfg.pairTier,
      tierOverrides: cfg.tierOverrides,

      regimeDetection: cfg.regimeDetection,
      typeOverrides: cfg.typeOverrides,

      // at the HTF bar still FORMING at entry bar i — its close/EMA are future info,
      // so Layer 1 reads the previous (closed) bar. -1 when no closed bar yet →
      // strategy degrades to entry-TF fallback for the warmup bars.
      htfIdx: tfHtfLayer && htfPtr ? Math.max((htfPtr[i] ?? 0) - 1, -1) : undefined,

      // Sprint 12 TS race — selectedComponents = active racers; gate flags only
      // apply when tsCombinationMode is "gate"/"hybrid".
      tsCombinationMode,
      tsUseStructureGate,
      tsUseVwapPrecision,
      marketStructure: cfg.marketStructure,
      volumeProfile: cfg.volumeProfile,
      vwapAtrMult: cfg.vwapAtrMult,
      selectedComponents: raceSelected || cfg.selectedComponents,
      tsActiveRacers: tsCombo.selectedComponents || cfg.tsActiveRacers,
      mdCombinationMode: mdCombo.mdCombinationMode,
      mdActiveRacers: mdCombo.mdActiveRacers || cfg.mdActiveRacers,
      bsCombinationMode: bsCombo.bsCombinationMode,
      bsActiveRacers: bsCombo.bsActiveRacers || cfg.bsActiveRacers,
      afEnabledComponents: cfg.afEnabledComponents || cfg.selectedComponents,
      // LIQUIDATION_SQUEEZE optional exchange overlays (fail-open when absent)
      funding: cfg.funding ?? indicators.funding?.[i] ?? null,
      fundingRate: cfg.fundingRate ?? indicators.fundingRate?.[i] ?? null,
      oiHistory: cfg.oiHistory || indicators.oiHistory || null,
      timestamps: indicators.timestamps,

      // 2026-07-08: these three were dead knobs on TREND_FOLLOWING — the strategy class
      // is a server-startup SINGLETON (new TrendSurgeUmbrella(), no per-request
      // config), so its internal `this.config.adxMinStrength`/`minVolRatio`
      // reads were frozen at the constructor defaults (25 / whatever ships)
      // forever, regardless of what legacyStrategies.js or the FE configured.
      // Symptom found in the AF-SCALP-24 sweep: testing ADX20 produced results
      // IDENTICAL to ADX25 (the stale inner gate silently floored it) — invisible
      // only because the shipped default (30) happens to exceed the stale one.
      donchianPeriod: cfg.donchianPeriod,
      adxMinStrength: cfg.adxMinStrength,
      minVolRatio: cfg.minVolRatio,
      dailyRegime,
    });
    if (!signal) { diag.signalNull += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }

    const entryMeta = resolveEnrichedSignalMeta(strategy, strategyKey);
    const tradeTier = cfg.tradeType || entryMeta?.component || entryMeta?.winningComponent || null;
    const scalpGateFlags = resolveScalpingGateFlags({ ...cfg, typeOverrides: cfg.typeOverrides });
    const sessionGate = checkNoTradeSessionGate({
      timestamp: c.timestamp,
      noTradeSessions: scalpGateFlags.noTradeSessions,
      enabled: scalpGateFlags.smcSessionFilter,
      tradeTier,
      strategyKey,
    });
    if (!sessionGate.ok) {
      diag.sessionBlock += 1;
      equity.push({ date: isoOf(c), value: round2(capital) });
      continue;
    }

    // last CLOSED HTF bar (htfPtr[i] is the forming bar — lookahead). Fail-closed:
    // adx null (warmup) or no closed bar yet → skip entry, never "assume strong".
    if (tfHtfLayer && htfIndicators?.adx && htfPtr) {
      const j = (htfPtr[i] ?? 0) - 1;
      const adxVal = j >= 0 && j < htfIndicators.adx.length ? htfIndicators.adx[j] : null;
      // Weekly ADX ≥ 30 is rare; soft-cap when HTF is 1w so Swing legs can fire.
      // Per-leg typeOverrides.Swing.adxMinStrength (20) also merges into cfg.
      let adxMin = cfg.adxMinStrength ?? 25;
      const htfLabel = String(higherTf || cfg.higherTf || "").toLowerCase();
      if (htfLabel === "1w" || htfLabel === "1d") {
        adxMin = Math.min(adxMin, 20);
      }
      if (adxVal == null || adxVal < adxMin) {
        diag.adxHTFGate = (diag.adxHTFGate || 0) + 1;
        equity.push({ date: isoOf(c), value: round2(capital) });
        continue;
      }
    }

    // Apply daily regime gate — block momentum strategies during chop, reduce size for structure
    const regimeResult = applyRegimeGate({
      signal,
      strategyKey,
      regime: dailyRegime,
      riskPerTrade: cfg.riskPerTrade ?? 0.01,
    });
    if (!regimeResult.allow) { equity.push({ date: isoOf(c), value: round2(capital) }); continue; }

    // days (default gate only blocks CHOP; the 0.5-0.8 transition band still
    // bled through in every chop month: Feb, then Jun 2026).
    if (cfg.tfRequireStrongTrend && dailyTrendCache && dailyRegime !== "STRONG_TREND") {
      equity.push({ date: isoOf(c), value: round2(capital) });
      continue;
    }
    const adjustedRiskPerTrade = regimeResult.riskPerTrade;

    // ── 5. HTF directional block (mirror step 7a) ───────────────────────────
    // MEAN_REVERSION (counter-trend) is exempt from directional block — has its own
    // regime filter (step 2c in live BotEngine). BREAKOUT_RETEST exempt (consolidation
    // reversal valid). Other trend-following strategies require HTF alignment.
    const isMR = isMRKey(strategyKey);
    const isBR = isBRKey(strategyKey);
    if (!isMR && !isBR) {
      if (signal === "LONG" && htfTrend === "BEARISH") { diag.htfDirBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
      if (signal === "SHORT" && htfTrend === "BULLISH") { diag.htfDirBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    }

    // ── 5b. MEAN_REVERSION regime gate (mirror step 2c in live BotEngine) ──
    // MR counter-trend entries need regime check: block SHORT in strong bull,
    // LONG in strong bear, and all entries during ATR spike (wide spreads).
    if (isMR && htfIndicators && htfPtr) {
      const j = htfPtr[i];
      if (j >= 0 && j < htfIndicators.emaFast.length) {
        // Assemble HTF data at bar j (aligned to entry bar i via htfPtr)
        const lastNonNull = (arr) => { for (let k = arr.length - 1; k >= 0; k--) if (arr[k] != null) return arr[k]; return null; };
        const htfDataAtJ = {
          emaFast: htfIndicators.emaFast[j],
          emaSlow: htfIndicators.emaSlow[j],
          rsi: htfIndicators.rsi[j],
          close: htfIndicators.close[j],
          atr: htfIndicators.atr[j],
          atrBaseline: htfIndicators.atrSma ?? lastNonNull(htfIndicators.atr.slice(0, j)),
        };
        const mrCheck = meanReversionRegimeFilter({ direction: signal, htfData: htfDataAtJ });
        if (!mrCheck.allowed) {
          diag.htfDirBlock += 1;
          equity.push({ date: isoOf(c), value: round2(capital) });
          continue;
        }
      }
    }

    // ── 6. Risk gates (mirror BotEngine._checkRiskGates) ────────────────────
    const nowMs = c.timestamp ?? 0;
    if (cooldownUntil && nowMs < cooldownUntil) { diag.cooldownBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    if (consecLoss >= maxConsecLoss) { diag.consecLossBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    if (dailyTradeCount >= maxTradesPerDay) { diag.maxTradesBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    const dailyBase = dailyStartCapital || capital;
    // Include floating loss on open position (live BotEngine._checkRiskGates parity)
    let floatingLoss = 0;
    if (position) {
      const sz = position.remainingSize ?? position.size ?? 0;
      const u = position.side === "LONG"
        ? (price - position.entry) * sz
        : (position.entry - price) * sz;
      if (u < 0) floatingLoss = Math.abs(u);
    }
    if (dailyBase > 0 && (dailyLoss + floatingLoss) / dailyBase >= maxDailyLossPct) { diag.dailyLossBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    const atrPct = (atr / price) * 100;
    if (atrBaseline) {
      const base = atrBaseline[i];
      const rel = base > 0 ? atr / base : 1;
      if (rel < atrRelMin || rel > atrRelMax) { diag.atrGateBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
      if (legAtrOv.atrMinMult != null && legAtrOv.atrMinMult > 0 && atrPct < legAtrOv.atrMinMult) {
        diag.atrGateBlock += 1;
        equity.push({ date: isoOf(c), value: round2(capital) });
        continue;
      }
    } else if (atrPct < atrMinPct || atrPct > atrMaxPct) { diag.atrGateBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }

    // ── 7. validateEntry (mirror step 9) ────────────────────────────────────
    const meta = entryMeta;
    if (typeof strategy.validateEntry === "function") {
      try {
        const legName = meta?.component || meta?.winningComponent;
        const legOverride = legName ? (cfg.typeOverrides?.[legName] || {}) : {};
        const baselineNow = atrBaseline?.[i] ?? null;
        const v = strategy.validateEntry(price, atr, c.volume, indicators.volSMA?.[i] || 0, {
          ...cfg,
          ...legOverride,
          _atrBaseline: baselineNow,
          atrBaseline: baselineNow,
        });
        if (v && v.valid === false) { diag.validateBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
      } catch { /* degrade open — same as live */ }
    }

    // ── 8. Component-aware SL/TP (mirror step 11d) ──────────────────────────
    const tradeLabel = resolveTradeDisplayName(strategyKey, cfg, meta, strategyDisplayName);
    const tradeLeg = meta?.tradeType
      || (TRADE_LEG_NAMES.has(meta?.component) ? meta.component : null)
      || cfg.tradeType
      || null;
    let slDist, tpDist, component = "B", marketCond = null, plannedRR = null, confidence = null;
    const pairSlMult = cfg.pairSlMultiplier || 1; // STABLE/VOLATILE tier adjustment
    let brEnrich = {};
    let mlEnrich = {};
    if (meta && typeof strategy.calculateRiskConfig === "function") {

      // Backtest passes full type names (Scalping/Intraday/Swing), not legacy A/B/C
      const typeOverride = cfg.typeOverrides?.[meta.component] || {};
      const slMult = typeOverride.slAtrMult ?? cfg.slAtrMult;
      const tpMult = typeOverride.tpAtrMult ?? cfg.tpAtrMult;

      const rc = strategy.calculateRiskConfig(price, atr, signal, meta.component, {
        marketCond: meta.marketCond,
        strongTrendTPMult: cfg.strongTrendTPMult ?? 1,
        slMultiplier: slMult,
        tpMultiplier: tpMult,
        breakoutLevel: meta.breakoutLevel,
        retestExtreme: meta.retestExtreme,
      });
      slDist = rc.slDistance * pairSlMult;
      tpDist = rc.tpDistance * pairSlMult;
      component = resolveWinningComponentKey(meta, strategy, strategyKey);
      marketCond = meta.marketCond;
      plannedRR = rc.riskReward;

      confidence = meta.gradedScore ?? meta.componentConfidence ?? meta.aggregateConfidence ?? null;
      brEnrich = extractBsBrEnrichment(meta);
      mlEnrich = extractStrategyMlEnrichment(meta);
    } else {
      slDist = atr * (cfg.atrMultiplier ?? 1.4) * pairSlMult;
      tpDist = slDist * (cfg.riskReward ?? 2);
      plannedRR = (cfg.riskReward ?? 2);
    }
    if (!(slDist > 0)) { equity.push({ date: isoOf(c), value: round2(capital) }); continue; }


    // chasing the breakout close. Latest signal replaces any unfilled pending.
    if (cfg.retestEntryEnabled) {
      const pullback = (cfg.retestPullbackAtr ?? 0.5) * atr;
      pendingOrder = {
        side: signal,
        limit: signal === "LONG" ? price - pullback : price + pullback,
        slDist,
        tpDist,
        riskPerTrade: adjustedRiskPerTrade,
        expiresIdx: i + (cfg.retestTtlBars ?? 12),
        component,
        tradeType: tradeLeg,
        marketCond,
        plannedRR,
        confidence,
        atr,
        entryRsi: indicators.rsi?.[i] ?? null,
        htfTrend,
        dailyRegime,
        entryMeta: meta || null,
        strategyLabel: tradeLabel,
        winningComponent: meta?.winningComponent || resolveWinningComponentKey(meta, strategy, strategyKey) || component,
        ...brEnrich,
        ...mlEnrich,
      };
      equity.push({ date: isoOf(c), value: round2(capital) });
      continue;
    }

    // ── 9. Open position (risk-based sizing; leverage irrelevant to PnL) ─────
    const entry = price;
    const size = (capital * adjustedRiskPerTrade) / slDist;
    const openSl = signal === "LONG" ? entry - slDist : entry + slDist;
    position = {
      side: signal,
      entry,
      sl: openSl,
      tp: signal === "LONG" ? entry + tpDist : entry - tpDist,
      slDist,
      size,
      openIdx: i,
      component,
      tradeType: tradeLeg,
      marketCond,
      plannedRR,
      confidence,
      atr,
      entryRsi: indicators.rsi?.[i] ?? null,
      htfTrend,
      dailyRegime,
      entryMeta: meta || null,
      strategyLabel: tradeLabel,
      winningComponent: resolveWinningComponentKey(meta, strategy, strategyKey) || component,
      ...brEnrich,
      ...mlEnrich,
      // SL+ partial-TP state (see checkPartialMilestones) — R is the risk distance,
      // slCurrent is the live stop (moves to BEP/+1R after milestones fire),
      // remainingSize shrinks as partials execute; originalSize stays fixed for
      // milestone % calc (mirrors BotEngine pos.size vs pos.remainingSize).
      R: slDist,
      slCurrent: openSl,
      remainingSize: size,
      originalSize: size,
      m1: false,
      m2: false,
      m3: false,
      ...initPositionExcursions(),
    };
    dailyTradeCount += 1;
    diag.opened += 1;

    equity.push({ date: isoOf(c), value: round2(capital) });
  }

  return {
    trades,
    equity,
    stats: buildStats(trades, startCapital, capital),
    // Execution-stage funnel (diag) + the active racer's strategy-gate funnel —
    // parity with the AF multi-position engine so TS/MD/BS strategies are also
    // diagnosable per strategy when a run produces 0/low trades.
    execAblation: diag,
    ablation: (typeof strategy.getAblation === "function")
      ? strategy.getAblation(ablComponentKey)
      : null,
    ablationKey: ablComponentKey,
    meta: {
      strategyKey,
      entryBars: entryCandles.length,
      htfBars: htfCandles?.length ?? 0,
      higherTf,
      feeRate: feeRate || (cfg._feeModel?.takerFeeRate ?? FEE_RATE_PER_SIDE),
      slippage: slip,
      diagnostics: diag,
      exchange: cfg._feeModel?.exchange,
      exchangeLabel: cfg._feeModel?.exchangeLabel,
      feeSchedule: cfg._feeModel ? {
        takerFeeRate: cfg._feeModel.takerFeeRate,
        makerFeeRate: cfg._feeModel.makerFeeRate,
        fundingRate8h: cfg._feeModel.fundingRate8h,
      } : undefined,
    },
  };
}

/**
 * Run a single-signal strategy (TREND_FOLLOWING, MEAN_REVERSION) across a SUBSET of SMART_MONEY_CONCEPTS's own
 * Scalping/Intraday/Swing timeframe definitions — same TF pairs (5m/1h, 15m/1h,
 * 4h/1w), same candle-fetch resilience, but using the single-position engine
 * (strategy.detectSignal contract) instead of AF's detectSignalMulti fusion.
 *
 * WHY: TREND_FOLLOWING's canonical single-TF entry is 5m, and on exchanges with shallow
 * 5m history (e.g. Bitget) that ONE fetch failing killed the whole backtest —
 * unlike AF, whose triple-TF split lets a failing Scalping(5m) leg degrade to
 * 0 trades while Intraday/Swing still run. Routing TREND_FOLLOWING through Intraday(15m)+
 * Swing(4h) — never touching 5m — and MEAN_REVERSION through Scalping(5m)+Intraday(15m)
 * gives them the same per-type resilience, and TREND_FOLLOWING sidesteps the fragile TF
 * entirely. Each type is independent: a failing/empty fetch for one type just
 * skips it (0 trades), the other type's result still renders.
 *
 * @param {Object}   opts        - same shape as runTripleTypeBacktest
 * @param {string[]} typeOrder   - subset of ["Scalping","Intraday","Swing"]
 */
// AF-SCALP-22: TREND_FOLLOWING geometry key TRANSLATION. The FE sends the legacy knob
// names (atrMult / riskReward — FE backtestStrategies TREND_FOLLOWING defaults
// 1.3 / 1.92) and the BE legacy config uses atrMultiplier / riskReward, but the
// engine's SL/TP override chain only reads slAtrMult / tpAtrMult. AF-SCALP-21
// made the chain live inside TrendFollowingStrategy, yet post-deploy CSVs
// (2026-07-07) still show Planned R:R exactly 2.0 on every row — nothing was
// translating the legacy names, so the constructor defaults 1.5/3.0 kept
// winning. Scoped to TF ONLY: riskReward also exists as DEAD config on other
// strategies (e.g. SMC, where it must stay dead) — mapping it globally would
// silently change their SL/TP too.
function normalizeTfGeometryKeys(strategyKey, cfg) {
  if (!isTFKey(strategyKey)) return cfg;
  const out = { ...cfg };
  if (out.slAtrMult == null) out.slAtrMult = out.atrMult ?? out.atrMultiplier;
  if (out.tpAtrMult == null && out.slAtrMult != null) {
    out.tpAtrMult = out.slAtrMult * (out.riskReward ?? 2);
  }
  return out;
}

async function runMultiTypeBacktest(opts = {}, typeOrder) {
  const { strategyKey, capital: startCapital = 1000, enableFees = true, enableSlippage = false } = opts;

  const validation = strategyRegistry.validate(strategyKey);
  if (!validation.valid) throw new Error(`Invalid strategy "${strategyKey}": ${validation.error}`);
  const strategy = validation.strategy;

  const feeModel = resolveFeeModel({ ...opts, enableFees });
  const base = resolveStrategyDefaults(strategyKey);
  const cfg = mergeBacktestCfg(base, opts.config, feeModel);
  const feeRate = feeModel.feeRate;
  const slip    = enableSlippage ? (cfg.slippagePct ?? DEFAULT_SLIPPAGE) : 0;

  const allTrades = [];
  const perTypeStats = {};

  // Capital is shared across types (concurrent risk), mirroring runTripleTypeBacktest's
  // documented model: riskPerTrade is the COMBINED cap across all concurrent types.

  // equally — TREND_FOLLOWING combined 0.03 → 1%/2%, MEAN_REVERSION combined 0.015 → 0.5%/1%.

  const riskTypeOrder = Array.isArray(opts.naturalTypeOrder) && opts.naturalTypeOrder.length
    ? opts.naturalTypeOrder
    : typeOrder;
  // Mirror backtest.js TYPE_TF (Sprint 14 ladder: Scalping 5m/1h · Intraday
  // 15m/4h · Swing 4h/1w) so ADX weekly soft-cap + HTF directional gates know
  // which trend TF each leg uses.
  const TYPE_TF_HTF = {
    Scalping: "1h",
    Intraday: "1h",
    Swing: "1w",
  };
  for (const tradeType of typeOrder) {

    // typeOverrides[leg] (atrMult/riskReward) also reach slAtrMult/tpAtrMult.
    const typeConfig = normalizeTfGeometryKeys(strategyKey, {
      ...cfg,

      ...(cfg.typeOverrides?.[tradeType] ?? {}),
      higherTf: cfg.typeOverrides?.[tradeType]?.higherTf || TYPE_TF_HTF[tradeType] || cfg.higherTf,
      riskPerTrade: riskShareForType(tradeType, riskTypeOrder, cfg.riskPerTrade ?? 0.01),
      // AMT / AUCTION_MARKET_THEORY: Swing → utc_week session; Intraday → utc_day (volumeProfileComponent)
      tradeType,
      entryTf: tradeType === "Swing" ? "4h"
        : tradeType === "Intraday" ? "15m"
          : tradeType === "Scalping" ? "5m"
            : cfg.entryTf,
    });
    const entryCandles = opts.entryCandles?.[tradeType];
    const htfCandles   = opts.htfCandles?.[tradeType];

    if (!entryCandles?.length || entryCandles.length < 60) {
      perTypeStats[tradeType] = { skipped: true, reason: "Insufficient candles" };
      continue;
    }

    const typeResult = await _runSinglePositionBacktest(
      {
        ...opts,
        strategyKey,
        capital: startCapital,
        config: typeConfig,
        btcEntryCandles: opts.btcEntryCandles?.[tradeType] ?? opts.btcEntryCandles ?? null,
        abortSignal: opts.abortSignal,
        onProgress: opts.onProgress
          ? (pct, bar, total) => opts.onProgress(pct, bar, total, tradeType)
          : undefined,
      },
      strategy,
      typeConfig,
      feeRate,
      slip,
      entryCandles,
      htfCandles || null,
    );

    for (const t of typeResult.trades) {
      allTrades.push({ ...t, component: tradeType, tradeType });
    }
    perTypeStats[tradeType] = {
      trades: typeResult.trades.length,
      wins: typeResult.trades.filter(t => t.result === "win").length,
      entryBars: entryCandles.length,
      htfBars: htfCandles?.length ?? 0,
      // Execution-stage funnel — how PASSED (strategy-gate) signals turn into
      // opened positions. Surfaces the blind spot between detectSignal and the
      // position open (e.g. the ATR relative gate eating every signal on real data).
      execAblation: typeResult.execAblation ?? null,
      // Per-strategy (active racer) indicator funnel — TS/MD/BS strategies now
      // surface THEIR own gate breakdown, mirroring the AF path.
      ablation: typeResult.ablation ?? null,
      ablationKey: typeResult.ablationKey ?? null,
    };

    // Inline funnel log for every trade type — parity with runTripleTypeBacktest's
    // AF site, so single-position strategies (TS/MD/BS) are diagnosable per
    // strategy on Scalping / Intraday / Swing.
    if (typeResult.ablationKey
        && (typeResult.ablation || typeResult.execAblation)) {
      try {
        console.log(formatStrategyFunnel(
          typeResult.ablationKey,
          typeResult.ablation,
          typeResult.execAblation,
          `${typeResult.ablationKey} filter funnel (${tradeType}, ${entryCandles.length} bars, ${allTrades.length} trades so far):`,
        ));
      } catch { /* logging must never break a run */ }
    }
  }

  allTrades.sort((a, b) => new Date(a.openTime || a.date) - new Date(b.openTime || b.date));

  let grokResult = null;
  if (opts.grokGate) {
    grokResult = await _applyGrokGate(allTrades, {
      strategyKey,
      symbol: opts.symbol,
      userId: opts.userId,
      grokConfirmFn: opts.grokConfirmFn,
      onGrokProgress: opts.onGrokProgress,
    });
  }
  let workingTrades = grokResult ? grokResult.trades : allTrades;

  let ragResult = null;
  if (opts.ragGate) {
    ragResult = await _applyRagGate(workingTrades, {
      strategyKey,
      symbol: opts.symbol,
      onRagProgress: opts.onRagProgress,
    });
    workingTrades = ragResult.trades;
  }
  const finalTrades = workingTrades;

  const { equity, stats } = _computeTripleStats(finalTrades, startCapital);

  return {
    ok: true,
    trades: finalTrades,
    equity,
    perTypeStats,
    stats,
    grokGate: !!opts.grokGate,
    grokStats: grokResult?.stats ?? null,
    grokLogs: grokResult?.logs ?? null,
    ragGate: !!opts.ragGate,
    ragStats: ragResult?.stats ?? null,
    ragLogs: ragResult?.logs ?? null,
    meta: {
      strategyKey,
      mode: `multi-tf (${typeOrder.join("+")})`,
      perTypeStats,
      grokGate: !!opts.grokGate,
      grokStats: grokResult?.stats ?? null,
      ragGate: !!opts.ragGate,
      ragStats: ragResult?.stats ?? null,
      exchange: feeModel.exchange,
      exchangeLabel: feeModel.exchangeLabel,
      feeSchedule: {
        takerFeeRate: feeModel.takerFeeRate,
        makerFeeRate: feeModel.makerFeeRate,
        fundingRate8h: feeModel.fundingRate8h,
      },
    },
  };
}

function round2(v) { return Math.round(v * 100) / 100; }

function buildStats(trades, startCapital, endCapital) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalFees = trades.reduce((s, t) => s + (t.fee || 0), 0);
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  // Max drawdown from realized equity curve
  let peak = startCapital, bal = startCapital, mdd = 0;
  for (const t of trades) {
    bal += t.pnl;
    peak = Math.max(peak, bal);
    mdd = Math.max(mdd, peak > 0 ? (peak - bal) / peak : 0);
  }

  // Sharpe on per-trade returns (annualized, matches FE convention sqrt(252))
  const rets = trades.map(t => t.pnl);
  const avg = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1
    ? Math.sqrt(rets.reduce((s, r) => s + (r - avg) ** 2, 0) / (rets.length - 1))
    : 0;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length * 100).toFixed(1) : "0.0",
    totalReturn: ((endCapital - startCapital) / startCapital * 100).toFixed(2),
    finalCapital: endCapital.toFixed(2),
    profitFactor: grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? "Inf" : "0.00"),
    avgWin: avgWin.toFixed(2),
    avgLoss: avgLoss.toFixed(2),
    riskReward: avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : "0.00",
    maxDrawdown: (mdd * 100).toFixed(2),
    sharpe: std > 0 ? ((avg / std) * Math.sqrt(252)).toFixed(2) : "0.00",
    totalFees: totalFees.toFixed(2),
  };
}

module.exports = {
  runRealBacktest,
  runTripleTypeBacktest,
  runMultiTypeBacktest,
  mergeTypeOverrides,
  mergeBacktestCfg,
  formatScalpingFunnel,
  formatStrategyFunnel,
  formatExecSection,
  resolveAblationStrategyKey,
  getAblationSchemaFor,
  smcAblationApplies,
  resolveFeeModel,
  estimateFundingCost,
  _computeTripleStats,
  _applyGrokGate,
  _applyRagGate,
  resolveTsCombination,
  resolveTsLayerFlags,
  resolveMdCombination,
  resolveBsCombination,
  resolveTradeDisplayName,
  extractBsBrEnrichment,
  extractTsVpEnrichment,
  extractTsTfEnrichment,
  extractTsMsEnrichment,
  extractMdMrEnrichment,
  extractMdSdEnrichment,
  extractMdSaEnrichment,
  extractBsIctEnrichment,
  extractBsLsEnrichment,
  extractAfVsaEnrichment,
  extractAfWyckoffEnrichment,
  extractStrategyMlEnrichment,
};
