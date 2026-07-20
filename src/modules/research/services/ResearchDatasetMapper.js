"use strict";

/**
 * ResearchDatasetMapper — normalize CSV/XLSX/backtest rows into TradeResearchDataset records.
 */

const { normalizeStrategyKey } = require("../../../config/strategyKeyNormalizer");
const {
  enrichMetaWithGradedScore,
  scoreComponent,
  buildFeaturesFromMeta,
} = require("../../../core/strategy-engine/scoring/ComponentScoringEngine");
const {
  extractSmcEnrichment,
  extractGradedScoreEnrichment,
} = require("../../../shared/csv/strategyMlEnrichment");
const {
  resolveStrategyKey,
  smcBreakdownToFeatureScores,
  DATA_QUALITY_FLAGS,
} = require("../../../models/researchDatasetSchema");

function _num(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function _str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/** Parse "5m", "1h 45m", "2h", numeric minutes. */
function parseDurationMinutes(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const s = String(raw).trim().toLowerCase();
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  let total = 0;
  const h = s.match(/(\d+(?:\.\d+)?)\s*h/);
  const m = s.match(/(\d+(?:\.\d+)?)\s*m/);
  if (h) total += parseFloat(h[1]) * 60;
  if (m) total += parseFloat(m[1]);
  if (!h && !m && /^\d+$/.test(s)) return parseInt(s, 10);
  return total > 0 ? total : null;
}

/** Parse Notion/UI date strings and ISO timestamps. */
function parseDateTime(raw) {
  if (!raw) return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
  const s = String(raw).trim().replace(/\s+UTC$/i, "");
  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return new Date(iso);
  const m = s.match(
    /^(\d{1,2})\s+(\w+)\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s+UTC)?$/i
  );
  if (m) {
    const months = {
      january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
      july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    };
    const mo = months[m[2].toLowerCase()];
    if (mo == null) return null;
    let hour = parseInt(m[4], 10);
    const min = parseInt(m[5], 10);
    const ampm = m[6].toUpperCase();
    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
    return new Date(Date.UTC(parseInt(m[3], 10), mo, parseInt(m[1], 10), hour, min));
  }
  return null;
}

function inferTradeType(component, durationMin) {
  const c = String(component || "").toLowerCase();
  if (c.includes("scalp")) return "Scalping";
  if (c.includes("swing")) return "Swing";
  if (c.includes("intraday")) return "Intraday";
  if (durationMin != null) {
    if (durationMin <= 120) return "Scalping";
    if (durationMin <= 480) return "Intraday";
    return "Swing";
  }
  return "Scalping";
}

function volatilityBucket(atrPercent) {
  if (atrPercent == null) return null;
  if (atrPercent < 0.5) return "low";
  if (atrPercent < 1.5) return "medium";
  return "high";
}

function parseEntryReasons(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
}

function inferSmcMetaFromEntryReasons(entryReasons, row = {}) {
  const text = entryReasons.join(" ").toLowerCase();
  const meta = {
    sweepStrength: text.includes("sweep") ? 1.2 : null,
    displacementPct: text.includes("displacement") ? 0.5 : null,
    fvgSizeAtr: text.includes("fvg") ? 0.6 : null,
    htfAdx: _num(row["HTF ADX"] ?? row.htfAdx) ?? 25,
    confObConfluence: text.includes("ob") || text.includes("order block"),
    confMitigationDepth: text.includes("mitigation") ? 0.4 : null,
    confHtfAlignment: _num(row["Conf HTF Align"] ?? row.confHtfAlignment) ?? 5,
  };
  return meta;
}

function buildGradedFromRow(row, strategyKey) {
  const key = resolveStrategyKey(strategyKey || row.Strategy || row.strategy);
  const smc = extractSmcEnrichment({
    sweepStrength: _num(row["Sweep Strength"] ?? row.sweepStrength),
    fvgSizeAtr: _num(row["FVG Size ATR"] ?? row.fvgSizeAtr),
    obDistanceAtr: _num(row["OB Distance ATR"] ?? row.obDistanceAtr),
    displacementPct: _num(row["Displacement %"] ?? row.displacementPct),
    htfAdx: _num(row["HTF ADX"] ?? row.htfAdx),
    confSweepStrength: _num(row["Conf Sweep"] ?? row.confSweepStrength),
    confFvgSize: _num(row["Conf FVG"] ?? row.confFvgSize),
    confDisplacementPct: _num(row["Conf Disp %"] ?? row.confDisplacementPct),
    confHtfAlignment: _num(row["Conf HTF Align"] ?? row.confHtfAlignment),
    confMitigationDepth: _num(row["Conf Mitigation"] ?? row.confMitigationDepth),
    confObConfluence: row["Conf OB Confluence"] ?? row.confObConfluence,
  });

  const hasMl = Object.values(smc).some((v) => v != null);
  const entryReasons = parseEntryReasons(row["Entry Reasons"] ?? row.entryReasons);
  const meta = hasMl
    ? { ...smc, winningComponent: row.Component || key }
    : inferSmcMetaFromEntryReasons(entryReasons, row);

  const gradedRaw = extractGradedScoreEnrichment({
    gradedScore: _num(row.gradedScore ?? row["Graded Score"]),
    gradedScoreBreakdown: row.gradedScoreBreakdown ?? row["Graded Score Breakdown"],
    componentConfidence: _num(row.Confidence ?? row.confidence),
    ...meta,
    winningComponent: row.Component || key,
  });

  let gradedScore = gradedRaw.gradedScore;
  let breakdown = null;
  let inferred = false;

  if (hasMl) {
    const enriched = enrichMetaWithGradedScore({ ...meta, winningComponent: key }, key);
    gradedScore = enriched?.gradedScore ?? gradedScore;
    breakdown = enriched?.gradedScoreBreakdown ?? null;
  } else if (gradedScore == null) {
    const enriched = enrichMetaWithGradedScore({ ...meta, winningComponent: key }, key);
    gradedScore = enriched?.gradedScore ?? _num(row.Confidence ?? row.confidence);
    breakdown = enriched?.gradedScoreBreakdown ?? null;
    inferred = true;
  } else {
    const features = buildFeaturesFromMeta(meta, key);
    const scored = scoreComponent(key, features);
    breakdown = scored.breakdown;
  }

  if (typeof breakdown === "string") {
    try { breakdown = JSON.parse(breakdown); } catch { breakdown = null; }
  }

  return {
    gradedScore,
    gradedScoreBreakdown: breakdown,
    scoringStrategyKey: key,
    inferred,
    featureScores: key === "SMART_MONEY_CONCEPTS"
      ? smcBreakdownToFeatureScores(breakdown || {}, gradedScore)
      : { totalScore: gradedScore },
  };
}

function estimateMfeMae({ side, entryPrice, exitPrice, atr, result, pnlGross }) {
  if (!entryPrice || !exitPrice) {
    return { mfe: null, mae: null, mfePercent: null, maePercent: null, estimated: true };
  }
  const move = side === "LONG" ? exitPrice - entryPrice : entryPrice - exitPrice;
  const absMove = Math.abs(exitPrice - entryPrice);
  const atrSafe = atr && atr > 0 ? atr : absMove || 1;
  const favorable = move > 0 ? absMove : (result === "loss" ? atrSafe * 0.3 : 0);
  const adverse = move < 0 ? absMove : (result === "win" ? atrSafe * 0.25 : 0);
  return {
    mfe: favorable,
    mae: adverse,
    mfePercent: entryPrice > 0 ? (favorable / entryPrice) * 100 : null,
    maePercent: entryPrice > 0 ? (adverse / entryPrice) * 100 : null,
    estimated: true,
    realizedRr: pnlGross != null && atrSafe > 0 ? pnlGross / atrSafe : null,
  };
}

/**
 * Map a flat export row (CSV/XLSX) to Prisma create input.
 * @param {object} row
 * @param {object} opts — { migrationBatch, sourceFile, rawIdPrefix }
 */
function mapExportRowToDataset(row, opts = {}) {
  const rawId = _str(row.ID ?? row.id ?? row.tradeId);
  const migrationBatch = opts.migrationBatch || "default";
  const tradeId = rawId ? `${migrationBatch}:${rawId}` : `${migrationBatch}:${opts.rowIndex ?? Date.now()}`;

  const entryPrice = _num(row["Entry Price"] ?? row.entryPrice);
  const exitPrice = _num(row["Exit Price"] ?? row.exitPrice);
  const atr = _num(row.ATR ?? row.atr);
  const entryTime = parseDateTime(row["Open Time"] ?? row.openTime);
  const exitTime = parseDateTime(row["Close Time"] ?? row.closeTime);
  const holdDurationMinutes = parseDurationMinutes(
    row.Duration ?? row.duration ?? (row["Hold Hours"] != null ? _num(row["Hold Hours"]) * 60 : null)
  );
  const side = _str(row.Side ?? row.side)?.toUpperCase() || null;
  const strategyKey = resolveStrategyKey(row.Strategy ?? row.strategy);
  const component = _str(row.Component ?? row.component);
  const pnlGross = _num(row["PnL Gross"] ?? row.pnl ?? row.pnlGross);
  const pnlNet = _num(row["PnL Net"] ?? row.pnlNet);
  const fee = _num(row.Fee ?? row.fee);
  const result = _str(row.Result ?? row.result)?.toLowerCase() || null;
  const entryReasons = parseEntryReasons(row["Entry Reasons"] ?? row.entryReasons);
  const exitReason = _str(row["Exit Reason"] ?? row.exitReason ?? row.reason);
  const atrPercent = entryPrice && atr ? (atr / entryPrice) * 100 : null;

  const graded = buildGradedFromRow(row, strategyKey);
  const rowMfe = _num(row.MFE ?? row.mfe);
  const rowMae = _num(row.MAE ?? row.mae);
  const rowMfePct = _num(row["MFE %"] ?? row.mfePercent);
  const rowMaePct = _num(row["MAE %"] ?? row.maePercent);
  const hasMeasuredExcursion = rowMfe != null || rowMae != null;
  const mfeMae = hasMeasuredExcursion
    ? {
        mfe: rowMfe,
        mae: rowMae,
        mfePercent: rowMfePct ?? (entryPrice > 0 && rowMfe != null ? (rowMfe / entryPrice) * 100 : null),
        maePercent: rowMaePct ?? (entryPrice > 0 && rowMae != null ? (rowMae / entryPrice) * 100 : null),
        estimated: false,
        realizedRr: _num(row["Actual R:R"] ?? row.actualRR),
      }
    : estimateMfeMae({ side, entryPrice, exitPrice, atr, result, pnlGross });

  const flags = [];
  if (graded.inferred) flags.push(DATA_QUALITY_FLAGS.INFERRED_SCORES);
  if (mfeMae.estimated) flags.push(DATA_QUALITY_FLAGS.ESTIMATED_MFE_MAE);
  if (!graded.gradedScore) flags.push(DATA_QUALITY_FLAGS.NULL_FEATURES);
  if (!entryTime || !exitTime) flags.push(DATA_QUALITY_FLAGS.PARTIAL_DATA);

  const holdDays = holdDurationMinutes != null ? holdDurationMinutes / (60 * 24) : null;

  return {
    tradeId,
    backtestId: _str(row["Session ID"] ?? row.sessionId) || migrationBatch,
    symbol: _str(row.Symbol ?? row.symbol)?.toUpperCase(),
    side,
    strategyKey,
    component,
    tradeType: inferTradeType(component, holdDurationMinutes),
    entryPrice,
    exitPrice,
    entryTime,
    exitTime,
    pnlGross,
    pnlNet,
    fee,
    result,
    exitReason,
    holdDurationMinutes,
    sessionName: _str(row.Session ?? row.session),
    dailyRegime: _str(row["Daily Regime"] ?? row.dailyRegime),
    htfTrend: _str(row["HTF Trend"] ?? row.htfTrend),
    atr,
    atrPercent,
    volatilityBucket: volatilityBucket(atrPercent),
    gradedScore: graded.gradedScore,
    gradedScoreBreakdown: graded.gradedScoreBreakdown,
    scoringStrategyKey: graded.scoringStrategyKey,
    featureScores: graded.featureScores,
    mfe: mfeMae.mfe,
    mae: mfeMae.mae,
    mfePercent: mfeMae.mfePercent,
    maePercent: mfeMae.maePercent,
    realizedRr: mfeMae.realizedRr ?? _num(row["Actual R:R"] ?? row.actualRR),
    holdDays,
    entryReasons,
    exitReasons: exitReason ? [exitReason] : [],
    sourceFile: opts.sourceFile || null,
    dataQualityFlags: flags,
    migrationBatch,
  };
}

module.exports = {
  parseDurationMinutes,
  parseDateTime,
  parseEntryReasons,
  inferTradeType,
  buildGradedFromRow,
  estimateMfeMae,
  mapExportRowToDataset,
  resolveStrategyKey,
};
