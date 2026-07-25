/**
 * VSA Intraday Entry Redesign v2 — Sprint 23.
 *
 * Modes (vsaIntradayDetectorMode):
 *   legacy         — 1-bar pattern at lastIdx (pre-v2)
 *   confirmation   — pattern bar + next-bar VSA test (default v2)
 *   htf_proximity  — pattern must sit near HTF swing (1h), not 15m noise
 *   sequence       — Wyckoff climax → test within N bars
 *   hvsa           — trend-aligned EMA-body momentum (philosophical comparator)
 */

"use strict";

const {
  relativeVolume,
  calculateCLV,
  averageSpreadAt,
  classifySpread,
  checkSwingProximity,
  smaAt,
} = require("./volumeAnalysisUtils");
const VSA_DEFAULTS = Object.freeze({
  minBars: 20,
  volumeSmaPeriod: 20,
  atrPeriod: 14,
  wideSpreadMult: 1.3,
  narrowSpreadMult: 0.7,
  lowRelVol: 0.7,
  highRelVol: 1.5,
  mismatchSpreadMult: 0.5,
  swingRadius: 5,
  swingLeftLook: 5,
  swingScanBars: 50,
  mismatchConfidencePenalty: 0.25,
});

function detectVSAPatternLocal({ candle, relVol, spreadType, clv, swingType, config = {} }) {
  const { detectVSAPattern } = require("./vsaEntry");
  return detectVSAPattern({ candle, relVol, spreadType, clv, swingType, config });
}

const VALID_MODES = new Set([
  "legacy",
  "confirmation",
  "htf_proximity",
  "sequence",
  "hvsa",
]);

function resolveIntradayDetectorMode(config = {}) {
  const ov = config.typeOverrides?.Intraday || {};
  const mode = config.vsaIntradayDetectorMode ?? ov.vsaIntradayDetectorMode ?? "confirmation";
  return VALID_MODES.has(mode) ? mode : "confirmation";
}

function resolveIntradayDetectorFlags(config = {}) {
  const ov = config.typeOverrides?.Intraday || {};
  return {
    mode: resolveIntradayDetectorMode(config),
    sequenceLookback: config.vsaSequenceLookback ?? ov.vsaSequenceLookback ?? 8,
    htfSwingRadius: config.vsaHtfSwingRadius ?? ov.vsaHtfSwingRadius ?? 3,
    hvsaEmaPeriod: config.vsaHvsaEmaPeriod ?? ov.vsaHvsaEmaPeriod ?? 10,
    hvsaVdmaPeriod: config.vsaHvsaVdmaPeriod ?? ov.vsaHvsaVdmaPeriod ?? 20,
  };
}

function candleSlice(candles, idx) {
  return {
    open: candles.opens?.[idx] ?? candles.closes[idx - 1] ?? candles.closes[idx],
    high: candles.highs[idx],
    low: candles.lows[idx],
    close: candles.closes[idx],
    volume: candles.volumes?.[idx],
  };
}

function buildPatternContext(candles, idx, cfg) {
  const vol = candles.volumes?.[idx];
  if (vol == null || vol === 0) return null;

  const relVol = relativeVolume(candles.volumes, idx, cfg.volumeSmaPeriod);
  if (relVol == null) return null;

  const atr = candles.atr?.[idx];
  if (atr == null || atr <= 0) return null;

  const high = candles.highs[idx];
  const low = candles.lows[idx];
  const close = candles.closes[idx];
  const open = candles.opens?.[idx] ?? candles.closes[idx - 1] ?? close;
  const avgSpread = averageSpreadAt(
    candles.highs,
    candles.lows,
    idx,
    cfg.atrPeriod ?? 14,
  );
  const nearSwing = checkSwingProximity(
    candles.highs,
    candles.lows,
    idx,
    cfg.swingRadius,
    cfg.swingLeftLook,
    cfg.swingScanBars,
  );
  if (!nearSwing.isNear) return null;

  const spreadType = classifySpread(
    high,
    low,
    atr,
    cfg.wideSpreadMult,
    cfg.narrowSpreadMult,
    avgSpread,
  );
  const clv = calculateCLV(high, low, close);
  const signal = detectVSAPatternLocal({
    candle: { open, high, low, close, volume: vol },
    relVol,
    spreadType,
    clv,
    swingType: nearSwing.type,
    config: cfg,
  });
  if (!signal) return null;

  return {
    idx,
    signal,
    relVol,
    clv,
    spreadType,
    nearSwing,
    candle: { open, high, low, close, volume: vol },
    mid: (high + low) / 2,
  };
}

/**
 * Confirmation bar: pattern on prev bar, entry on test bar (lastIdx).
 */
function detectConfirmationBar(candles, lastIdx, cfg, ablation) {
  if (lastIdx < cfg.minBars) {
    if (ablation) ablation.rejConfirmationMinBars = (ablation.rejConfirmationMinBars || 0) + 1;
    return null;
  }
  const pattern = buildPatternContext(candles, lastIdx - 1, cfg);
  if (!pattern) {
    if (ablation) ablation.rejConfirmationNoPattern = (ablation.rejConfirmationNoPattern || 0) + 1;
    return null;
  }

  const confirm = candleSlice(candles, lastIdx);
  const confirmVol = confirm.volume;
  const patternVol = pattern.candle.volume;
  if (confirmVol == null || patternVol == null) {
    if (ablation) ablation.rejConfirmationVolume = (ablation.rejConfirmationVolume || 0) + 1;
    return null;
  }

  const confirmRelVol = relativeVolume(candles.volumes, lastIdx, cfg.volumeSmaPeriod);
  let ok = false;
  if (pattern.signal.vote === "LONG") {
    ok = confirm.close > pattern.mid && confirmRelVol != null && confirmRelVol < pattern.relVol;
  } else if (pattern.signal.vote === "SHORT") {
    ok = confirm.close < pattern.mid && confirmRelVol != null && confirmRelVol < pattern.relVol;
  }
  if (!ok) {
    if (ablation) ablation.rejConfirmationFailed = (ablation.rejConfirmationFailed || 0) + 1;
    return null;
  }

  return {
    vote: pattern.signal.vote,
    confidence: Math.min(1, pattern.signal.confidence * 1.05),
    reason: `${pattern.signal.reason}_confirmed`,
    meta: {
      vsaDetectorMode: "confirmation",
      patternBarIdx: lastIdx - 1,
      confirmBarIdx: lastIdx,
      patternRelVol: pattern.relVol,
      confirmRelVol,
      ...pattern,
    },
  };
}

function htfCandlesFromConfig(config, indicators) {
  const htfIdx = config.htfIdx;
  if (htfIdx == null || htfIdx < 0) return null;
  const highs = indicators?.highsHTF ?? config.htfHighs;
  const lows = indicators?.lowsHTF ?? config.htfLows;
  if (!highs?.length || !lows?.length || htfIdx >= highs.length) return null;
  return { highs, lows, htfIdx };
}

/**
 * HTF proximity: 15m pattern must align with 1h swing structure.
 */
function detectHtfProximity(candles, lastIdx, cfg, config, ablation) {
  const htf = htfCandlesFromConfig(config, config.indicators);
  if (!htf) {
    if (ablation) ablation.rejHtfProximityNoHtf = (ablation.rejHtfProximityNoHtf || 0) + 1;
    return null;
  }

  const flags = resolveIntradayDetectorFlags(config);
  const nearHtf = checkSwingProximity(
    htf.highs,
    htf.lows,
    htf.htfIdx,
    flags.htfSwingRadius,
    cfg.swingLeftLook,
    cfg.swingScanBars,
  );
  if (!nearHtf.isNear) {
    if (ablation) ablation.rejHtfProximity = (ablation.rejHtfProximity || 0) + 1;
    return null;
  }

  const ctx = buildPatternContext(candles, lastIdx, cfg);
  if (!ctx) return null;

  const aligned =
    (ctx.signal.vote === "LONG" && nearHtf.type === "low")
    || (ctx.signal.vote === "SHORT" && nearHtf.type === "high");
  if (!aligned) {
    if (ablation) ablation.rejHtfProximityMisalign = (ablation.rejHtfProximityMisalign || 0) + 1;
    return null;
  }

  return {
    vote: ctx.signal.vote,
    confidence: ctx.signal.confidence,
    reason: `${ctx.signal.reason}_htf_level`,
    meta: {
      vsaDetectorMode: "htf_proximity",
      nearHtf,
      ...ctx,
    },
  };
}

function isStoppingReason(reason) {
  return String(reason || "").includes("stopping_volume");
}

function isTestReason(reason, vote) {
  const r = String(reason || "");
  if (vote === "LONG") return r.includes("no_supply");
  if (vote === "SHORT") return r.includes("no_demand");
  return false;
}

/**
 * Wyckoff sequence: stopping volume climax then test bar within lookback.
 */
function detectSequencePattern(candles, lastIdx, cfg, config, ablation) {
  const flags = resolveIntradayDetectorFlags(config);
  const lookback = flags.sequenceLookback;
  if (lastIdx < cfg.minBars + 1) return null;

  const testCtx = buildPatternContext(candles, lastIdx, cfg);
  if (!testCtx || !isTestReason(testCtx.signal.reason, testCtx.signal.vote)) {
    if (ablation) ablation.rejSequenceNoTest = (ablation.rejSequenceNoTest || 0) + 1;
    return null;
  }

  for (let i = lastIdx - 1; i >= Math.max(cfg.minBars - 1, lastIdx - lookback); i--) {
    const climax = buildPatternContext(candles, i, cfg);
    if (!climax || !isStoppingReason(climax.signal.reason)) continue;
    if (climax.signal.vote !== testCtx.signal.vote) continue;
    return {
      vote: testCtx.signal.vote,
      confidence: Math.min(1, (climax.signal.confidence + testCtx.signal.confidence) / 2 + 0.1),
      reason: `${testCtx.signal.reason}_after_climax`,
      meta: {
        vsaDetectorMode: "sequence",
        climaxBarIdx: i,
        testBarIdx: lastIdx,
        climax,
        test: testCtx,
      },
    };
  }

  if (ablation) ablation.rejSequenceNoClimax = (ablation.rejSequenceNoClimax || 0) + 1;
  return null;
}

function emaSeries(values, period, lastIdx) {
  if (!values || lastIdx < period - 1) return null;
  const k = 2 / (period + 1);
  let ema = smaAt(values, period - 1, period);
  if (ema == null) return null;
  for (let i = period; i <= lastIdx; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) return null;
    ema = v * k + ema * (1 - k);
  }
  return ema;
}

function emaBodySeries(opens, closes, period, lastIdx) {
  if (!closes || lastIdx < period) return { curr: null, prev: null };
  const bodies = [];
  for (let i = 0; i <= lastIdx; i++) {
    const o = opens?.[i] ?? closes[i - 1] ?? closes[i];
    bodies.push((closes[i] ?? 0) - (o ?? 0));
  }
  const curr = emaSeries(bodies, period, lastIdx);
  const prev = lastIdx > period ? emaSeries(bodies, period, lastIdx - 1) : null;
  return { curr, prev };
}

/**
 * HVSA momentum comparator — EMA-body crossover (volume ratio is magnitude-only).
 */
function detectHvsaMomentum(candles, lastIdx, cfg, config, ablation) {
  const flags = resolveIntradayDetectorFlags(config);
  if (lastIdx < flags.hvsaVdmaPeriod + 2) {
    if (ablation) ablation.rejHvsaWarmup = (ablation.rejHvsaWarmup || 0) + 1;
    return null;
  }

  const vdSeries = [];
  for (let i = 1; i <= lastIdx; i++) {
    const vol = candles.volumes[i];
    const prevVol = candles.volumes[i - 1];
    const o = candles.opens?.[i] ?? candles.closes[i - 1];
    const body = candles.closes[i] - o;
    if (!vol || !prevVol) {
      vdSeries.push(0);
      continue;
    }
    vdSeries.push((vol / prevVol) * body);
  }

  const vdNow = vdSeries[lastIdx - 1];
  const vdPrev = vdSeries[lastIdx - 2];
  if (vdNow == null || vdPrev == null) return null;

  const vdmaNow = emaSeries(vdSeries, flags.hvsaVdmaPeriod, lastIdx - 1);
  const vdmaPrev = emaSeries(vdSeries, flags.hvsaVdmaPeriod, lastIdx - 2);
  if (vdmaNow == null || vdmaPrev == null) return null;

  const crossUp = vdPrev <= 0 && vdNow > 0 && vdmaPrev <= 0 && vdmaNow > 0;
  const crossDown = vdPrev >= 0 && vdNow < 0 && vdmaPrev >= 0 && vdmaNow < 0;
  if (!crossUp && !crossDown) {
    if (ablation) ablation.rejHvsaNoCross = (ablation.rejHvsaNoCross || 0) + 1;
    return null;
  }

  return {
    vote: crossUp ? "LONG" : "SHORT",
    confidence: 0.65,
    reason: crossUp ? "vsa_hvsa_momentum_long" : "vsa_hvsa_momentum_short",
    meta: {
      vsaDetectorMode: "hvsa",
      vd: vdNow,
      vdma: vdmaNow,
    },
  };
}

/**
 * Route Intraday detection to v2 mode or legacy 1-bar path.
 * @returns {object|null} signal { vote, confidence, reason, meta? }
 */
function detectIntradayVsaSignal(candles, lastIdx, cfg, config = {}) {
  const ablation = config.ablation;
  const flags = resolveIntradayDetectorFlags(config);
  const mode = flags.mode;

  if (mode === "legacy") return null;

  if (mode === "confirmation") {
    return detectConfirmationBar(candles, lastIdx, cfg, ablation);
  }
  if (mode === "htf_proximity") {
    return detectHtfProximity(candles, lastIdx, cfg, { ...config, indicators: config.indicators }, ablation);
  }
  if (mode === "sequence") {
    return detectSequencePattern(candles, lastIdx, cfg, config, ablation);
  }
  if (mode === "hvsa") {
    return detectHvsaMomentum(candles, lastIdx, cfg, config, ablation);
  }
  return null;
}

module.exports = {
  VALID_MODES,
  resolveIntradayDetectorMode,
  resolveIntradayDetectorFlags,
  detectIntradayVsaSignal,
  detectConfirmationBar,
  detectHtfProximity,
  detectSequencePattern,
  detectHvsaMomentum,
};
