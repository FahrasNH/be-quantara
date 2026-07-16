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

  let structure = "unclear";
  let confidence = 0;
  if (total > 0) {
    if (hh >= 1 && hl >= 1 && upVotes > downVotes) {
      structure = "uptrend";
      confidence = upVotes / total;
    } else if (lh >= 1 && ll >= 1 && downVotes > upVotes) {
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

  const price = closes?.[lastIdx];
  const prev = closes?.[lastIdx - 1];
  const open = config.opens?.[lastIdx];
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
      meta: { ...meta, structure },
    };
  }

  const bounce = (open != null && Number.isFinite(open) && price > open)
    || (prev != null && Number.isFinite(prev) && price > prev);
  const reject = (open != null && Number.isFinite(open) && price < open)
    || (prev != null && Number.isFinite(prev) && price < prev);

  if (structure === "uptrend" && lastSL?.price != null) {
    const dist = Math.abs(price - lastSL.price);
    const prevDist = prev != null ? Math.abs(prev - lastSL.price) : Infinity;
    const near = dist <= tol;
    // Edge: enter the HL zone this bar, or bounce while already near.
    const edge = near && (prevDist > tol || bounce);
    if (edge && bounce) {
      _abl("passed");
      return {
        vote: "LONG",
        signal: "LONG",
        confidence: Math.min(1, 0.55 + confidence * 0.4),
        reason: "dow_hl_pullback_bounce",
        meta: { ...meta, structure, tol, dist, lastSwingLow: lastSL },
      };
    }
    _abl("rejBounceReject");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: near ? "awaiting_hl_bounce" : "awaiting_hl_pullback",
      meta: { ...meta, structure, tol, dist },
    };
  }

  if (structure === "downtrend" && lastSH?.price != null) {
    const dist = Math.abs(price - lastSH.price);
    const prevDist = prev != null ? Math.abs(prev - lastSH.price) : Infinity;
    const near = dist <= tol;
    const edge = near && (prevDist > tol || reject);
    if (edge && reject) {
      _abl("passed");
      return {
        vote: "SHORT",
        signal: "SHORT",
        confidence: Math.min(1, 0.55 + confidence * 0.4),
        reason: "dow_lh_rally_reject",
        meta: { ...meta, structure, tol, dist, lastSwingHigh: lastSH },
      };
    }
    _abl("rejBounceReject");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: near ? "awaiting_lh_reject" : "awaiting_lh_rally",
      meta: { ...meta, structure, tol, dist },
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
