/**
 * Order Block + Fair Value Gap precision for Mean Drift (MD-SUB-02).
 *
 * Component C — entry/TP refinement on top of BB+RSI (Component A).
 *   - Entry: MD signal only gets full confidence when price overlaps a nearby
 *     order block or unfilled FVG within radius 0.5×ATR.
 *   - Without confluence: signal still fires (fail-open) at reduced confidence.
 *   - TP: prefer nearest unfilled FVG in trade direction; fallback to BB middle.
 */

"use strict";

const DEFAULTS = {
  fvgScanBars: 30,
  fvgMinGapPct: 0.002, // 0.2% — tighter than SMC 0.3% for 5m/15m MR
  obLookback: 20,
  obDispMult: 1.5, // volume displacement vs volSMA
  confluenceAtrMult: 0.5,
  noConfluenceConfidenceMult: 0.7,
  withConfluenceConfidenceBoost: 1.1,
};

/**
 * 3-candle Fair Value Gaps up to lastIdx.
 * Bullish: lows[i] > highs[i-2]; Bearish: highs[i] < lows[i-2].
 * Filled when current close has traded through the gap.
 *
 * @returns {{ bullish: object[], bearish: object[] }}
 */
function detectFairValueGaps(highs, lows, closes, lastIdx, opts = {}) {
  const scanBars = opts.fvgScanBars ?? DEFAULTS.fvgScanBars;
  const minGapPct = opts.fvgMinGapPct ?? DEFAULTS.fvgMinGapPct;
  const bullish = [];
  const bearish = [];
  if (!highs || !lows || !closes || lastIdx < 2) return { bullish, bearish };

  const cl = closes[lastIdx];
  const start = Math.max(2, lastIdx - scanBars);

  for (let i = start; i <= lastIdx; i++) {
    const ref = Math.max(Math.abs(closes[i - 1] || closes[i] || 1), 1e-12);

    const bullGap = (lows[i] - highs[i - 2]) / ref;
    if (bullGap > minGapPct) {
      const top = lows[i];
      const bottom = highs[i - 2];
      bullish.push({
        type: "bullish",
        top,
        bottom,
        midpoint: (top + bottom) / 2,
        size: bullGap,
        idx: i,
        filled: cl < bottom,
      });
    }

    const bearGap = (lows[i - 2] - highs[i]) / ref;
    if (bearGap > minGapPct) {
      const top = lows[i - 2];
      const bottom = highs[i];
      bearish.push({
        type: "bearish",
        top,
        bottom,
        midpoint: (top + bottom) / 2,
        size: bearGap,
        idx: i,
        filled: cl > top,
      });
    }
  }

  return { bullish, bearish };
}

/**
 * Order block = last opposing candle before an impulsive displacement that
 * breaks local structure (volume-confirmed next bar).
 *
 * @returns {{ bullish: object[], bearish: object[] }}
 */
function detectOrderBlocks(opens, highs, lows, closes, volumes, volSMA, lastIdx, opts = {}) {
  const lookback = opts.obLookback ?? DEFAULTS.obLookback;
  const dispMult = opts.obDispMult ?? DEFAULTS.obDispMult;
  const bullish = [];
  const bearish = [];
  if (!closes || lastIdx < lookback + 2) return { bullish, bearish };

  const from = Math.max(1, lastIdx - lookback);
  for (let i = lastIdx - 2; i >= from; i--) {
    const open = opens ? (opens[i] ?? closes[i - 1] ?? closes[i]) : closes[i];
    const nextVol = volumes?.[i + 1] ?? 0;
    const nextVSMA = volSMA?.[i + 1] ?? volSMA?.[i] ?? 1;
    const volOk = nextVSMA > 0 && nextVol > nextVSMA * dispMult;

    // Bullish OB: bearish candle then impulsive bullish displacement
    if (closes[i] < open && volOk && closes[i + 1] > closes[i]) {
      bullish.push({
        type: "bullish_OB",
        high: highs[i],
        low: lows[i],
        mid: (highs[i] + lows[i]) / 2,
        idx: i,
        strength: nextVSMA > 0 ? nextVol / nextVSMA : 1,
      });
    }

    // Bearish OB: bullish candle then impulsive bearish displacement
    if (closes[i] > open && volOk && closes[i + 1] < closes[i]) {
      bearish.push({
        type: "bearish_OB",
        high: highs[i],
        low: lows[i],
        mid: (highs[i] + lows[i]) / 2,
        idx: i,
        strength: nextVSMA > 0 ? nextVol / nextVSMA : 1,
      });
    }
  }

  return { bullish, bearish };
}

function _zoneDistance(price, zoneLow, zoneHigh) {
  if (price >= zoneLow && price <= zoneHigh) return 0;
  if (price < zoneLow) return zoneLow - price;
  return price - zoneHigh;
}

/**
 * Refine MD entry: require price overlap with OB/FVG within confluenceAtrMult×ATR
 * for full confidence. Without confluence → keep signal, lower confidence.
 *
 * @returns {{
 *   hasConfluence: boolean,
 *   confidenceMult: number,
 *   reason: string,
 *   nearestOb: object|null,
 *   nearestFvg: object|null,
 *   fvgs: object,
 *   orderBlocks: object,
 * }}
 */
function refineMdEntry({
  signal,
  price,
  atr,
  opens,
  highs,
  lows,
  closes,
  volumes,
  volSMA,
  lastIdx,
  config = {},
} = {}) {
  const atrMult = config.mdConfluenceAtrMult ?? config.confluenceAtrMult ?? DEFAULTS.confluenceAtrMult;
  const noConfMult =
    config.mdNoConfluenceConfidenceMult ??
    config.noConfluenceConfidenceMult ??
    DEFAULTS.noConfluenceConfidenceMult;
  const boostMult =
    config.mdWithConfluenceConfidenceBoost ??
    config.withConfluenceConfidenceBoost ??
    DEFAULTS.withConfluenceConfidenceBoost;

  const fvgOpts = {
    fvgScanBars: config.mdFvgScanBars ?? config.fvgScanBars ?? DEFAULTS.fvgScanBars,
    fvgMinGapPct: config.mdFvgMinGapPct ?? config.fvgMinGapPct ?? DEFAULTS.fvgMinGapPct,
  };
  const obOpts = {
    obLookback: config.mdObLookback ?? config.obLookback ?? DEFAULTS.obLookback,
    obDispMult: config.mdObDispMult ?? config.obDispMult ?? DEFAULTS.obDispMult,
  };

  const fvgs = detectFairValueGaps(highs, lows, closes, lastIdx, fvgOpts);
  const orderBlocks = detectOrderBlocks(opens, highs, lows, closes, volumes, volSMA, lastIdx, obOpts);

  const isLong = signal === "LONG";
  const fvgList = (isLong ? fvgs.bullish : fvgs.bearish).filter((f) => !f.filled);
  const obList = isLong ? orderBlocks.bullish : orderBlocks.bearish;

  const radius = atr != null && Number.isFinite(atr) && atr > 0 ? atr * atrMult : null;

  let nearestFvg = null;
  let nearestFvgDist = Infinity;
  for (const f of fvgList) {
    const d = _zoneDistance(price, f.bottom, f.top);
    if (d < nearestFvgDist) {
      nearestFvgDist = d;
      nearestFvg = f;
    }
  }

  let nearestOb = null;
  let nearestObDist = Infinity;
  for (const ob of obList) {
    const d = _zoneDistance(price, ob.low, ob.high);
    if (d < nearestObDist) {
      nearestObDist = d;
      nearestOb = ob;
    }
  }

  // No ATR / no structure nearby → fail-open at reduced confidence
  if (radius == null) {
    return {
      hasConfluence: false,
      confidenceMult: noConfMult,
      reason: "ATR unavailable — OB/FVG confluence skipped (reduced confidence)",
      nearestOb,
      nearestFvg,
      fvgs,
      orderBlocks,
    };
  }

  const fvgOk = nearestFvg != null && nearestFvgDist <= radius;
  const obOk = nearestOb != null && nearestObDist <= radius;

  if (fvgOk || obOk) {
    const parts = [];
    if (obOk) parts.push(`OB@${nearestOb.idx}`);
    if (fvgOk) parts.push(`FVG@${nearestFvg.idx}`);
    return {
      hasConfluence: true,
      confidenceMult: boostMult,
      reason: `Price overlaps ${parts.join("+")} within ${atrMult}×ATR`,
      nearestOb: obOk ? nearestOb : null,
      nearestFvg: fvgOk ? nearestFvg : null,
      fvgs,
      orderBlocks,
    };
  }

  return {
    hasConfluence: false,
    confidenceMult: noConfMult,
    reason: `No OB/FVG within ${atrMult}×ATR of entry — original signal kept at reduced confidence`,
    nearestOb,
    nearestFvg,
    fvgs,
    orderBlocks,
  };
}

/**
 * TP toward nearest unfilled FVG in trade direction; else BB middle; else null
 * (caller keeps RR-based TP).
 *
 * @returns {{ takeProfit: number|null, source: 'fvg'|'bb_middle'|null, fvg: object|null }}
 */
function resolveMdTakeProfit({ signal, entryPrice, fvgs, bbMiddle } = {}) {
  const isLong = signal === "LONG";
  const list = (isLong ? fvgs?.bullish : fvgs?.bearish) || [];
  const unfilled = list.filter((f) => !f.filled);

  // Prefer FVG whose midpoint is in profit direction from entry
  let best = null;
  let bestDist = Infinity;
  for (const f of unfilled) {
    const target = f.midpoint;
    if (isLong && target <= entryPrice) continue;
    if (!isLong && target >= entryPrice) continue;
    const d = Math.abs(target - entryPrice);
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }

  if (best) {
    return { takeProfit: best.midpoint, source: "fvg", fvg: best };
  }

  if (bbMiddle != null && Number.isFinite(bbMiddle)) {
    const ok = isLong ? bbMiddle > entryPrice : bbMiddle < entryPrice;
    if (ok) {
      return { takeProfit: bbMiddle, source: "bb_middle", fvg: null };
    }
  }

  return { takeProfit: null, source: null, fvg: null };
}

module.exports = {
  DEFAULTS,
  detectFairValueGaps,
  detectOrderBlocks,
  refineMdEntry,
  resolveMdTakeProfit,
};
