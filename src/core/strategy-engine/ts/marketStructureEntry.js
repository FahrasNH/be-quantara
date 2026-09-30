/**
 * Dow Theory (HH/HL) component for Trend Surge (TS-SUB-01).
 *
 * Causal fractal swing detection — confirmed only after `rightLook` bars
 * (no look-ahead / no repaint). Classifies structure as uptrend (HH+HL),
 * downtrend (LH+LL), or unclear.
 *
 * Sprint 12 architecture decision: race participant (independent signal
 * generator), not a hard gate on Trend Following. Gate helpers remain for
 * `tsCombinationMode: "gate"` rollback / A-B comparison.
 */

"use strict";

const {
  applyNoTradeSessionFilter,
  scalpingSessionBlocked,
} = require("../../risk-engine/entryRiskGates");

/** Sprint 23: Market Structure Scalping session filter (Asia block). */
function applyMsSessionFilter(timestamp, opts = {}) {
  return applyNoTradeSessionFilter(timestamp, opts);
}

const DEFAULTS = {
  // Spec TS-SUB-01 / bug report: confirm swing with 2 bars after pivot (anti-repaint).
  // rightLook=5 was over-strict on HTF and starved confirmed swings → structure forever unclear.
  leftLook: 2,
  rightLook: 2,
  scanBars: 80,
  minSwingPairs: 2,
  // Race-mode entry: pullback must land within this fraction of the last swing range.
  entryPullbackPct: 0.35,
  // Prefer ATR when available; fallback uses entryPullbackPct × swing span.
  entryAtrMult: 0.75,
  // A Dow pullback is only actionable when the execution candle actually
  // retests the structural level. Without this, any bullish/bearish close
  // inside the broad HTF zone can masquerade as a bounce/rejection.
  requireLevelRetest: true,
  levelTouchAtrMult: 0.5,
  // Trend-following structure has no positive expectancy in an unconfirmed
  // HTF range. Keep the flag configurable for research/legacy callers, but
  // the project default is fail-closed when an HTF label is present.
  allowHtfSideways: false,
  // A pullback is invalid once the current candle closes through the
  // structural level. A wick through the level is still allowed when the
  // candle reclaims it by close.
  requireStructureIntegrity: true,
  // A confirmed fractal is not automatically a mature continuation setup.
  // `confirmedAt` is causal: the pivot is only usable after rightLook bars
  // have closed, and this gate can require an additional closed HTF bar.
  minBarsAfterConfirmation: 0,
  // Optional entry-TF acceptance gate. It is deliberately opt-in so legacy
  // callers and isolated unit tests retain the pure Dow structure behavior.
  requireLocalTrendAlignment: false,
  localTrendSlopeLookback: 1,
  enabled: true,
};

/**
 * Causal fractal swing highs: pivot at i is confirmed at i+rightLook
 * when highs[i] is strictly greater than leftLook bars before and
 * rightLook bars after. Only pivots with i+rightLook <= lastIdx are returned.
 */
function findConfirmedSwingHighs(highs, lastIdx, leftLook = 5, rightLook = 5, scanBars = 80) {
  const out = [];
  if (!highs || lastIdx < leftLook + rightLook) return out;
  const earliest = Math.max(leftLook, lastIdx - scanBars);
  const latestPivot = lastIdx - rightLook;
  for (let i = earliest; i <= latestPivot; i++) {
    const h = highs[i];
    if (h == null || !Number.isFinite(h)) continue;
    let ok = true;
    for (let j = i - leftLook; j < i && ok; j++) {
      if (highs[j] == null || highs[j] >= h) ok = false;
    }
    for (let j = i + 1; j <= i + rightLook && ok; j++) {
      if (highs[j] == null || highs[j] >= h) ok = false;
    }
    if (ok) out.push({ idx: i, price: h, type: "high", confirmedAt: i + rightLook });
  }
  return out;
}

function findConfirmedSwingLows(lows, lastIdx, leftLook = 5, rightLook = 5, scanBars = 80) {
  const out = [];
  if (!lows || lastIdx < leftLook + rightLook) return out;
  const earliest = Math.max(leftLook, lastIdx - scanBars);
  const latestPivot = lastIdx - rightLook;
  for (let i = earliest; i <= latestPivot; i++) {
    const l = lows[i];
    if (l == null || !Number.isFinite(l)) continue;
    let ok = true;
    for (let j = i - leftLook; j < i && ok; j++) {
      if (lows[j] == null || lows[j] <= l) ok = false;
    }
    for (let j = i + 1; j <= i + rightLook && ok; j++) {
      if (lows[j] == null || lows[j] <= l) ok = false;
    }
    if (ok) out.push({ idx: i, price: l, type: "low", confirmedAt: i + rightLook });
  }
  return out;
}

/**
 * Classify Dow structure from ordered swing highs/lows ending at lastIdx.
 * @returns {{ structure: 'uptrend'|'downtrend'|'unclear', confidence: number, meta: object }}
 */
function classifyMarketStructure(highs, lows, lastIdx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const swingHighs = findConfirmedSwingHighs(
    highs, lastIdx, cfg.leftLook, cfg.rightLook, cfg.scanBars
  );
  const swingLows = findConfirmedSwingLows(
    lows, lastIdx, cfg.leftLook, cfg.rightLook, cfg.scanBars
  );

  const recentHighs = swingHighs.slice(-Math.max(cfg.minSwingPairs + 1, 3));
  const recentLows = swingLows.slice(-Math.max(cfg.minSwingPairs + 1, 3));

  if (recentHighs.length < cfg.minSwingPairs || recentLows.length < cfg.minSwingPairs) {
    return {
      structure: "unclear",
      confidence: 0,
      meta: {
        reason: "insufficient_swings",
        highCount: recentHighs.length,
        lowCount: recentLows.length,
      },
    };
  }

  let hh = 0;
  let lh = 0;
  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i].price > recentHighs[i - 1].price) hh++;
    else if (recentHighs[i].price < recentHighs[i - 1].price) lh++;
  }

  let hl = 0;
  let ll = 0;
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i].price > recentLows[i - 1].price) hl++;
    else if (recentLows[i].price < recentLows[i - 1].price) ll++;
  }

  const upVotes = hh + hl;
  const downVotes = lh + ll;
  const total = upVotes + downVotes;
  const latestHigh = recentHighs[recentHighs.length - 1];
  const priorHigh = recentHighs[recentHighs.length - 2];
  const latestLow = recentLows[recentLows.length - 1];
  const priorLow = recentLows[recentLows.length - 2];
  // Dow structure is defined by the latest confirmed swing pair, not only by
  // a majority vote across older swings. A latest LL must not be masked by
  // older HH/HL votes (and vice versa).
  const latestHighUp = latestHigh?.price > priorHigh?.price;
  const latestHighDown = latestHigh?.price < priorHigh?.price;
  const latestLowUp = latestLow?.price > priorLow?.price;
  const latestLowDown = latestLow?.price < priorLow?.price;
  // A Dow pair also needs causal ordering. A higher low must form after the
  // prior high, and a lower high must form after the prior low. Price-only
  // voting can otherwise combine two unrelated pivots from a noisy sequence.
  const bullishSequence = priorHigh?.idx < latestLow?.idx;
  const bearishSequence = priorLow?.idx < latestHigh?.idx;

  let structure = "unclear";
  let confidence = 0;
  if (total > 0) {
    if (hh >= 1 && hl >= 1 && latestHighUp && latestLowUp && bullishSequence) {
      structure = "uptrend";
      confidence = upVotes / total;
    } else if (lh >= 1 && ll >= 1 && latestHighDown && latestLowDown && bearishSequence) {
      structure = "downtrend";
      confidence = downVotes / total;
    } else {
      confidence = Math.max(upVotes, downVotes) / total;
    }
  }

  return {
    structure,
    confidence,
    meta: {
      reason: structure === "unclear" ? "mixed_structure" : "structure_confirmed",
      hh,
      hl,
      lh,
      ll,
      lastSwingHigh: recentHighs[recentHighs.length - 1],
      lastSwingLow: recentLows[recentLows.length - 1],
      priorSwingHigh: priorHigh,
      priorSwingLow: priorLow,
      bullishSequence,
      bearishSequence,
    },
  };
}

/**
 * Gate check for a proposed TS direction.
 * LONG requires uptrend; SHORT requires downtrend.
 *
 * @returns {{ allowed: boolean, vote: 'LONG'|'SHORT'|'NEUTRAL', confidence: number, reason: string, meta: object }}
 */
function evaluateMarketStructureGate(highs, lows, lastIdx, direction, config = {}) {
  // Invalid / warmup HTF index — do not hard-block (mirrors VWAP session warmup).
  if (!Number.isInteger(lastIdx) || lastIdx < 0) {
    return {
      allowed: true,
      vote: "NEUTRAL",
      confidence: 0,
      reason: "structure_htf_warmup_passthrough",
      meta: { structure: "unclear", htfIdx: lastIdx },
    };
  }

  const classified = classifyMarketStructure(highs, lows, lastIdx, config);
  const { structure, confidence, meta } = classified;

  if (structure === "unclear") {
    // Insufficient confirmed swings = not enough history yet, not a bearish/bullish veto.
    // Hard-blocking here zeroed out entire backtests while HTF warmed up.
    if (meta?.reason === "insufficient_swings") {
      return {
        allowed: true,
        vote: "NEUTRAL",
        confidence: 0,
        reason: "structure_warmup_passthrough",
        meta: { ...meta, structure },
      };
    }
    return {
      allowed: false,
      vote: "NEUTRAL",
      confidence: 0,
      reason: meta?.reason || "structure_unclear",
      meta: { ...meta, structure },
    };
  }

  if (direction === "LONG" && structure === "uptrend") {
    return {
      allowed: true,
      vote: "LONG",
      confidence,
      reason: "structure_uptrend",
      meta: { ...meta, structure },
    };
  }

  if (direction === "SHORT" && structure === "downtrend") {
    return {
      allowed: true,
      vote: "SHORT",
      confidence,
      reason: "structure_downtrend",
      meta: { ...meta, structure },
    };
  }

  return {
    allowed: false,
    vote: "NEUTRAL",
    confidence,
    reason: `structure_blocks_${String(direction || "none").toLowerCase()}`,
    meta: { ...meta, structure, requested: direction },
  };
}

/**
 * Evaluate component standalone (no direction yet) — returns structure bias.
 */
function evaluateMarketStructureComponent(highs, lows, lastIdx, config = {}) {
  const classified = classifyMarketStructure(highs, lows, lastIdx, config);
  if (classified.structure === "uptrend") {
    return {
      vote: "LONG",
      confidence: classified.confidence,
      reason: "structure_uptrend",
      meta: classified.meta,
    };
  }
  if (classified.structure === "downtrend") {
    return {
      vote: "SHORT",
      confidence: classified.confidence,
      reason: "structure_downtrend",
      meta: classified.meta,
    };
  }
  return {
    vote: "NEUTRAL",
    confidence: 0,
    reason: classified.meta?.reason || "structure_unclear",
    meta: classified.meta,
  };
}

function _pullbackTol(lastSwingHigh, lastSwingLow, atr, cfg) {
  const span = Math.abs((lastSwingHigh?.price ?? 0) - (lastSwingLow?.price ?? 0));
  const pctTol = span > 0 ? span * (cfg.entryPullbackPct ?? DEFAULTS.entryPullbackPct) : null;
  if (atr != null && Number.isFinite(atr) && atr > 0) {
    const atrTol = atr * (cfg.entryAtrMult ?? DEFAULTS.entryAtrMult);
    return pctTol != null ? Math.max(atrTol, pctTol * 0.5) : atrTol;
  }
  return pctTol != null && pctTol > 0 ? pctTol : null;
}

/**
 * Full race-participant entry for Dow Theory (Sprint 12).
 * LONG: HTF uptrend + pullback near last HL + bounce candle.
 * SHORT: HTF downtrend + rally near last LH + rejection candle.
 * Edge-triggered so clear structure does not fire every bar.
 *
 * @returns {{ vote, confidence, reason, meta, signal }}
 */
function evaluateMarketStructureEntry(highs, lows, closes, lastIdx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const ablation = config.ablation || null;
  const _abl = (k) => { if (ablation && Object.prototype.hasOwnProperty.call(ablation, k)) ablation[k] += 1; };
  _abl("evaluated");

  const entryIdx = Number.isInteger(config.entryLastIdx) ? config.entryLastIdx : lastIdx;
  if (scalpingSessionBlocked(cfg, { timestamps: cfg.timestamps }, entryIdx, "msSessionFilter", applyMsSessionFilter, ablation)) {
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: "ms_session_block",
      meta: {},
    };
  }

  if (config.htfTrend === "SIDEWAYS" && cfg.allowHtfSideways === false) {
    _abl("rejHtfRegime");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: "htf_sideways_regime",
      meta: { htfTrend: config.htfTrend },
    };
  }

  if (!Number.isInteger(lastIdx) || lastIdx < 1) {
    _abl("rejWarmup");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: "structure_entry_warmup",
      meta: {},
    };
  }

  const classified = classifyMarketStructure(highs, lows, lastIdx, cfg);
  const { structure, confidence, meta } = classified;
  if (structure === "unclear") {
    _abl("rejStructure");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: meta?.reason || "structure_unclear",
      meta: { ...meta, structure },
    };
  }

  if (cfg.enabled === false) {
    _abl("rejDisabled");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: "market_structure_disabled",
      meta: { ...meta, structure },
    };
  }

  const structuralPivot = structure === "uptrend"
    ? meta?.lastSwingLow
    : meta?.lastSwingHigh;
  const barsSinceConfirmation = structuralPivot?.confirmedAt != null
    ? lastIdx - structuralPivot.confirmedAt
    : null;
  const minBarsAfterConfirmation = Math.max(
    0,
    Number(cfg.minBarsAfterConfirmation ?? DEFAULTS.minBarsAfterConfirmation),
  );
  if (
    minBarsAfterConfirmation > 0
    && (barsSinceConfirmation == null || barsSinceConfirmation < minBarsAfterConfirmation)
  ) {
    _abl("rejFreshStructure");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: "structure_not_mature",
      meta: {
        ...meta,
        structure,
        structuralPivot,
        barsSinceConfirmation,
        minBarsAfterConfirmation,
      },
    };
  }

  // Structure is classified on the HTF series, but confirmation must come
  // from the current entry-TF candle. Using the last HTF close here lets a
  // signal fire repeatedly on later entry bars at a stale price while the
  // position is opened at a different market price.
  const priceCloses = config.entryCloses || closes;
  const price = priceCloses?.[entryIdx];
  const prev = priceCloses?.[entryIdx - 1];
  const open = config.entryOpens?.[entryIdx] ?? config.opens?.[lastIdx];
  if (price == null || !Number.isFinite(price)) {
    _abl("rejPrice");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: "no_price",
      meta: { ...meta, structure },
    };
  }

  const entryHigh = config.entryHighs?.[entryIdx];
  const entryLow = config.entryLows?.[entryIdx];
  const entryAtr = config.entryAtr;
  const hasEntryRange = Number.isFinite(entryHigh) && Number.isFinite(entryLow);
  const touchTol = Number.isFinite(entryAtr) && entryAtr > 0
    ? entryAtr * (cfg.levelTouchAtrMult ?? DEFAULTS.levelTouchAtrMult)
    : 0;

  const lastSH = meta?.lastSwingHigh;
  const lastSL = meta?.lastSwingLow;
  const atr = config.atr ?? null;
  const tol = _pullbackTol(lastSH, lastSL, atr, cfg);
  if (tol == null || !Number.isFinite(tol) || tol <= 0) {
    _abl("rejPullback");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: "no_pullback_tolerance",
      meta: { ...meta, structure, structuralPivot, barsSinceConfirmation },
    };
  }

  const bounce = (open != null && Number.isFinite(open) && price > open)
    || (prev != null && Number.isFinite(prev) && price > prev);
  const reject = (open != null && Number.isFinite(open) && price < open)
    || (prev != null && Number.isFinite(prev) && price < prev);

  const entryEmaTrend = config.entryEmaTrend;
  const slopeLookback = Math.max(
    1,
    Number(cfg.localTrendSlopeLookback ?? DEFAULTS.localTrendSlopeLookback),
  );
  const localEma = entryEmaTrend?.[entryIdx];
  const priorLocalEma = entryEmaTrend?.[entryIdx - slopeLookback];
  const localEmaSlope = Number.isFinite(localEma) && Number.isFinite(priorLocalEma)
    ? localEma - priorLocalEma
    : null;
  const localTrendAvailable = Number.isFinite(localEma) && Number.isFinite(localEmaSlope);
  const localTrendAligned = structure === "uptrend"
    ? localTrendAvailable && price >= localEma && localEmaSlope >= 0
    : localTrendAvailable && price <= localEma && localEmaSlope <= 0;
  if (cfg.requireLocalTrendAlignment === true && !localTrendAligned) {
    _abl("rejLocalTrend");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: localTrendAvailable ? "local_trend_misaligned" : "local_trend_unavailable",
      meta: {
        ...meta,
        structure,
        structuralPivot,
        barsSinceConfirmation,
        localEma,
        localEmaSlope,
        localTrendAligned: false,
      },
    };
  }

  const entryMeta = {
    ...meta,
    structure,
    structuralPivot,
    barsSinceConfirmation,
    localEma,
    localEmaSlope,
    localTrendAligned: localTrendAvailable ? localTrendAligned : null,
  };

  if (structure === "uptrend" && lastSL?.price != null) {
    // Do not treat a close below the latest HL as a pullback. The previous
    // implementation used abs(price - HL), which admitted falling-knife
    // longs after the bullish structure had already failed. A wick below HL
    // is intentionally allowed when the close reclaims the level.
    if (cfg.requireStructureIntegrity !== false && price < lastSL.price) {
      _abl("rejInvalidation");
      return {
        vote: "NEUTRAL",
        signal: null,
        confidence: 0,
        reason: "structure_invalidated_below_hl",
        meta: {
          ...entryMeta,
          invalidationLevel: lastSL.price,
          dist: price - lastSL.price,
          lastSwingLow: lastSL,
        },
      };
    }
    const dist = price - lastSL.price;
    const prevDist = prev != null ? Math.abs(prev - lastSL.price) : Infinity;
    const near = dist <= tol;
    const retest = !hasEntryRange || cfg.requireLevelRetest === false
      ? true
      : entryLow <= lastSL.price + touchTol;
    // Edge: enter the HL zone this bar, or bounce while already near.
    const edge = near && (prevDist > tol || bounce);
    if (edge && bounce && retest) {
      _abl("passed");
      return {
        vote: "LONG",
        signal: "LONG",
        confidence: Math.min(1, 0.55 + confidence * 0.4),
        reason: "dow_hl_pullback_bounce",
        meta: { ...entryMeta, tol, dist, lastSwingLow: lastSL },
      };
    }
    _abl("rejBounceReject");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: !retest ? "awaiting_hl_retest" : (near ? "awaiting_hl_bounce" : "awaiting_hl_pullback"),
      meta: { ...entryMeta, tol, dist, touchTol, retest },
    };
  }

  if (structure === "downtrend" && lastSH?.price != null) {
    // Symmetric guard for bearish structure: a close above the latest LH is
    // no longer a valid rally/rejection setup.
    if (cfg.requireStructureIntegrity !== false && price > lastSH.price) {
      _abl("rejInvalidation");
      return {
        vote: "NEUTRAL",
        signal: null,
        confidence: 0,
        reason: "structure_invalidated_above_lh",
        meta: {
          ...entryMeta,
          invalidationLevel: lastSH.price,
          dist: lastSH.price - price,
          lastSwingHigh: lastSH,
        },
      };
    }
    const dist = lastSH.price - price;
    const prevDist = prev != null ? Math.abs(prev - lastSH.price) : Infinity;
    const near = dist <= tol;
    const retest = !hasEntryRange || cfg.requireLevelRetest === false
      ? true
      : entryHigh >= lastSH.price - touchTol;
    const edge = near && (prevDist > tol || reject);
    if (edge && reject && retest) {
      _abl("passed");
      return {
        vote: "SHORT",
        signal: "SHORT",
        confidence: Math.min(1, 0.55 + confidence * 0.4),
        reason: "dow_lh_rally_reject",
        meta: { ...entryMeta, tol, dist, lastSwingHigh: lastSH },
      };
    }
    _abl("rejBounceReject");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: !retest ? "awaiting_lh_retest" : (near ? "awaiting_lh_reject" : "awaiting_lh_rally"),
      meta: { ...entryMeta, tol, dist, touchTol, retest },
    };
  }

  _abl("rejBounceReject");
  return {
    vote: "NEUTRAL",
    signal: null,
    confidence: 0,
    reason: "structure_no_entry",
    meta: { ...meta, structure },
  };
}

module.exports = {
  DEFAULTS,
  findConfirmedSwingHighs,
  findConfirmedSwingLows,
  classifyMarketStructure,
  evaluateMarketStructureGate,
  evaluateMarketStructureComponent,
  evaluateMarketStructureEntry,
};
