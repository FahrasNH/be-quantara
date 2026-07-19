"use strict";

/**
 * MLGateService.js — Sprint 16 Phase 2 / Task 2.1
 *
 * Pre-trade win-probability gate wired to WinPredictor + MLShadowLog feedback loop.
 * Modes (ML_GATE_MODE):
 *   shadow   — log only, never block (default)
 *   active   — skip entry when pWin < threshold
 *   disabled — bypass entirely
 *
 * Cold-start (< ML_COLD_START_TRADES closed trades): regime confidence defaults.
 */

const WinPredictor = require("../domain/WinPredictor");
const FeatureEngineer = require("../domain/FeatureEngineer");
const { classifyHtfTrend } = require("../../analytics/domain/engineTradeMlAdapter");
const { validateEntryContext } = require("../guards/entryContextValidator");
const { logMlGateStartupMode } = require("../guards/mlGateProductionGuard");

const DEFAULT_PWIN_THRESHOLD = parseFloat(process.env.ML_WIN_GATE_THRESHOLD || "0.45");
const COLD_START_TRADE_COUNT = parseInt(process.env.ML_COLD_START_TRADES || "200", 10);
const VALID_MODES = ["shadow", "active", "disabled"];

const REGIME_DEFAULTS = {
  trending_up:   { smcConfidenceGate: 0.65, tfConfidenceGate: 0.55 },
  trending_down: { smcConfidenceGate: 0.65, tfConfidenceGate: 0.55 },
  ranging:       { smcConfidenceGate: 0.75, tfConfidenceGate: 0.70 },
  volatile:      { smcConfidenceGate: 0.70, tfConfidenceGate: 0.65 },
};

const SMC_PATTERN = /SMC|WYCKOFF|VSA|SMART_MONEY|AUCTION|MEAN_REVERSION|SUPPLY|STATISTICAL/i;

function normalizeConfidence(raw) {
  const conf = parseFloat(raw);
  if (!Number.isFinite(conf)) return 50;
  if (conf > 0 && conf <= 10) return conf * 10;
  return Math.max(0, Math.min(100, conf));
}

function resolveRegime(entryContext = {}, regime = null) {
  return regime
    ?? entryContext.regime
    ?? entryContext.htfRegime
    ?? classifyHtfTrend(entryContext.htfAlignment);
}

class MLGateService {
  /**
   * @param {import('../domain/WinPredictor')} winPredictor
   * @param {import('../domain/FeatureEngineer')} featureEngineer
   */
  constructor(winPredictor, featureEngineer) {
    this.winPredictor    = winPredictor;
    this.featureEngineer = featureEngineer;
    this.threshold       = DEFAULT_PWIN_THRESHOLD;
  }

  getMode() {
    const mode = (process.env.ML_GATE_MODE || "shadow").toLowerCase();
    return VALID_MODES.includes(mode) ? mode : "shadow";
  }

  /**
   * Evaluate whether an entry should proceed.
   *
   * @param {object} params
   * @param {object} params.entryContext
   * @param {string} params.strategyKey
   * @param {string} params.symbol
   * @param {string} [params.regime]
   * @param {number} [params.tradeCount] — closed trades for cold-start detection
   * @param {number} [params.signalConfidence] — 0-100
   * @returns {{ allowed: boolean, pWin: number, confidence?: number, reason: string, mode: string, source: string, threshold?: number }}
   */
  evaluateEntry({
    entryContext = {},
    strategyKey,
    symbol,
    regime = null,
    tradeCount = COLD_START_TRADE_COUNT,
    signalConfidence = null,
  }) {
    const mode = this.getMode();
    if (mode === "disabled") {
      return { allowed: true, pWin: 0.5, reason: "ML gate disabled", mode, source: "disabled" };
    }

    const { error: validationError, value: validatedContext } = validateEntryContext(entryContext);
    if (validationError) {
      console.warn(`[MLGateService] Invalid entryContext: ${validationError.message}`);
      return {
        allowed: true,
        pWin: 0.5,
        reason: `[validation-error] ${validationError.message}`,
        mode: mode === "shadow" ? "shadow" : mode,
        source: "validation-failed",
      };
    }

    const resolvedRegime = resolveRegime(validatedContext, regime);
    const closedCount = Number.isFinite(tradeCount) ? tradeCount : COLD_START_TRADE_COUNT;

    if (closedCount < COLD_START_TRADE_COUNT) {
      return this._evaluateColdStart({
        entryContext: validatedContext,
        strategyKey,
        resolvedRegime,
        signalConfidence,
        mode,
        tradeCount: closedCount,
      });
    }

    const features = this.featureEngineer.buildFeatureVector(validatedContext, {
      strategyKey,
      symbol,
      regime: resolvedRegime,
    });

    const { pWin, confidence } = this.winPredictor?.predict(features) ?? { pWin: 0.5, confidence: 0 };
    const threshold = parseFloat(process.env.ML_WIN_GATE_THRESHOLD || String(this.threshold));
    const allowed = pWin >= threshold;
    const reason = allowed
      ? `pWin ${pWin.toFixed(3)} >= ${threshold}`
      : `ML gate: pWin ${pWin.toFixed(3)} < ${threshold}`;

    if (mode === "shadow") {
      return {
        allowed: true,
        pWin,
        confidence,
        reason: `[shadow] ${reason}`,
        mode,
        source: "win_predictor",
        threshold,
      };
    }

    return {
      allowed,
      pWin,
      confidence,
      reason,
      mode,
      source: "win_predictor",
      threshold,
    };
  }

  _evaluateColdStart({ entryContext, strategyKey, resolvedRegime, signalConfidence, mode, tradeCount }) {
    const defaults = REGIME_DEFAULTS[resolvedRegime] || REGIME_DEFAULTS.ranging;
    const normalizedConf = normalizeConfidence(
      signalConfidence ?? entryContext.confidenceScore ?? 50
    );

    const isSMC = SMC_PATTERN.test(String(strategyKey || ""));
    const gate = isSMC ? defaults.smcConfidenceGate : defaults.tfConfidenceGate;
    const gatePct = gate * 100;
    const allowed = normalizedConf >= gatePct;
    const reason = allowed
      ? `Cold-start (${tradeCount}/${COLD_START_TRADE_COUNT}): conf ${normalizedConf.toFixed(0)}% >= ${gatePct.toFixed(0)}%`
      : `Cold-start gate: conf ${normalizedConf.toFixed(0)}% < ${gatePct.toFixed(0)}% (${resolvedRegime})`;

    const pWin = normalizedConf / 100;

    if (mode === "shadow") {
      return {
        allowed: true,
        pWin,
        reason: `[shadow] ${reason}`,
        mode,
        source: "regime_defaults",
        threshold: gate,
      };
    }

    return {
      allowed,
      pWin,
      reason,
      mode,
      source: "regime_defaults",
      threshold: gate,
    };
  }

  /**
   * Lazy singleton factory — safe at server boot.
   * @returns {MLGateService|null}
   */
  static autoStart() {
    try {
      const wp = new WinPredictor();
      wp.load().catch(() => {});
      const fe = new FeatureEngineer();
      const svc = new MLGateService(wp, fe);
      const mode = svc.getMode();
      logMlGateStartupMode(mode);
      console.log("[MLGateService] Auto-started (mode=%s, threshold=%s)", mode, svc.threshold);
      return svc;
    } catch (err) {
      console.warn(`[MLGateService] autoStart failed (non-fatal): ${err.message}`);
      return null;
    }
  }
}

module.exports = MLGateService;
module.exports.REGIME_DEFAULTS = REGIME_DEFAULTS;
