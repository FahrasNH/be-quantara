/**
 * TrendSurgeUmbrella.js — FORGE Tier umbrella strategy
 *
 * Umbrella key : TREND_FOLLOWING (tier access bag — not a fusion mechanism)
 * Components   : TREND_FOLLOWING (Trend Following) · MARKET_STRUCTURE (Dow Theory) · AUCTION_MARKET_THEORY (Auction Market Theory)
 *
 * Sprint 12 ARCHITECTURE DECISION (Fahras, 10 Jul 2026):
 *   Race-to-Confirm — each unlocked component is an independent signal generator.
 *   On the same bar, the highest-confidence confirmation wins; ties break by
 *   priority TREND_FOLLOWING → MARKET_STRUCTURE → AUCTION_MARKET_THEORY. Trade attribution = winning component only
 *   (never "A + B + C" joined labels).
 *
 * Rollback: set `tsCombinationMode: "gate"` to restore Sprint 9 A→B→C layering.
 */

const UmbrellaStrategy         = require("../base/UmbrellaStrategy");
const TrendFollowingStrategy   = require("../implementations/TrendFollowingStrategy");
const MarketStructureStrategy  = require("../implementations/MarketStructureStrategy");
const VolumeProfileStrategy    = require("../implementations/VolumeProfileStrategy");
const { normalizeStrategyKey } = require("../../../config/strategyKeyNormalizer");
const { enrichMetaWithGradedScore } = require("../scoring/ComponentScoringEngine");

/** Race winner selection uses raw component confidence (0–1), not gradedScore. */
function raceConfidenceFromMeta(meta, signal) {
  let confidence = meta?.confidence ?? (signal ? 0.7 : 0);
  if (confidence > 1) confidence = confidence / 100;
  return confidence;
}

const RACER_PRIORITY = ["TREND_FOLLOWING", "MARKET_STRUCTURE", "AUCTION_MARKET_THEORY"];
const RACER_LABELS = {
  TREND_FOLLOWING: "Trend Following",
  MARKET_STRUCTURE: "Dow Theory",
  AUCTION_MARKET_THEORY: "Auction Market Theory",
};

class TrendSurgeUmbrella extends UmbrellaStrategy {
  constructor() {
    super({
      name:        "TREND_FOLLOWING",
      label:       "Trend Surge",
      description:
        "FORGE umbrella (tier access): Trend Following, Dow Theory, and Auction Market Theory race independently — first/highest confirmation wins.",
      version:     "3.0.0",
      enabled:     true,
      votingThreshold: 0.65,
    });

    this._tf = new TrendFollowingStrategy();
    this._ms = new MarketStructureStrategy();
    this._vp = new VolumeProfileStrategy();

    this.addComponent("TREND_FOLLOWING", this._tf);
    this.addComponent("MARKET_STRUCTURE", this._ms);
    this.addComponent("AUCTION_MARKET_THEORY", this._vp);

    this._lastLayerMeta = null;
    this._lastRaceMeta = null;
  }

  /**
   * Which TS racers participate. Advance selectedComponents restrict the set;
   * empty/missing → all three (FORGE default).
   */
  _resolveActiveRacers(config = {}) {
    const raw = config.tsActiveRacers || config.selectedComponents || config.activeStrategyComponents || null;
    if (!Array.isArray(raw) || raw.length === 0) {
      return new Set(RACER_PRIORITY);
    }
    const active = new Set();
    for (const c of raw) {
      const k = normalizeStrategyKey(String(c || "").toUpperCase());
      if (k === "TREND_FOLLOWING") active.add("TREND_FOLLOWING");
      else if (k === "MARKET_STRUCTURE" || k === "DOW_THEORY" || k === "MARKET_STRUCTURE") active.add("MARKET_STRUCTURE");
      else if (k === "AUCTION_MARKET_THEORY" || k === "AMT" || k === "AUCTION_MARKET_THEORY" || k === "VOLUME_PROFILE") {
        active.add("AUCTION_MARKET_THEORY");
      }
    }
    if (active.size === 0) return new Set(RACER_PRIORITY);
    return active;
  }

  _pickRaceWinner(candidates) {
    if (!candidates.length) return null;
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i];
      if (c.confidence > best.confidence + 1e-9) {
        best = c;
        continue;
      }
      if (Math.abs(c.confidence - best.confidence) <= 1e-9) {
        const cPri = RACER_PRIORITY.indexOf(c.key);
        const bPri = RACER_PRIORITY.indexOf(best.key);
        if (cPri >= 0 && (bPri < 0 || cPri < bPri)) best = c;
      }
    }
    return best;
  }

  /**
   * Race-to-confirm: evaluate active racers in parallel; winner takes the trade.
   */
  _detectRace(indicators, lastIdx, config = {}) {
    const active = this._resolveActiveRacers(config);
    const candidates = [];
    const evaluations = {};

    if (active.has("TREND_FOLLOWING")) {
      let signal = null;
      let confidence = 0;
      let reason = "tf_no_signal";
      try {
        signal = this._tf.detectSignal(indicators, lastIdx, config);
        const rawMeta = typeof this._tf.getLastSignalMeta === "function"
          ? this._tf.getLastSignalMeta()
          : null;
        const meta = rawMeta
          ? enrichMetaWithGradedScore(
            { ...rawMeta, winningComponent: "TREND_FOLLOWING", signal },
            "TREND_FOLLOWING",
          )
          : null;
        confidence = raceConfidenceFromMeta(meta, signal);
        reason = signal ? (meta?.reason || "tf_trigger") : "tf_no_signal";
      } catch (err) {
        reason = `tf_error:${err.message}`;
      }
      evaluations.TREND_FOLLOWING = { signal, confidence, reason };
      if (signal === "LONG" || signal === "SHORT") {
        candidates.push({
          key: "TREND_FOLLOWING",
          label: RACER_LABELS.TREND_FOLLOWING,
          signal,
          confidence,
          reason,
        });
      }
    }

    if (active.has("MARKET_STRUCTURE")) {
      let signal = null;
      let confidence = 0;
      let reason = "ms_no_signal";
      try {
        signal = this._ms.detectSignal(indicators, lastIdx, config);
        const rawMeta = this._ms.getLastSignalMeta() || {};
        const meta = enrichMetaWithGradedScore(
          { ...rawMeta, winningComponent: "MARKET_STRUCTURE", signal },
          "MARKET_STRUCTURE",
        );
        confidence = raceConfidenceFromMeta(meta, signal);
        reason = meta.reason || (signal ? "dow_entry" : "ms_no_signal");
      } catch (err) {
        reason = `ms_error:${err.message}`;
      }
      evaluations.MARKET_STRUCTURE = { signal, confidence, reason };
      if (signal === "LONG" || signal === "SHORT") {
        candidates.push({
          key: "MARKET_STRUCTURE",
          label: RACER_LABELS.MARKET_STRUCTURE,
          signal,
          confidence,
          reason,
        });
      }
    }

    if (active.has("AUCTION_MARKET_THEORY")) {
      let signal = null;
      let confidence = 0;
      let reason = "vp_no_signal";
      try {
        signal = this._vp.detectSignal(indicators, lastIdx, config);
        const rawMeta = this._vp.getLastSignalMeta() || {};
        const meta = enrichMetaWithGradedScore(
          { ...rawMeta, winningComponent: "AUCTION_MARKET_THEORY", signal, price: indicators.closes?.[lastIdx] },
          "AUCTION_MARKET_THEORY",
        );
        confidence = raceConfidenceFromMeta(meta, signal);
        reason = meta.reason || (signal ? "amt_entry" : "vp_no_signal");
      } catch (err) {
        reason = `vp_error:${err.message}`;
      }
      evaluations.AUCTION_MARKET_THEORY = { signal, confidence, reason };
      if (signal === "LONG" || signal === "SHORT") {
        candidates.push({
          key: "AUCTION_MARKET_THEORY",
          label: RACER_LABELS.AUCTION_MARKET_THEORY,
          signal,
          confidence,
          reason,
        });
      }
    }

    const winner = this._pickRaceWinner(candidates);
    if (!winner) {
      this._lastRaceMeta = {
        mode: "race",
        winner: null,
        candidates,
        evaluations,
        activeRacers: [...active],
        reason: "no_racer_confirmed",
      };
      this._lastLayerMeta = this._lastRaceMeta;
      return null;
    }

    this._lastRaceMeta = {
      mode: "race",
      winner,
      candidates,
      evaluations,
      activeRacers: [...active],
      reason: `race_won_by_${winner.key}`,
      winningComponent: winner.key,
      strategyLabel: winner.label,
      signalComponents: {
        TREND_FOLLOWING: evaluations.TREND_FOLLOWING?.signal || (active.has("TREND_FOLLOWING") ? "NEUTRAL" : "DISABLED"),
        MARKET_STRUCTURE: evaluations.MARKET_STRUCTURE?.signal || (active.has("MARKET_STRUCTURE") ? "NEUTRAL" : "DISABLED"),
        AUCTION_MARKET_THEORY: evaluations.AUCTION_MARKET_THEORY?.signal || (active.has("AUCTION_MARKET_THEORY") ? "NEUTRAL" : "DISABLED"),
      },
    };
    this._lastLayerMeta = this._lastRaceMeta;
    return winner.signal;
  }

  /**
   * Legacy Sprint 9 gate/layering (A required → B gate → C precision).
   * Opt-in via tsCombinationMode:"gate".
   */
  _detectGateLayering(indicators, lastIdx, config = {}) {
    const useStructureGate = config.tsUseStructureGate !== false;
    const useVwapPrecision = config.tsUseVwapPrecision !== false;

    const trigger = this._tf.detectSignal(indicators, lastIdx, config);
    if (!trigger) {
      this._lastLayerMeta = {
        mode: "gate",
        trigger: null,
        structure: null,
        precision: null,
        reason: "no_tf_trigger",
      };
      this._lastRaceMeta = this._lastLayerMeta;
      return null;
    }

    let structure = null;
    if (useStructureGate) {
      structure = this._ms.evaluateGate(indicators, lastIdx, trigger, config);
      if (!structure.allowed) {
        this._lastLayerMeta = {
          mode: "gate",
          trigger,
          structure,
          precision: null,
          reason: structure.reason || "structure_gate_blocked",
        };
        this._lastRaceMeta = this._lastLayerMeta;
        return null;
      }
    }

    let precision = null;
    if (useVwapPrecision) {
      precision = this._vp.evaluatePrecision(indicators, lastIdx, trigger, config);
      if (!precision.allowed) {
        this._lastLayerMeta = {
          mode: "gate",
          trigger,
          structure,
          precision,
          reason: precision.reason || "vwap_precision_blocked",
        };
        this._lastRaceMeta = this._lastLayerMeta;
        return null;
      }
    }

    this._lastLayerMeta = {
      mode: "gate",
      trigger,
      structure,
      precision,
      reason: "ts_layers_passed",
      winningComponent: "TREND_FOLLOWING",
      strategyLabel: RACER_LABELS.TREND_FOLLOWING,
      signalComponents: {
        TREND_FOLLOWING: trigger,
        MARKET_STRUCTURE: structure?.vote || (useStructureGate ? "NEUTRAL" : "DISABLED"),
        AUCTION_MARKET_THEORY: precision?.vote || (useVwapPrecision ? "NEUTRAL" : "DISABLED"),
      },
    };
    this._lastRaceMeta = this._lastLayerMeta;
    return trigger;
  }

  /**
   * Hybrid: A required; B/C boost confidence (never hard-block).
   * Opt-in via tsCombinationMode:"hybrid".
   */
  _detectHybrid(indicators, lastIdx, config = {}) {
    const trigger = this._tf.detectSignal(indicators, lastIdx, config);
    if (!trigger) {
      this._lastLayerMeta = {
        mode: "hybrid",
        trigger: null,
        reason: "no_tf_trigger",
        winningComponent: null,
      };
      this._lastRaceMeta = this._lastLayerMeta;
      return null;
    }

    let confidence = 0.55;
    let structure = null;
    let precision = null;
    const useStructure = config.tsUseStructureGate !== false;
    const useVwap = config.tsUseVwapPrecision !== false;

    if (useStructure) {
      structure = this._ms.evaluateGate(indicators, lastIdx, trigger, config);
      if (structure.allowed && structure.vote === trigger) confidence += 0.2;
    }
    if (useVwap) {
      precision = this._vp.evaluatePrecision(indicators, lastIdx, trigger, config);
      if (precision.allowed && (precision.vote === trigger || precision.vote === "NEUTRAL")) {
        confidence += 0.15;
      }
    }

    this._lastLayerMeta = {
      mode: "hybrid",
      trigger,
      structure,
      precision,
      confidence: Math.min(1, confidence),
      reason: "hybrid_tf_base",
      winningComponent: "TREND_FOLLOWING",
      strategyLabel: RACER_LABELS.TREND_FOLLOWING,
      signalComponents: {
        TREND_FOLLOWING: trigger,
        MARKET_STRUCTURE: structure?.vote || (useStructure ? "NEUTRAL" : "DISABLED"),
        AUCTION_MARKET_THEORY: precision?.vote || (useVwap ? "NEUTRAL" : "DISABLED"),
      },
    };
    this._lastRaceMeta = this._lastLayerMeta;
    return trigger;
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const mode = String(config.tsCombinationMode || "race").toLowerCase();
    if (mode === "gate" || mode === "layering") {
      return this._detectGateLayering(indicators, lastIdx, config);
    }
    if (mode === "hybrid") {
      return this._detectHybrid(indicators, lastIdx, config);
    }
    return this._detectRace(indicators, lastIdx, config);
  }

  getLastSignalMeta() {
    const winnerKey = this._lastRaceMeta?.winningComponent || this._lastLayerMeta?.winningComponent;
    let baseMeta = null;
    if (winnerKey === "MARKET_STRUCTURE" && typeof this._ms.getLastSignalMeta === "function") {
      baseMeta = this._ms.getLastSignalMeta();
    } else if (winnerKey === "AUCTION_MARKET_THEORY" && typeof this._vp.getLastSignalMeta === "function") {
      baseMeta = this._vp.getLastSignalMeta();
    } else if (typeof this._tf.getLastSignalMeta === "function") {
      baseMeta = this._tf.getLastSignalMeta();
    }

    const label = this._lastRaceMeta?.strategyLabel
      || this._lastLayerMeta?.strategyLabel
      || (winnerKey ? RACER_LABELS[winnerKey] : null);

    return enrichMetaWithGradedScore({
      ...(baseMeta || {}),
      component: winnerKey || baseMeta?.component || "TREND_FOLLOWING",
      winningComponent: winnerKey || null,
      strategyLabel: label,
      tsRace: this._lastRaceMeta,
      tsLayers: this._lastLayerMeta,
      signalComponents: this._lastRaceMeta?.signalComponents
        || this._lastLayerMeta?.signalComponents
        || null,
      componentConfidence: this._lastRaceMeta?.winner?.confidence != null
        ? Math.round(this._lastRaceMeta.winner.confidence * 100)
        : baseMeta?.componentConfidence,
    }, winnerKey || baseMeta?.component || "TREND_FOLLOWING");
  }

  getLastLayerMeta() {
    return this._lastLayerMeta;
  }

  getLastRaceMeta() {
    return this._lastRaceMeta;
  }

  resetTrendState() {
    if (this._tf && typeof this._tf.resetTrendState === "function") {
      this._tf.resetTrendState();
    }
  }

  calculateRiskConfig(entryPrice, atr, signal, component, opts) {
    const winner = this._lastRaceMeta?.winningComponent || component;
    if (winner === "MARKET_STRUCTURE" && typeof this._ms.calculateRiskConfig === "function") {
      return this._ms.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    if (winner === "AUCTION_MARKET_THEORY" && typeof this._vp.calculateRiskConfig === "function") {
      return this._vp.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    if (typeof this._tf.calculateRiskConfig === "function") {
      return this._tf.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    return this._tf.getRiskConfig();
  }
}

module.exports = TrendSurgeUmbrella;
