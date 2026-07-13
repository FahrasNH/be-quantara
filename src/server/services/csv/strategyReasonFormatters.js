/**
 * strategyReasonFormatters.js — Per-strategy entry/exit reason labels for CSV export.
 *
 * ── Umbrella_Component key scheme (canonical v2.0) ──────────────────────────
 * Strategies are keyed as Umbrella_Component so race-to-confirm can attribute
 * the winning racer on each bar. Dispatchers MUST use winningComponent when
 * present (not the umbrella key alone):
 *
 *   Adaptive Fusion (FOUNDRY): AF_SMC | AF_WYCKOFF | AF_VSA
 *   Trend Surge     (FORGE):   TS_TF  | TS_MS      | TS_VP
 *   Mean Drift      (MINT):    MD_MR  | MD_SD      | MD_SA
 *   Breakout Storm  (VAULT):   BS_BR  | BS_ICT     | BS_LS
 *
 * Legacy aliases (SMART_MONEY_CONCEPTS → AF_SMC, etc.) are normalised below.
 *
 * ── Hard-gate caveats (low inter-trade variance) ────────────────────────────
 * AF_SMC: Sweep → CHoCH → FVG are hard prerequisites in _detectSMCSequence.
 *   Nearly every trade will show the same labels; only FVG direction and
 *   obConfluence ("Fresh Order Block") typically vary.
 * AF_WYCKOFF: Multi-item entry checklist — passed trades share the same layers.
 * TS_TF: HTF + ADX + Donchian + EMA9 retest + volume are all required — labels
 *   are nearly identical across fills. Treat as checklist confirmation, not a
 *   unique per-trade narrative.
 */

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
  SMART_MONEY_CONCEPTS: "AF_SMC",
  SMC: "AF_SMC",
  WYCKOFF: "AF_WYCKOFF",
  VSA: "AF_VSA",
  TREND_FOLLOWING: "TS_TF",
  MARKET_STRUCTURE: "TS_MS",
  DOW_THEORY: "TS_MS",
  VOLUME_PROFILE: "TS_VP",
  AMT: "TS_VP",
  MEAN_REVERSION: "MD_MR",
  BREAKOUT_RETEST: "BS_BR",
  BREAKOUT: "BS_BR",
  ADAPTIVE_FUSION: "AF_SMC",
  TREND_SURGE: "TS_TF",
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
  return LEGACY_KEY_MAP[upper] || upper;
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

// ─── 1. AF_SMC ───────────────────────────────────────────────────────────────
// Hard-gate: sweepIdx/chochIdx/fvg are prerequisites — labels repeat across trades.

function formatSmcReasons(meta) {
  if (!meta) return "";
  const seq = meta.sequenceMeta || meta.meta?.sequenceMeta || meta;
  if (!seq || typeof seq !== "object") return "";

  const reasons = [];
  if (Number.isFinite(seq.sweepIdx) && seq.sweepIdx >= 0) reasons.push("Liquidity Sweep");
  if (Number.isFinite(seq.chochIdx) && seq.chochIdx >= 0) reasons.push("CHoCH");
  if (seq.fvg) {
    const t = String(seq.fvg.type || "").toLowerCase();
    if (t.includes("bull")) reasons.push("Bullish FVG");
    else if (t.includes("bear")) reasons.push("Bearish FVG");
    else reasons.push("FVG");
  }
  if (seq.obConfluence) reasons.push("Fresh Order Block");
  return reasons.join(", ");
}

// ─── 2. AF_WYCKOFF ───────────────────────────────────────────────────────────
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
    if (checklist.manipulation) reasons.push("Manipulation");
    if (checklist.reclaimOrReject) reasons.push("Reclaim/Reject");
    if (checklist.volumeConfirm) reasons.push("Volume Confirmation");
    if (checklist.lpsOrLpsy) {
      if (!reasons.includes("LPS") && !reasons.includes("LPSY")) reasons.push("LPS/LPSY");
    }
  }

  if (reasons.length === 0 && raw) return titleCaseSnake(raw);
  return [...new Set(reasons)].join(", ");
}

// ─── 3. AF_VSA ───────────────────────────────────────────────────────────────

const VSA_REASON_MAP = {
  vsa_stopping_volume_low: "Stopping Volume",
  vsa_stopping_volume_high: "Stopping Volume",
  vsa_no_demand: "No-Demand",
  vsa_no_supply: "No-Supply",
};

function _vsaLocationLabel(nearSwing) {
  if (!nearSwing) return null;
  const t = String(nearSwing.type || nearSwing.swingType || "").toLowerCase();
  if (t === "high" || t.includes("high")) return "near Swing High";
  if (t === "low" || t.includes("low")) return "near Swing Low";
  if (t === "mid" || t.includes("mid")) return "Mid-Range";
  return null;
}

function formatVsaReasons(meta) {
  if (!meta) return "";
  const raw = meta.reason || meta.meta?.reason || "";
  const pattern = VSA_REASON_MAP[raw];
  const nearSwing = meta.meta?.nearSwing || meta.nearSwing || null;
  const loc = _vsaLocationLabel(nearSwing);

  if (pattern) return loc ? `${pattern} ${loc}` : pattern;
  if (!raw) return "";
  if (/stopping_volume/i.test(raw)) {
    const base = "Stopping Volume";
    return loc ? `${base} ${loc}` : base;
  }
  if (/no_demand/i.test(raw)) return loc ? `No-Demand ${loc}` : "No-Demand";
  if (/no_supply/i.test(raw)) return loc ? `No-Supply ${loc}` : "No-Supply";
  return titleCaseSnake(raw);
}

// ─── 4. TS_TF ────────────────────────────────────────────────────────────────
// Hard-gate 3-layer checklist — very low variance.

function formatTrendFollowingReasons(meta) {
  if (!meta) return "";
  const flags = meta.entryChecklist || meta;
  const adxMin = meta.adxMinStrength ?? flags.adxMinStrength ?? 25;
  const donchianPeriod = meta.donchianPeriod ?? flags.donchianPeriod ?? 20;
  const reasons = [];

  if (flags.htfTrendAligned || flags.htfTrendConfirmed) reasons.push("HTF Trend Aligned");
  if (flags.adxPassed || (flags.adxStrength != null && flags.adxStrength >= adxMin)) {
    reasons.push(`ADX ≥ ${adxMin}`);
  }
  if (flags.donchianBroken) reasons.push(`Donchian ${donchianPeriod}-bar Breakout`);
  if (flags.ema9Retest || flags.emaRetestHeld) reasons.push("EMA9 Retest");
  if (flags.volumeConfirmed) reasons.push("Volume Confirmed");

  // Signal fired ⇒ all hard gates passed even if flags were not snapshotted.
  if (reasons.length === 0 && (meta.winningComponent === "TS_TF" || meta.component === "TS_TF")) {
    if (meta.htfTrendConfirmed) reasons.push("HTF Trend Aligned");
    if (meta.adxStrength != null) reasons.push(`ADX ≥ ${adxMin}`);
    if (meta.donchianBroken) reasons.push(`Donchian ${donchianPeriod}-bar Breakout`);
  }
  return reasons.join(", ");
}

// ─── 5. TS_MS ────────────────────────────────────────────────────────────────

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
    labels.push("Confirmed Swing Structure");
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
    labels.push("LH/LL Pattern");
  }

  if (/bounce/i.test(reason)) labels.push("Pullback Bounce");
  if (/reject/i.test(reason)) labels.push("Pullback Reject");
  if (reason.startsWith("dow_")) labels.push("Same-Bar Confirmation");

  if (labels.length === 0 && reason) return titleCaseSnake(reason);
  return [...new Set(labels)].join(", ");
}

// ─── 6. TS_VP ────────────────────────────────────────────────────────────────

const VP_REASON_MAP = {
  vwap_reclaim: "VWAP Reclaim",
  vwap_lose: "VWAP Lose",
  val_bounce: "VAL Bounce",
  vah_reject: "VAH Rejection",
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

// ─── 7. MD_MR ────────────────────────────────────────────────────────────────

function formatMeanReversionReasons(meta) {
  if (!meta) return "";
  const reason = String(meta.reason || "");
  const labels = [];

  if (/RSI\s+[\d.]+\s*</i.test(reason) || /oversold/i.test(reason)) labels.push("RSI Oversold");
  if (/RSI\s+[\d.]+\s*>/i.test(reason) || /overbought/i.test(reason)) labels.push("RSI Overbought");
  if (/\bBB\b/i.test(reason) || /bollinger/i.test(reason)) labels.push("Bollinger Band Touch");
  if (/VWAP/i.test(reason)) labels.push("VWAP Deviation");

  const adxRegime = meta.adxRegime || (reason.match(/ADX:(\w+)/i) || [])[1];
  if (adxRegime) {
    const r = String(adxRegime).toLowerCase();
    if (r === "balance") labels.push("ADX Balance");
    else if (r === "transition") labels.push("ADX Transition");
    else if (r === "imbalance") labels.push("ADX Imbalance");
    else labels.push(`ADX ${titleCaseSnake(adxRegime)}`);
  }

  if (meta.hasObFvgConfluence === true || /OB\/FVG✓/.test(reason)) {
    labels.push("Order Block/FVG Confluence");
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

// ─── 8. BS_BR ────────────────────────────────────────────────────────────────
// Hard-gate 3-phase sequential — very low variance.

function formatBreakoutReasons(meta) {
  if (!meta) return "";
  const reasons = [];
  if (meta.bbSqueeze || meta.consolidationConfirmed || meta.squeeze) {
    reasons.push("BB Squeeze");
  }
  if (meta.rangeBreakout || meta.breakoutConfirmed) {
    reasons.push("Range Breakout");
  }
  if (meta.retestConfirmation || meta.retestConfirmed) {
    reasons.push("Retest Confirmation");
  }
  // Signal path always completes all three phases when meta is set on fill.
  if (reasons.length === 0 && (meta.winningComponent === "BS_BR" || meta.component === "BS_BR")) {
    return "BB Squeeze, Range Breakout, Retest Confirmation";
  }
  return reasons.join(", ");
}

// ─── 9. MD_SD ────────────────────────────────────────────────────────────────

function formatSupplyDemandReasons(meta) {
  if (!meta) return "";
  const labels = [];
  const zt = meta.zoneType || "";
  if (/demand/i.test(zt) || /demand/i.test(meta.reason || "")) labels.push("Demand Zone Retest");
  if (/supply/i.test(zt) || /supply/i.test(meta.reason || "")) labels.push("Supply Zone Retest");
  if (/fvg/i.test(zt) || /fvg/i.test(meta.reason || "")) labels.push("FVG Imbalance");
  if (/ob/i.test(zt) || /order.?block/i.test(meta.reason || "")) labels.push("Order Block");
  if (labels.length === 0 && (meta.winningComponent === "MD_SD" || meta.component === "MD_SD")) {
    return "Supply and Demand Retest";
  }
  return labels.join(", ");
}

// ─── 10. MD_SA ───────────────────────────────────────────────────────────────

function formatStatisticalArbitrageReasons(meta) {
  if (!meta) return "";
  const labels = ["Statistical Arbitrage v1"];
  if (meta.zScore != null && Number.isFinite(meta.zScore)) {
    labels.push(`Z-Score ${Number(meta.zScore).toFixed(2)}`);
  }
  if (meta.saMode) labels.push(titleCaseSnake(meta.saMode));
  if (labels.length === 1 && meta.reason) {
    return `${labels[0]}, ${titleCaseSnake(meta.reason)}`;
  }
  return labels.join(", ");
}

// ─── 11. BS_ICT ──────────────────────────────────────────────────────────────

function formatIctStyleReasons(meta) {
  if (!meta) return "";
  const labels = [];
  if (meta.killZone?.active || /kz|kill_zone|london|ny_open/i.test(meta.reason || "")) {
    labels.push("Kill Zone");
    if (meta.killZone?.zone) labels.push(titleCaseSnake(meta.killZone.zone));
  }
  if (meta.raid?.detected || /raid/i.test(meta.reason || "")) {
    labels.push("Liquidity Raid");
    if (meta.raid?.direction === "LONG" || /raid_low/i.test(meta.reason || "")) {
      labels.push("Raid Low → Long");
    } else if (meta.raid?.direction === "SHORT" || /raid_high/i.test(meta.reason || "")) {
      labels.push("Raid High → Short");
    }
  }
  if (labels.length === 0 && (meta.winningComponent === "BS_ICT" || meta.component === "BS_ICT")) {
    return "ICT Kill Zone, Liquidity Raid";
  }
  return labels.join(", ");
}

// ─── 12. BS_LS ───────────────────────────────────────────────────────────────

function formatLiquidationSqueezeReasons(meta) {
  if (!meta) return "";
  const labels = [];
  if (meta.wick?.detected || /liquidation_wick|ls_/i.test(meta.reason || "")) {
    labels.push("Liquidation Wick");
  }
  if (meta.funding != null && Number.isFinite(meta.funding)) {
    labels.push("Funding Extreme");
  }
  if (meta.oiChange != null && Number.isFinite(meta.oiChange)) {
    labels.push("OI Change");
  }
  if (meta.dataAvailable === false) {
    labels.push("OI/Funding Unavailable (Fail-Open)");
  }
  if (labels.length === 0 && (meta.winningComponent === "BS_LS" || meta.component === "BS_LS")) {
    return "Liquidation/Squeeze Signal";
  }
  return labels.join(", ");
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
    case "AF_SMC":
      return formatSmcReasons(meta);
    case "AF_WYCKOFF":
      return formatWyckoffReasons(meta);
    case "AF_VSA":
      return formatVsaReasons(meta);
    case "TS_TF":
      return formatTrendFollowingReasons(meta);
    case "TS_MS":
      return formatMarketStructureReasons(meta);
    case "TS_VP":
      return formatVolumeProfileReasons(meta);
    case "MD_MR":
      return formatMeanReversionReasons(meta);
    case "MD_SD":
      return formatSupplyDemandReasons(meta);
    case "MD_SA":
      return formatStatisticalArbitrageReasons(meta);
    case "BS_BR":
      return formatBreakoutReasons(meta);
    case "BS_ICT":
      return formatIctStyleReasons(meta);
    case "BS_LS":
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
};
