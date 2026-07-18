/**
 * strategyReasonFormatters.js — Per-strategy entry/exit reason labels for CSV export.
 *
 * ── Umbrella_Component key scheme (canonical v2.0) ──────────────────────────
 * Strategies are keyed as Umbrella_Component so race-to-confirm can attribute
 * the winning racer on each bar. Dispatchers MUST use winningComponent when
 * present (not the umbrella key alone):
 *
 *   Adaptive Fusion (FOUNDRY): SMART_MONEY_CONCEPTS | WYCKOFF | VOLUME_SPREAD_ANALYSIS
 *   Trend Surge     (FORGE):   TREND_FOLLOWING  | MARKET_STRUCTURE      | AUCTION_MARKET_THEORY
 *   Mean Drift      (MINT):    MEAN_REVERSION  | SUPPLY_AND_DEMAND      | STATISTICAL_ARBITRAGE
 *   Breakout Storm  (VAULT):   BREAKOUT_RETEST  | ICT_STYLE_TRADING     | LIQUIDATION_SQUEEZE
 *
 * Legacy ingress aliases normalised via strategyKeyNormalizer ACL.
 *
 * ── Hard-gate caveats (low inter-trade variance) ────────────────────────────
 * SMART_MONEY_CONCEPTS: Sweep → CHoCH → FVG are hard prerequisites in _detectSMCSequence.
 *   Nearly every trade will show the same labels; only FVG direction and
 *   obConfluence ("Fresh Order Block") typically vary.
 * WYCKOFF: Multi-item entry checklist — passed trades share the same layers.
 * TREND_FOLLOWING: HTF + ADX + Donchian + EMA9 retest + volume are all required — labels
 *   are nearly identical across fills. Treat as checklist confirmation, not a
 *   unique per-trade narrative.
 */

const { normalizeStrategyKey: aclNormalizeStrategyKey } = require("../../../config/strategyKeyNormalizer");

/** @type {Record<string, string>} */
const EXIT_REASON_LABELS = {
  TP: "Take Profit",
  SL: "Stop Loss",
  SL_TRAIL: "Trailing Stop",
  TIME_STOP: "Time Stop",
  Partial_1R: "Partial +1R",
  Partial_2R: "Partial +2R",
  Breakeven: "Breakeven",
  BEP: "Breakeven",
  SIGNAL: "Reversal",
  Emergency: "Emergency Close",
  Offline: "Closed Offline",
  GrokAi: "Grok AI Close",
};

const LEGACY_KEY_MAP = {
  SMC: "SMART_MONEY_CONCEPTS",
  WYCKOFF: "WYCKOFF",
  VSA: "VOLUME_SPREAD_ANALYSIS",
  MARKET_STRUCTURE: "MARKET_STRUCTURE",
  DOW_THEORY: "MARKET_STRUCTURE",
  VOLUME_PROFILE: "AUCTION_MARKET_THEORY",
  AMT: "AUCTION_MARKET_THEORY",
  BREAKOUT: "BREAKOUT_RETEST",
  ADAPTIVE_FUSION: "SMART_MONEY_CONCEPTS",
  TREND_SURGE: "TREND_FOLLOWING",
  MEAN_DRIFT: "MEAN_REVERSION",
  BREAKOUT_STORM: "BREAKOUT_RETEST",
};

function titleCaseSnake(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeStrategyKey(key) {
  if (!key) return "";
  const upper = String(key).trim().toUpperCase();
  const acl = aclNormalizeStrategyKey(upper);
  return LEGACY_KEY_MAP[upper] || acl;
}

/**
 * Human-readable exit label. Keeps unknown codes as title-cased fallback.
 * @param {string|null|undefined} raw
 * @returns {string}
 */
function formatExitReason(raw) {
  if (raw == null || raw === "" || raw === "N/A") return "";
  const key = String(raw).trim();
  if (EXIT_REASON_LABELS[key]) return EXIT_REASON_LABELS[key];
  const upper = key.toUpperCase();
  if (upper === "TIME_STOP" || upper === "TIMESTOP") return "Time Stop";
  if (upper === "SL_TRAIL" || upper.includes("TRAIL")) return "Trailing Stop";
  if (upper.startsWith("PARTIAL_1") || upper.includes("+1R")) return "Partial +1R";
  if (upper.startsWith("PARTIAL_2") || upper.includes("+2R")) return "Partial +2R";
  if (EXIT_REASON_LABELS[upper]) return EXIT_REASON_LABELS[upper];
  return titleCaseSnake(key);
}

// ─── 1. SMART_MONEY_CONCEPTS ───────────────────────────────────────────────────────────────
// Hard-gate: sweepIdx/chochIdx/fvg are prerequisites — labels repeat across trades.

function formatSmcReasons(meta) {
  if (!meta) return "";
  const seq = meta.sequenceMeta || meta.meta?.sequenceMeta || meta;
  if (!seq || typeof seq !== "object") return "";

  const reasons = [];
  if (Number.isFinite(seq.sweepIdx) && seq.sweepIdx >= 0) reasons.push("Liquidity Sweep");
  if (Number.isFinite(seq.chochIdx) && seq.chochIdx >= 0) reasons.push("CHoCH");
  if (seq.obConfluence || seq.freshOb || seq.ob) reasons.push("Fresh OB");
  if (seq.fvg) {
    const t = String(seq.fvg.type || "").toLowerCase();
    if (t.includes("bull")) reasons.push("Bullish FVG");
    else if (t.includes("bear")) reasons.push("Bearish FVG");
    else reasons.push("FVG");
  }
  if (seq.dispIdx != null || seq.displacement || seq.hasDisplacement) {
    reasons.push("Displacement");
  }
  if (seq.mitigation || seq.mitigated || seq.mitigationDepth != null) {
    reasons.push("Mitigation");
  }
  return reasons.join(", ");
}

// ─── 2. WYCKOFF ───────────────────────────────────────────────────────────
// Hard-gate checklist — low variance across fills.

const WYCKOFF_REASON_MAP = {
  wyckoff_spring: "Spring",
  wyckoff_upthrust: "Upthrust",
  wyckoff_lps: "LPS",
  wyckoff_lpsy: "LPSY",
};

function formatWyckoffReasons(meta) {
  if (!meta) return "";
  const reasons = [];
  const raw = meta.reason || meta.meta?.entry?.reason || meta.meta?.spring?.reason || meta.meta?.upthrust?.reason || "";
  const mapped = WYCKOFF_REASON_MAP[raw];
  if (mapped) reasons.push(mapped);
  else if (raw && !String(raw).startsWith("entry_checklist_failed") && !String(raw).startsWith("no_")) {
    if (/spring/i.test(raw)) reasons.push("Spring");
    else if (/upthrust|utad/i.test(raw)) reasons.push("Upthrust");
    else if (/lpsy/i.test(raw)) reasons.push("LPSY");
    else if (/lps/i.test(raw)) reasons.push("LPS");
  }

  const checklist = meta.meta?.entry?.checklist || meta.checklist || null;
  if (checklist && typeof checklist === "object") {
    if (checklist.sosOrSow) {
      const side = meta.vote || meta.meta?.entry?.side || meta.direction;
      reasons.push(String(side).toUpperCase() === "SHORT" ? "SOW" : "SOS");
    }
    if (checklist.lpsOrLpsy) {
      if (!reasons.includes("LPS") && !reasons.includes("LPSY")) reasons.push("LPS/LPSY");
    }
    if (checklist.volumeConfirm || checklist.volumeClimax || /climax/i.test(String(raw))) {
      reasons.push("Volume Climax");
    }
  } else if (/climax/i.test(String(raw))) {
    reasons.push("Volume Climax");
  }

  if (reasons.length === 0 && raw) return titleCaseSnake(raw);
  return [...new Set(reasons)].join(", ");
}

// ─── 3. VOLUME_SPREAD_ANALYSIS ───────────────────────────────────────────────────────────────

const VSA_REASON_MAP = {
  vsa_stopping_volume_low: "Stopping Volume",
  vsa_stopping_volume_high: "Stopping Volume",
  vsa_no_demand: "No-Demand",
  vsa_no_supply: "No-Supply",
};

function formatVsaReasons(meta) {
  if (!meta) return "";
  const raw = meta.reason || meta.meta?.reason || "";
  const pattern = VSA_REASON_MAP[raw];
  const nearSwing = meta.meta?.nearSwing || meta.nearSwing || null;
  const reasons = [];

  if (pattern) reasons.push(pattern);
  else if (/stopping_volume/i.test(raw)) reasons.push("Stopping Volume");
  else if (/no_demand/i.test(raw)) reasons.push("No-Demand");
  else if (/no_supply/i.test(raw)) reasons.push("No-Supply");

  if (nearSwing) reasons.push("Swing Proximity");

  if (reasons.length === 0 && raw) return titleCaseSnake(raw);
  return reasons.join(", ");
}

// ─── 4. TREND_FOLLOWING ────────────────────────────────────────────────────────────────
// Hard-gate 3-layer checklist — very low variance.

function formatTrendFollowingReasons(meta) {
  if (!meta) return "";
  const flags = meta.entryChecklist || meta;
  const adxMin = meta.adxMinStrength ?? flags.adxMinStrength ?? 25;
  const reasons = [];

  if (flags.htfTrendAligned || flags.htfTrendConfirmed) reasons.push("HTF Aligned");
  if (flags.adxPassed || (flags.adxStrength != null && flags.adxStrength >= adxMin)) {
    reasons.push("ADX Strength");
  }
  if (flags.donchianBroken) reasons.push("Donchian Break");
  if (flags.ema9Retest || flags.emaRetestHeld) reasons.push("EMA9 Retest");
  if (flags.volumeConfirmed) reasons.push("Volume Confirmation");

  // Signal fired ⇒ all hard gates passed even if flags were not snapshotted.
  if (reasons.length === 0 && (meta.winningComponent === "TREND_FOLLOWING" || meta.component === "TREND_FOLLOWING")) {
    if (meta.htfTrendConfirmed) reasons.push("HTF Aligned");
    if (meta.adxStrength != null) reasons.push("ADX Strength");
    if (meta.donchianBroken) reasons.push("Donchian Break");
  }
  return reasons.join(", ");
}

// ─── 5. MARKET_STRUCTURE ────────────────────────────────────────────────────────────────

function formatMarketStructureReasons(meta) {
  if (!meta) return "";
  const reason = String(meta.reason || meta.meta?.reason || "");
  const structure = meta.meta?.structure || meta.structure || null;
  const labels = [];

  if (
    reason.startsWith("dow_") ||
    reason.includes("structure_confirmed") ||
    reason.includes("structure_uptrend") ||
    reason.includes("structure_downtrend") ||
    structure === "uptrend" ||
    structure === "downtrend"
  ) {
    labels.push("Swing Structure");
  }

  if (
    /hl|hh/i.test(reason) ||
    structure === "uptrend" ||
    reason.includes("structure_uptrend")
  ) {
    labels.push("HH/HL Pattern");
  } else if (
    /lh|ll/i.test(reason) ||
    structure === "downtrend" ||
    reason.includes("structure_downtrend")
  ) {
    labels.push("HH/HL Pattern");
  }

  if (/bounce/i.test(reason)) labels.push("Pullback Bounce");
  if (/reject/i.test(reason)) labels.push("Pullback Reject");
  if (reason.startsWith("dow_")) labels.push("Same-Bar Confirm");

  if (labels.length === 0 && reason) return titleCaseSnake(reason);
  return [...new Set(labels)].join(", ");
}

// ─── 6. AUCTION_MARKET_THEORY ────────────────────────────────────────────────────────────────

const VP_REASON_MAP = {
  vwap_reclaim: "VWAP Reclaim",
  vwap_lose: "VWAP Lose",
  val_bounce: "VAL Bounce",
  vah_reject: "VAH Reject",
  vwap_retest: "VWAP Retest",
  poc_retest: "POC Retest",
};

function formatVolumeProfileReasons(meta) {
  if (!meta) return "";
  const raw = meta.reason || meta.meta?.reason || "";
  if (VP_REASON_MAP[raw]) return VP_REASON_MAP[raw];
  if (!raw) return "";
  return titleCaseSnake(raw);
}

// ─── 7. MEAN_REVERSION ────────────────────────────────────────────────────────────────

function formatMeanReversionReasons(meta) {
  if (!meta) return "";
  const reason = String(meta.reason || "");
  const labels = [];

  if (
    /RSI\s+[\d.]+\s*[<>]/i.test(reason)
    || /oversold/i.test(reason)
    || /overbought/i.test(reason)
  ) {
    labels.push("RSI Extreme");
  }
  if (/\bBB\b/i.test(reason) || /bollinger/i.test(reason)) labels.push("BB Touch");
  if (/VWAP/i.test(reason)) labels.push("VWAP Dev");

  const adxRegime = meta.adxRegime || (reason.match(/ADX:(\w+)/i) || [])[1];
  if (adxRegime) {
    const r = String(adxRegime).toLowerCase();
    if (r === "balance" || r === "transition" || r === "imbalance") {
      labels.push("ADX Balance");
    } else {
      labels.push(`ADX ${titleCaseSnake(adxRegime)}`);
    }
  }

  if (meta.hasObFvgConfluence === true || /OB\/FVG✓/.test(reason)) {
    labels.push("OB/FVG Confluence");
  } else if (/OB\/FVG~/.test(reason)) {
    // soft miss — omit confluence label
  }

  if (labels.length === 0 && reason) {
    // Fallback: split pipe segments into rough labels
    return reason
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(", ");
  }
  return labels.join(", ");
}

// ─── 8. BREAKOUT_RETEST ────────────────────────────────────────────────────────────────
// Hard-gate 3-phase sequential — very low variance.

function formatBreakoutReasons(meta) {
  if (!meta) return "";
  const reasons = [];
  if (meta.bbSqueeze || meta.consolidationConfirmed || meta.squeeze) {
    reasons.push("BB Squeeze");
  }
  if (meta.rangeBreakout || meta.breakoutConfirmed) {
    reasons.push("Range Break");
  }
  if (
    meta.volumeSpike
    || meta.breakoutVolumeConfirmed
    || (meta.breakoutVolumeRatio != null && Number(meta.breakoutVolumeRatio) > 1)
  ) {
    reasons.push("Volume Spike");
  }
  if (meta.retestConfirmation || meta.retestConfirmed) {
    reasons.push("Retest Confirm");
  }
  // Signal path always completes core phases when meta is set on fill.
  if (reasons.length === 0 && (meta.winningComponent === "BREAKOUT_RETEST" || meta.component === "BREAKOUT_RETEST")) {
    return "BB Squeeze, Range Break, Volume Spike, Retest Confirm";
  }
  return reasons.join(", ");
}

// ─── 9. SUPPLY_AND_DEMAND ────────────────────────────────────────────────────────────────

function formatSupplyDemandReasons(meta) {
  if (!meta) return "";
  const labels = [];
  const zt = meta.zoneType || "";
  const reason = meta.reason || "";
  if (/demand/i.test(zt) || /demand/i.test(reason)) labels.push("Demand Retest");
  if (/supply/i.test(zt) || /supply/i.test(reason)) labels.push("Supply Retest");
  if (/fvg/i.test(zt) || /fvg/i.test(reason) || /ob/i.test(zt) || /order.?block/i.test(reason)) {
    labels.push("OB/FVG Structure");
  }
  if (labels.length === 0 && (meta.winningComponent === "SUPPLY_AND_DEMAND" || meta.component === "SUPPLY_AND_DEMAND")) {
    return "Demand Retest, Supply Retest, OB/FVG Structure";
  }
  return [...new Set(labels)].join(", ");
}

// ─── 10. STATISTICAL_ARBITRAGE ───────────────────────────────────────────────────────────────

function formatStatisticalArbitrageReasons(meta) {
  if (!meta) return "";
  const labels = [];
  if (
    meta.zScore != null && Number.isFinite(meta.zScore)
    || /z.?score/i.test(meta.reason || "")
  ) {
    labels.push("Z-Score Extreme");
  }
  if (meta.meanDevBand || meta.meanDeviation || /mean.?dev/i.test(meta.reason || "")) {
    labels.push("Mean Dev Band");
  }
  if (meta.stdThreshold != null || /std/i.test(meta.reason || "") || meta.saMode) {
    labels.push("Std Threshold");
  }
  if (labels.length === 0 && (meta.winningComponent === "STATISTICAL_ARBITRAGE" || meta.component === "STATISTICAL_ARBITRAGE")) {
    return "Z-Score Extreme, Mean Dev Band, Std Threshold";
  }
  if (labels.length === 0 && meta.reason) return titleCaseSnake(meta.reason);
  return [...new Set(labels)].join(", ");
}

// ─── 11. ICT_STYLE_TRADING ──────────────────────────────────────────────────────────────

function formatIctStyleReasons(meta) {
  if (!meta) return "";
  const labels = [];
  const reason = meta.reason || "";
  if (meta.killZone?.active || /kz|kill_zone|london|ny_open/i.test(reason)) {
    labels.push("Kill Zone");
  }
  if (meta.raid?.detected || /raid/i.test(reason)) {
    if (meta.raid?.direction === "LONG" || /raid_low/i.test(reason)) {
      labels.push("Liquidity Raid (Lo→Long)");
    } else if (meta.raid?.direction === "SHORT" || /raid_high/i.test(reason)) {
      labels.push("Liquidity Raid (Hi→Short)");
    } else {
      labels.push("Liquidity Raid");
    }
  }
  if (meta.mss || /mss|market.?structure.?shift/i.test(reason)) labels.push("MSS");
  if (meta.ote || /ote|optimal.?trade/i.test(reason)) labels.push("OTE");
  if (labels.length === 0 && (meta.winningComponent === "ICT_STYLE_TRADING" || meta.component === "ICT_STYLE_TRADING")) {
    return "Kill Zone, Liquidity Raid, MSS, OTE";
  }
  return labels.join(", ");
}

// ─── 12. LIQUIDATION_SQUEEZE ───────────────────────────────────────────────────────────────

function formatLiquidationSqueezeReasons(meta) {
  if (!meta) return "";
  const labels = [];
  const reason = meta.reason || "";
  if (meta.wick?.detected || /liquidation_wick|ls_/i.test(reason)) {
    const dir = String(meta.wick?.side || meta.side || meta.direction || "").toUpperCase();
    if (dir === "LONG" || /bounce/i.test(reason)) labels.push("Liquidation Wick (Bounce)");
    else if (dir === "SHORT" || /reject/i.test(reason)) labels.push("Liquidation Wick (Reject)");
    else labels.push("Liquidation Wick");
  }
  if (meta.squeeze || /squeeze/i.test(reason)) labels.push("Squeeze");
  if (
    (meta.funding != null && Number.isFinite(meta.funding))
    || (meta.oiChange != null && Number.isFinite(meta.oiChange))
    || /funding|oi/i.test(reason)
  ) {
    labels.push("OI/Funding Proxy");
  }
  if (meta.dataAvailable === false) {
    labels.push("OI/Funding Proxy");
  }
  if (labels.length === 0 && (meta.winningComponent === "LIQUIDATION_SQUEEZE" || meta.component === "LIQUIDATION_SQUEEZE")) {
    return "Liquidation Wick, Squeeze, OI/Funding Proxy";
  }
  return [...new Set(labels)].join(", ");
}

/**
 * Dispatch to the per-strategy formatter using winningComponent / strategyKey.
 * @param {string} strategyKey
 * @param {object|null|undefined} meta
 * @returns {string}
 */
function resolveEntryReasons(strategyKey, meta) {
  const fromMeta =
    meta?.winningComponent ||
    meta?.component ||
    meta?.afRace?.winningComponent ||
    meta?.tsRace?.winningComponent ||
    meta?.mdRace?.winningComponent ||
    meta?.bsRace?.winningComponent ||
    null;
  const key = normalizeStrategyKey(fromMeta || strategyKey);

  switch (key) {
    case "SMART_MONEY_CONCEPTS":
      return formatSmcReasons(meta);
    case "WYCKOFF":
      return formatWyckoffReasons(meta);
    case "VOLUME_SPREAD_ANALYSIS":
      return formatVsaReasons(meta);
    case "TREND_FOLLOWING":
      return formatTrendFollowingReasons(meta);
    case "MARKET_STRUCTURE":
      return formatMarketStructureReasons(meta);
    case "AUCTION_MARKET_THEORY":
      return formatVolumeProfileReasons(meta);
    case "MEAN_REVERSION":
      return formatMeanReversionReasons(meta);
    case "SUPPLY_AND_DEMAND":
      return formatSupplyDemandReasons(meta);
    case "STATISTICAL_ARBITRAGE":
      return formatStatisticalArbitrageReasons(meta);
    case "BREAKOUT_RETEST":
      return formatBreakoutReasons(meta);
    case "ICT_STYLE_TRADING":
      return formatIctStyleReasons(meta);
    case "LIQUIDATION_SQUEEZE":
      return formatLiquidationSqueezeReasons(meta);
    default:
      if (meta?.sequenceMeta) return formatSmcReasons(meta);
      if (meta?.reason && VP_REASON_MAP[meta.reason]) return formatVolumeProfileReasons(meta);
      if (meta?.reason && String(meta.reason).includes("|")) return formatMeanReversionReasons(meta);
      if (meta?.reason && String(meta.reason).startsWith("vsa_")) return formatVsaReasons(meta);
      if (meta?.reason && String(meta.reason).startsWith("wyckoff_")) return formatWyckoffReasons(meta);
      if (meta?.reason && String(meta.reason).startsWith("dow_")) return formatMarketStructureReasons(meta);
      if (meta?.reason && String(meta.reason).startsWith("sd_")) return formatSupplyDemandReasons(meta);
      if (meta?.reason && String(meta.reason).startsWith("sa_")) return formatStatisticalArbitrageReasons(meta);
      if (meta?.reason && String(meta.reason).startsWith("ict_")) return formatIctStyleReasons(meta);
      if (meta?.reason && String(meta.reason).startsWith("ls_")) return formatLiquidationSqueezeReasons(meta);
      return "";
  }
}

// ─── CORE CSV column schema ─────────────────────────────────────────────────
// Human-readable export is strategy-agnostic CORE columns. Strategy-specific
// narrative lives in `entryReasons` — no per-strategy numeric extras.

/** @type {readonly string[]} */
const UNIVERSAL_CSV_COLUMN_KEYS = [
  "id", "symbol", "side", "strategy", "component",
  "entryPrice", "exitPrice", "pnl", "fee", "pnlNet", "result",
  "confidence", "htfTrend", "dailyRegime", "session", "atr",
  "entryReasons", "exitReason", "duration",
  "openTime", "closeTime", "mode", "exchange", "dryRun",
];

/**
 * Extra export columns per winning component (beyond CORE).
 * Intentionally empty — stale ML numerics were dropped from CSV reports.
 * @type {Record<string, readonly string[]>}
 */
const STRATEGY_CSV_SCHEMA = {};

function strategyCsvColumnKeys(componentOrStrategy) {
  const key = normalizeStrategyKey(componentOrStrategy);
  return STRATEGY_CSV_SCHEMA[key] || [];
}

/**
 * Resolve ordered export column keys for a batch of trades.
 * @param {string[]} components — unique winning components in the export
 * @param {string[]} masterOrder — canonical column order (from TRADE_EXPORT_COLUMNS)
 * @returns {string[]}
 */
function resolveExportColumnKeys(components = [], masterOrder = []) {
  const keys = new Set(UNIVERSAL_CSV_COLUMN_KEYS);
  for (const comp of components) {
    for (const k of strategyCsvColumnKeys(comp)) keys.add(k);
  }
  const ordered = masterOrder.length
    ? masterOrder.filter((k) => keys.has(k))
    : [...keys];
  return ordered;
}

module.exports = {
  formatExitReason,
  resolveEntryReasons,
  formatSmcReasons,
  formatWyckoffReasons,
  formatVsaReasons,
  formatTrendFollowingReasons,
  formatMarketStructureReasons,
  formatVolumeProfileReasons,
  formatMeanReversionReasons,
  formatBreakoutReasons,
  formatSupplyDemandReasons,
  formatStatisticalArbitrageReasons,
  formatIctStyleReasons,
  formatLiquidationSqueezeReasons,
  normalizeStrategyKey,
  EXIT_REASON_LABELS,
  UNIVERSAL_CSV_COLUMN_KEYS,
  STRATEGY_CSV_SCHEMA,
  strategyCsvColumnKeys,
  resolveExportColumnKeys,
};
