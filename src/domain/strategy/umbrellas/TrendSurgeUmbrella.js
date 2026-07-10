/**
 * TrendSurgeUmbrella.js — FORGE Tier umbrella strategy
 *
 * Umbrella key : TS_TF
 * Components   : TS_TF (A) · TS_MS (B) · TS_VP (C)
 *
 * Layering (TS-SUB-03) — NOT AF-style 2/3 voting:
 *   A) Trend Following momentum trigger (required)
 *   B) Dow Theory HH/HL gate (required when enabled)
 *   C) Auction Market Theory / VWAP Value Area precision (refines timing when enabled)
 */

const UmbrellaStrategy         = require("../base/UmbrellaStrategy");
const TrendFollowingStrategy   = require("../implementations/TrendFollowingStrategy");
const MarketStructureStrategy  = require("../implementations/MarketStructureStrategy");
const VolumeProfileStrategy    = require("../implementations/VolumeProfileStrategy");

class TrendSurgeUmbrella extends UmbrellaStrategy {
  constructor() {
    super({
      name:        "TS_TF",
      label:       "Trend Surge",
      description:
        "Trend Following with Dow Theory gate + Auction Market Theory (VWAP/Value Area) entry precision.",
      version:     "2.0.0",
      enabled:     true,
      votingThreshold: 0.65,
    });

    this._tf = new TrendFollowingStrategy();
    this._ms = new MarketStructureStrategy();
    this._vp = new VolumeProfileStrategy();

    this.addComponent("TS_TF", this._tf);
    this.addComponent("TS_MS", this._ms);
    this.addComponent("TS_VP", this._vp);

    this._lastLayerMeta = null;
  }

  /**
   * A → B gate → C precision. Disable layers via config flags for rollback/A-B.
   */
  detectSignal(indicators, lastIdx, config = {}) {
    const useStructureGate = config.tsUseStructureGate !== false;
    const useVwapPrecision = config.tsUseVwapPrecision !== false;

    const trigger = this._tf.detectSignal(indicators, lastIdx, config);
    if (!trigger) {
      this._lastLayerMeta = {
        trigger: null,
        structure: null,
        precision: null,
        reason: "no_tf_trigger",
      };
      return null;
    }

    let structure = null;
    if (useStructureGate) {
      structure = this._ms.evaluateGate(indicators, lastIdx, trigger, config);
      if (!structure.allowed) {
        this._lastLayerMeta = {
          trigger,
          structure,
          precision: null,
          reason: structure.reason || "structure_gate_blocked",
        };
        return null;
      }
    }

    let precision = null;
    if (useVwapPrecision) {
      precision = this._vp.evaluatePrecision(indicators, lastIdx, trigger, config);
      if (!precision.allowed) {
        this._lastLayerMeta = {
          trigger,
          structure,
          precision,
          reason: precision.reason || "vwap_precision_blocked",
        };
        return null;
      }
    }

    this._lastLayerMeta = {
      trigger,
      structure,
      precision,
      reason: "ts_layers_passed",
      signalComponents: {
        TS_TF: trigger,
        TS_MS: structure?.vote || (useStructureGate ? "NEUTRAL" : "DISABLED"),
        TS_VP: precision?.vote || (useVwapPrecision ? "NEUTRAL" : "DISABLED"),
      },
    };
    return trigger;
  }

  getLastSignalMeta() {
    const tfMeta = typeof this._tf.getLastSignalMeta === "function"
      ? this._tf.getLastSignalMeta()
      : null;
    return {
      ...(tfMeta || {}),
      tsLayers: this._lastLayerMeta,
      signalComponents: this._lastLayerMeta?.signalComponents || null,
    };
  }

  getLastLayerMeta() {
    return this._lastLayerMeta;
  }

  resetTrendState() {
    if (this._tf && typeof this._tf.resetTrendState === "function") {
      this._tf.resetTrendState();
    }
  }

  calculateRiskConfig(entryPrice, atr, signal, component, opts) {
    if (typeof this._tf.calculateRiskConfig === "function") {
      return this._tf.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    return this._tf.getRiskConfig();
  }
}

module.exports = TrendSurgeUmbrella;
