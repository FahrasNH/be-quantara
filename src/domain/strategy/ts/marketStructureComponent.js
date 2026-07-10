/**
 * Market Structure (Dow Theory HH/HL) component for Trend Surge (TS-SUB-01).
 *
 * Causal fractal swing detection — confirmed only after `rightLook` bars
 * (no look-ahead / no repaint). Classifies structure as uptrend (HH+HL),
 * downtrend (LH+LL), or unclear. Used as a mandatory gate before TS_TF
 * entries on HTF (typically 4h).
 */

"use strict";

const DEFAULTS = {
  // Spec TS-SUB-01 / bug report: confirm swing with 2 bars after pivot (anti-repaint).
  // rightLook=5 was over-strict on HTF and starved confirmed swings → structure forever unclear.
  leftLook: 2,
  rightLook: 2,
  scanBars: 80,
  minSwingPairs: 2,
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

module.exports = {
  DEFAULTS,
  findConfirmedSwingHighs,
  findConfirmedSwingLows,
  classifyMarketStructure,
  evaluateMarketStructureGate,
  evaluateMarketStructureComponent,
};
