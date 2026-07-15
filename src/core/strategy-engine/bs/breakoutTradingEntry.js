/**
 * Breakout Trading (BS_BR) — standalone entry for BREAKOUT_STORM.
 *
 * Volatility floor → breakout → displacement → true retest pipeline.
 * Extracted from BreakoutTradingStrategy (Sprint 15 structure refactor).
 */

"use strict";

const RETEST_TOUCH_TOL = 0.003; // 0.3%

const DEFAULTS = {
  lookbackBars: 20,
  volumeMultiplier: 1.5,
  maxVolumeRatio: 3.55,
  retestWindow: 96,
  minRetestBars: 16,
  minRejectionWickRatio: 0.5,
  minRetestDepthAtr: 0.17,
  maxRetestDepthAtr: 0.72,
  minDisplacementAtr: 0.30,
  blockedMarketConds: ["COILED_BREAKOUT", "SQUEEZE_BREAKOUT", "DRY_SQUEEZE"],
  bbPeriod: 20,
  bbStdDev: 2.0,
  squeezeLookback: 10,
  squeezeThreshold: 0.75,
  minBbWidthPct: 0.0076,
  minAtrPct: 0.25,
  requireConsolidation: true,
  preferredTpMode: "full",
};

function freshBreakoutState() {
  return {
    direction: null,
    breakoutLevel: null,
    breakoutBar: null,
    confirmed: false,
    squeezeWidthPct: null,
    avgPriorWidthPct: null,
    breakoutVolumeRatio: null,
    consolidationBars: null,
    breakoutCandleAtr: null,
    maxAwayAtr: 0,
    retestExtreme: null,
    rangeHeight: null,
  };
}

function detectLevels(highs, lows = null, cfg = DEFAULTS) {
  const hi = highs || [];
  const lo = lows || highs || [];
  if (hi.length < cfg.lookbackBars || lo.length < cfg.lookbackBars) return null;

  const hiLB = hi.slice(-cfg.lookbackBars);
  const loLB = lo.slice(-cfg.lookbackBars);
  const resistance = Math.max(...hiLB);
  const support = Math.min(...loLB);
  const midpoint = (resistance + support) / 2;

  return { resistance, support, midpoint, range: resistance - support };
}

function bbWidthPctAt(closes, endIdx, period, bbStdDev, cfg = DEFAULTS) {
  const stdDev = bbStdDev ?? cfg.bbStdDev ?? 2.0;
  if (endIdx + 1 < period) return null;
  const seg = closes.slice(endIdx - period + 1, endIdx + 1);
  const mean = seg.reduce((a, b) => a + b, 0) / period;
  if (mean === 0) return null;
  const variance = seg.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return (2 * stdDev * std) / mean;
}

function checkConsolidation(closes, atr = null, price = null, cfg = DEFAULTS) {
  const period = cfg.bbPeriod;
  const lb = cfg.squeezeLookback;
  if (!closes || closes.length < period + lb) {
    return { squeeze: false, volatilityOk: false, widthPct: null, avgPriorWidthPct: null };
  }

  const n = closes.length;
  const curr = bbWidthPctAt(closes, n - 1, period, cfg.bbStdDev, cfg);
  if (curr == null) {
    return { squeeze: false, volatilityOk: false, widthPct: null, avgPriorWidthPct: null };
  }

  let sum = 0, cnt = 0;
  for (let k = 2; k <= lb + 1; k++) {
    const w = bbWidthPctAt(closes, n - k, period, cfg.bbStdDev, cfg);
    if (w != null) { sum += w; cnt++; }
  }
  const avgPrior = cnt ? sum / cnt : null;

  const squeeze = avgPrior != null
    ? curr <= avgPrior * cfg.squeezeThreshold
    : false;

  const minBb = cfg.minBbWidthPct ?? 0.0076;
  const widthOk = curr >= minBb;

  let atrOk = true;
  if (atr != null && price != null && price > 0) {
    const atrPct = (atr / price) * 100;
    atrOk = atrPct >= (cfg.minAtrPct ?? 0.25);
  }

  return {
    squeeze,
    volatilityOk: widthOk && atrOk,
    widthPct: curr,
    avgPriorWidthPct: avgPrior,
  };
}

function checkLongBreakout(closes, volumes, volSMA, resistance, cfg = DEFAULTS) {
  const closeCurr = closes[closes.length - 1];
  const closePrev = closes[closes.length - 2];
  const volCurr = volumes[volumes.length - 1];
  const volRatio = volSMA > 0 ? volCurr / volSMA : 0;

  const isBreakout = closePrev <= resistance && closeCurr > resistance;
  const hasVolume = volRatio >= cfg.volumeMultiplier;
  const maxVol = cfg.maxVolumeRatio;
  const notExhausted = maxVol == null || volRatio <= maxVol;

  if (isBreakout && hasVolume && notExhausted) {
    return {
      valid: true,
      level: resistance,
      entryZone: [resistance, resistance + (closeCurr - resistance) * 0.5],
      reason: `Bullish breakout above ${resistance.toFixed(2)} with ${volRatio.toFixed(2)}× volume`,
    };
  }

  return { valid: false };
}

function checkShortBreakout(closes, volumes, volSMA, support, cfg = DEFAULTS) {
  const closeCurr = closes[closes.length - 1];
  const closePrev = closes[closes.length - 2];
  const volCurr = volumes[volumes.length - 1];
  const volRatio = volSMA > 0 ? volCurr / volSMA : 0;

  const isBreakout = closePrev >= support && closeCurr < support;
  const hasVolume = volRatio >= cfg.volumeMultiplier;
  const maxVol = cfg.maxVolumeRatio;
  const notExhausted = maxVol == null || volRatio <= maxVol;

  if (isBreakout && hasVolume && notExhausted) {
    return {
      valid: true,
      level: support,
      entryZone: [support, support - (support - closeCurr) * 0.5],
      reason: `Bearish breakout below ${support.toFixed(2)} with ${volRatio.toFixed(2)}× volume`,
    };
  }

  return { valid: false };
}

function checkRetestEntry(closes, direction, breakoutLevel, lows = null, highs = null, opens = null, atr = null, cfg = DEFAULTS) {
  const n = closes.length;
  const closeCurr = closes[n - 1];
  const openCurr = (opens && opens[n - 1] != null) ? opens[n - 1] : closeCurr;
  const lowCurr = (lows && lows[n - 1] != null) ? lows[n - 1] : closeCurr;
  const highCurr = (highs && highs[n - 1] != null) ? highs[n - 1] : closeCurr;
  const tol = RETEST_TOUCH_TOL;
  const range = Math.max(highCurr - lowCurr, 1e-12);
  const minWick = cfg.minRejectionWickRatio ?? 0.5;
  const minDepth = cfg.minRetestDepthAtr ?? 0.17;
  const maxDepth = cfg.maxRetestDepthAtr ?? 0.72;

  if (direction === "LONG") {
    const touchedLevel = lowCurr <= breakoutLevel * (1 + tol);
    const closedAbove = closeCurr > breakoutLevel;
    const lowerWick = Math.min(closeCurr, openCurr) - lowCurr;
    const wickRatio = lowerWick / range;
    const hasRejection = wickRatio >= minWick;
    const retestDepth = Math.max(0, breakoutLevel - lowCurr);
    const depthOk = (atr == null || atr <= 0)
      ? true
      : (retestDepth / atr) >= minDepth && (retestDepth / atr) <= maxDepth;
    if (touchedLevel && closedAbove && hasRejection && depthOk) {
      return {
        valid: true,
        entry: closeCurr,
        rejectionWickPct: wickRatio,
        retestDepth,
        retestExtreme: lowCurr,
        reason: `Retest LONG: low ${lowCurr.toFixed(2)} menyentuh ${breakoutLevel.toFixed(2)}, ` +
          `rejection wick ${(wickRatio * 100).toFixed(0)}%, close ${closeCurr.toFixed(2)}`,
      };
    }
  } else if (direction === "SHORT") {
    const touchedLevel = highCurr >= breakoutLevel * (1 - tol);
    const closedBelow = closeCurr < breakoutLevel;
    const upperWick = highCurr - Math.max(closeCurr, openCurr);
    const wickRatio = upperWick / range;
    const hasRejection = wickRatio >= minWick;
    const retestDepth = Math.max(0, highCurr - breakoutLevel);
    const depthOk = (atr == null || atr <= 0)
      ? true
      : (retestDepth / atr) >= minDepth && (retestDepth / atr) <= maxDepth;
    if (touchedLevel && closedBelow && hasRejection && depthOk) {
      return {
        valid: true,
        entry: closeCurr,
        rejectionWickPct: wickRatio,
        retestDepth,
        retestExtreme: highCurr,
        reason: `Retest SHORT: high ${highCurr.toFixed(2)} menyentuh ${breakoutLevel.toFixed(2)}, ` +
          `rejection wick ${(wickRatio * 100).toFixed(0)}%, close ${closeCurr.toFixed(2)}`,
      };
    }
  }

  return { valid: false };
}

function scoreConfidence({
  squeezeWidthPct,
  avgPriorWidthPct,
  volumeRatio,
  rejectionWickPct,
  barsSinceBreakout,
  retestDepthAtr,
} = {}) {
  let score = 60;
  if (squeezeWidthPct != null) {
    if (squeezeWidthPct >= 0.0103) score += 10;
    else if (squeezeWidthPct >= 0.0076) score += 6;
    else if (squeezeWidthPct >= 0.0057) score += 2;
  }
  if (volumeRatio != null) {
    if (volumeRatio >= 3.0) score += 8;
    else if (volumeRatio >= 2.5) score += 7;
    else if (volumeRatio >= 2.0) score += 6;
    else if (volumeRatio >= 1.7) score += 4;
    else if (volumeRatio >= 1.5) score += 3;
    else if (volumeRatio >= 1.3) score += 1;
  }
  if (rejectionWickPct != null) {
    if (rejectionWickPct >= 0.70) score += 8;
    else if (rejectionWickPct >= 0.60) score += 6;
    else if (rejectionWickPct >= 0.55) score += 4;
    else if (rejectionWickPct >= 0.50) score += 2;
    else if (rejectionWickPct >= 0.40) score += 1;
  }
  if (barsSinceBreakout != null) {
    if (barsSinceBreakout >= 16 && barsSinceBreakout <= 32) score += 6;
    else if (barsSinceBreakout >= 33 && barsSinceBreakout <= 48) score += 5;
    else if (barsSinceBreakout >= 49 && barsSinceBreakout <= 64) score += 3;
    else if (barsSinceBreakout >= 8) score += 2;
  }
  if (retestDepthAtr != null) {
    if (retestDepthAtr >= 0.30 && retestDepthAtr <= 0.55) score += 6;
    else if (retestDepthAtr >= 0.17 && retestDepthAtr <= 0.72) score += 3;
    else if (retestDepthAtr > 0.72) score += 1;
  }
  return Math.max(50, Math.min(95, Math.round(score)));
}

function classifyMarketCond(squeezeWidthPct, avgPriorWidthPct, atrPct) {
  if (squeezeWidthPct != null) {
    if (squeezeWidthPct < 0.0076) return "DRY_SQUEEZE";
    if (avgPriorWidthPct > 0) {
      const ratio = squeezeWidthPct / avgPriorWidthPct;
      if (ratio <= 0.75 && squeezeWidthPct >= 0.0076) return "COILED_BREAKOUT";
      if (ratio > 0.75 && ratio <= 0.90 && squeezeWidthPct >= 0.0076) return "SQUEEZE_BREAKOUT";
    }
    if (squeezeWidthPct >= 0.0103) return "EXPANDED_RANGE";
  }
  if (atrPct != null) {
    if (atrPct < 0.4) return "LOW_VOL";
    if (atrPct > 2.5) return "HIGH_VOL";
  }
  return "NORMAL";
}

function countConsolidationBars(closes, highs, lows, resistance, support) {
  const hi = highs && highs.length ? highs : (closes || []);
  const lo = lows && lows.length ? lows : (closes || []);
  const n = Math.min(hi.length, lo.length);
  if (n < 2 || resistance == null || support == null) return 0;
  const tol = RETEST_TOUCH_TOL;
  const upper = resistance * (1 + tol);
  const lower = support * (1 - tol);
  const maxCount = 50;
  let count = 0;
  for (let i = n - 2; i >= 0 && count < maxCount; i--) {
    if (hi[i] <= upper && lo[i] >= lower) count++;
    else break;
  }
  return count;
}

/**
 * Main BS_BR entry evaluation at lastIdx.
 *
 * @returns {{ signal: 'LONG'|'SHORT'|null, meta: object|null, state: object, resetState: boolean }}
 */
function evaluateBreakoutTradingEntry({
  indicators,
  lastIdx,
  config = {},
  breakoutState = null,
  defaults = {},
} = {}) {
  const cfg = { ...DEFAULTS, ...defaults, ...config };
  const state = breakoutState || freshBreakoutState();

  if (lastIdx < 30) {
    return { signal: null, meta: null, state, resetState: false };
  }

  const WINDOW = Math.max(
    cfg.lookbackBars + 1,
    cfg.bbPeriod + cfg.squeezeLookback + 2,
    cfg.retestWindow + 5,
    40,
  );
  const start = Math.max(0, lastIdx + 1 - WINDOW);
  const closes = (indicators.closes || []).slice(start, lastIdx + 1);
  const volumes = (indicators.volumes || []).slice(start, lastIdx + 1);
  const highs = (indicators.highs || []).slice(start, lastIdx + 1);
  const lows = (indicators.lows || []).slice(start, lastIdx + 1);
  const opens = (indicators.opens || []).slice(start, lastIdx + 1);
  const volSMA = indicators.volSMA?.[lastIdx] || 0;
  const atr = indicators.atr?.[lastIdx];

  if (!atr || closes.length < cfg.lookbackBars) {
    return { signal: null, meta: null, state, resetState: false };
  }

  const highsBefore = (highs.length ? highs : closes).slice(0, -1);
  const lowsBefore = (lows.length ? lows : closes).slice(0, -1);
  const levels = detectLevels(highsBefore, lowsBefore, cfg);
  if (!levels) {
    return { signal: null, meta: null, state, resetState: false };
  }

  const { resistance, support } = levels;

  const priceForAtr = closes[closes.length - 2] || closes[closes.length - 1];
  const consol = checkConsolidation(closes.slice(0, -1), atr, priceForAtr, cfg);
  const consolidationOK = !cfg.requireConsolidation || consol.volatilityOk;

  const volCurr = volumes[volumes.length - 1] || 0;
  const volRatioNow = volSMA > 0 ? volCurr / volSMA : 0;
  const breakoutBarRange = highs.length && lows.length
    ? Math.abs(highs[highs.length - 1] - lows[highs.length - 1])
    : 0;
  const breakoutCandleAtr = atr > 0 ? breakoutBarRange / atr : null;
  const consolidationBars = countConsolidationBars(closes, highs, lows, resistance, support);

  const longBreakout = checkLongBreakout(closes, volumes, volSMA, resistance, cfg);
  if (longBreakout.valid && consolidationOK) {
    state.direction = "LONG";
    state.breakoutLevel = resistance;
    state.breakoutBar = lastIdx;
    state.confirmed = false;
    state.squeezeWidthPct = consol.widthPct;
    state.avgPriorWidthPct = consol.avgPriorWidthPct;
    state.breakoutVolumeRatio = volRatioNow;
    state.consolidationBars = consolidationBars;
    state.breakoutCandleAtr = breakoutCandleAtr;
    state.maxAwayAtr = 0;
    state.retestExtreme = null;
    state.rangeHeight = levels.range;
  }

  const shortBreakout = checkShortBreakout(closes, volumes, volSMA, support, cfg);
  if (shortBreakout.valid && consolidationOK) {
    state.direction = "SHORT";
    state.breakoutLevel = support;
    state.breakoutBar = lastIdx;
    state.confirmed = false;
    state.squeezeWidthPct = consol.widthPct;
    state.avgPriorWidthPct = consol.avgPriorWidthPct;
    state.breakoutVolumeRatio = volRatioNow;
    state.consolidationBars = consolidationBars;
    state.breakoutCandleAtr = breakoutCandleAtr;
    state.maxAwayAtr = 0;
    state.retestExtreme = null;
    state.rangeHeight = levels.range;
  }

  if (state.direction && state.breakoutBar != null && state.breakoutBar < lastIdx) {
    const barsSinceBreakout = lastIdx - state.breakoutBar;
    const minBars = cfg.minRetestBars ?? 16;

    if (barsSinceBreakout > cfg.retestWindow) {
      return { signal: null, meta: null, state: freshBreakoutState(), resetState: true };
    }

    const highCurr = highs.length ? highs[highs.length - 1] : closes[closes.length - 1];
    const lowCurr = lows.length ? lows[lows.length - 1] : closes[closes.length - 1];
    if (atr > 0 && state.breakoutLevel != null) {
      if (state.direction === "LONG") {
        const away = Math.max(0, highCurr - state.breakoutLevel) / atr;
        state.maxAwayAtr = Math.max(state.maxAwayAtr || 0, away);
      } else {
        const away = Math.max(0, state.breakoutLevel - lowCurr) / atr;
        state.maxAwayAtr = Math.max(state.maxAwayAtr || 0, away);
      }
    }

    if (barsSinceBreakout < minBars) {
      return { signal: null, meta: null, state, resetState: false };
    }

    const minAway = cfg.minDisplacementAtr ?? 0.30;
    if ((state.maxAwayAtr || 0) < minAway) {
      return { signal: null, meta: null, state, resetState: false };
    }

    const retestCheck = checkRetestEntry(
      closes,
      state.direction,
      state.breakoutLevel,
      lows,
      highs,
      opens.length ? opens : null,
      atr,
      cfg,
    );

    if (retestCheck.valid) {
      const signal = state.direction;
      const retestDepthAtr = atr > 0 && retestCheck.retestDepth != null
        ? retestCheck.retestDepth / atr
        : null;
      const atrPct = (atr / closes[closes.length - 1]) * 100;
      const confidence = scoreConfidence({
        squeezeWidthPct: state.squeezeWidthPct,
        avgPriorWidthPct: state.avgPriorWidthPct,
        volumeRatio: state.breakoutVolumeRatio,
        rejectionWickPct: retestCheck.rejectionWickPct,
        barsSinceBreakout,
        retestDepthAtr,
      });
      const marketCond = classifyMarketCond(
        state.squeezeWidthPct,
        state.avgPriorWidthPct,
        atrPct,
      );
      if ((cfg.blockedMarketConds || []).includes(marketCond)) {
        return { signal: null, meta: null, state: freshBreakoutState(), resetState: true };
      }

      const rangeHeight = state.rangeHeight || 0;
      const structuralTarget = signal === "LONG"
        ? state.breakoutLevel + rangeHeight
        : state.breakoutLevel - rangeHeight;
      const targetRoom = signal === "LONG"
        ? structuralTarget - retestCheck.entry
        : retestCheck.entry - structuralTarget;
      const slDistExpected = atr * (cfg.slMultiplier ?? 1.7);
      const maxRR = cfg.maxPlannedRR ?? 2.5;
      if (!(rangeHeight > 0) || targetRoom <= 0 || targetRoom > maxRR * slDistExpected) {
        return { signal: null, meta: null, state: freshBreakoutState(), resetState: true };
      }

      const bbSqueezeWidthAtr = atr > 0 && state.squeezeWidthPct != null
        ? (state.squeezeWidthPct * closes[closes.length - 1]) / atr
        : null;

      const meta = {
        component: "BS_BR",
        winningComponent: "BS_BR",
        strategyLabel: "Breakout Trading",
        bbSqueeze: consol.squeeze === true,
        rangeBreakout: true,
        retestConfirmation: true,
        consolidationConfirmed: true,
        breakoutConfirmed: true,
        retestConfirmed: true,
        direction: signal,
        breakoutLevel: state.breakoutLevel,
        squeezeWidthPct: state.squeezeWidthPct,
        avgPriorWidthPct: state.avgPriorWidthPct,
        componentConfidence: confidence,
        confidence: confidence / 100,
        marketCond,
        reason: retestCheck.reason,
        preferredTpMode: cfg.preferredTpMode || "full",
        retestExtreme: retestCheck.retestExtreme ?? null,
        structuralTarget,
        plannedRR: parseFloat((targetRoom / slDistExpected).toFixed(2)),
        bbWidth: state.squeezeWidthPct,
        bbSqueezeWidthAtr,
        breakoutVolumeRatio: state.breakoutVolumeRatio,
        volumeRatio: state.breakoutVolumeRatio,
        retestDepthAtr,
        rejectionWickPct: retestCheck.rejectionWickPct,
        consolidationBars: state.consolidationBars,
        breakoutCandleAtr: state.breakoutCandleAtr,
        barsSinceBreakout,
        maxAwayAtr: state.maxAwayAtr,
      };

      return { signal, meta, state: freshBreakoutState(), resetState: true };
    }
  }

  return { signal: null, meta: null, state, resetState: false };
}

module.exports = {
  DEFAULTS,
  RETEST_TOUCH_TOL,
  freshBreakoutState,
  detectLevels,
  checkConsolidation,
  checkLongBreakout,
  checkShortBreakout,
  checkRetestEntry,
  scoreConfidence,
  classifyMarketCond,
  countConsolidationBars,
  evaluateBreakoutTradingEntry,
};
