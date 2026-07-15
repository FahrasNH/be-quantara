/**
 * MeanDriftUmbrella.js — MINT Tier umbrella strategy
 *
 * Umbrella key : MD_MR (tier access bag — not a fusion mechanism)
 * Components   : MD_MR (Mean Reversion) · MD_SD (Supply and Demand) · MD_SA (Statistical Arbitrage)
 *
 * Sprint 10: race-to-confirm among independent racers.
 * ADX Trend Strength Filter (MD-SUB-01) remains an overlay inside MD_MR — not a racer.
 *
 * Rollback: set `mdCombinationMode: "pipeline"` to run MD_MR only (legacy layered).
 */

const UmbrellaStrategy = require("../base/UmbrellaStrategy");
const MeanReversionStrategy = require("../implementations/MeanReversionStrategy");
const { normalizeStrategyKey } = require("../../../config/strategyKeyNormalizer");
const SupplyDemandStrategy = require("../implementations/SupplyDemandStrategy");
const StatisticalArbitrageStrategy = require("../implementations/StatisticalArbitrageStrategy");

const RACER_PRIORITY = ["MD_MR", "MD_SD", "MD_SA"];
const RACER_LABELS = {
  MD_MR: "Mean Reversion",
  MD_SD: "Supply and Demand",
  MD_SA: "Statistical Arbitrage",
};

class MeanDriftUmbrella extends UmbrellaStrategy {
  constructor() {
    super({
      name: "MD_MR",
      label: "Mean Drift",
      description:
        "MINT umbrella (tier access): Mean Reversion, Supply and Demand, and Statistical Arbitrage race independently — highest confirmation wins.",
      version: "4.0.0",
      enabled: true,
      votingThreshold: 0.65,
    });

    this._mr = new MeanReversionStrategy();
    this._sd = new SupplyDemandStrategy();
    this._sa = new StatisticalArbitrageStrategy();

    this.addComponent("MD_MR", this._mr);
    this.addComponent("MD_SD", this._sd);
    this.addComponent("MD_SA", this._sa);

    this._lastLayerMeta = null;
    this._lastRaceMeta = null;
  }

  _resolveActiveRacers(config = {}) {
    const raw = config.mdActiveRacers || config.selectedComponents || config.activeStrategyComponents || null;
    if (!Array.isArray(raw) || raw.length === 0) {
      return new Set(RACER_PRIORITY);
    }
    const active = new Set();
    for (const c of raw) {
      const k = normalizeStrategyKey(String(c || "").toUpperCase());
      if (k === "MD_MR") active.add("MD_MR");
      else if (k === "MD_SD" || k === "SUPPLY_AND_DEMAND" || k === "SUPPLY_DEMAND") active.add("MD_SD");
      else if (k === "MD_SA" || k === "STATISTICAL_ARBITRAGE" || k === "STAT_ARB") active.add("MD_SA");
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

  _evalRacer(key, strategy, indicators, lastIdx, config) {
    let signal = null;
    let confidence = 0;
    let reason = `${key.toLowerCase()}_no_signal`;
    try {
      signal = strategy.detectSignal(indicators, lastIdx, config);
      const meta = typeof strategy.getLastSignalMeta === "function"
        ? strategy.getLastSignalMeta()
        : null;
      confidence = meta?.componentConfidence != null
        ? meta.componentConfidence / 100
        : (meta?.confidence ?? (signal ? 0.65 : 0));
      if (confidence > 1) confidence = confidence / 100;
      reason = signal ? (meta?.reason || `${key.toLowerCase()}_trigger`) : reason;
    } catch (err) {
      reason = `${key.toLowerCase()}_error:${err.message}`;
    }
    return { signal, confidence, reason };
  }

  _detectRace(indicators, lastIdx, config = {}) {
    const active = this._resolveActiveRacers(config);
    const candidates = [];
    const evaluations = {};
    const map = {
      MD_MR: this._mr,
      MD_SD: this._sd,
      MD_SA: this._sa,
    };

    for (const key of RACER_PRIORITY) {
      if (!active.has(key)) continue;
      const ev = this._evalRacer(key, map[key], indicators, lastIdx, config);
      evaluations[key] = ev;
      if (ev.signal === "LONG" || ev.signal === "SHORT") {
        candidates.push({
          key,
          label: RACER_LABELS[key],
          signal: ev.signal,
          confidence: ev.confidence,
          reason: ev.reason,
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
        MD_MR: evaluations.MD_MR?.signal || (active.has("MD_MR") ? "NEUTRAL" : "DISABLED"),
        MD_SD: evaluations.MD_SD?.signal || (active.has("MD_SD") ? "NEUTRAL" : "DISABLED"),
        MD_SA: evaluations.MD_SA?.signal || (active.has("MD_SA") ? "NEUTRAL" : "DISABLED"),
      },
    };
    this._lastLayerMeta = this._lastRaceMeta;
    return winner.signal;
  }

  /** Legacy: MD_MR layered pipeline only. */
  _detectPipeline(indicators, lastIdx, config = {}) {
    const signal = this._mr.detectSignal(indicators, lastIdx, config);
    const meta = this._mr.getLastSignalMeta();
    this._lastRaceMeta = {
      mode: "pipeline",
      winningComponent: signal ? "MD_MR" : null,
      strategyLabel: RACER_LABELS.MD_MR,
      reason: signal ? (meta?.reason || "md_mr_pipeline") : "no_mr_signal",
      mrMeta: meta,
    };
    this._lastLayerMeta = this._lastRaceMeta;
    return signal;
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const mode = String(config.mdCombinationMode || "race").toLowerCase();
    if (mode === "pipeline" || mode === "layering" || mode === "gate") {
      return this._detectPipeline(indicators, lastIdx, config);
    }
    return this._detectRace(indicators, lastIdx, config);
  }

  getLastSignalMeta() {
    const winnerKey = this._lastRaceMeta?.winningComponent;
    let baseMeta = null;
    if (winnerKey === "MD_SD" && typeof this._sd.getLastSignalMeta === "function") {
      baseMeta = this._sd.getLastSignalMeta();
    } else if (winnerKey === "MD_SA" && typeof this._sa.getLastSignalMeta === "function") {
      baseMeta = this._sa.getLastSignalMeta();
    } else if (typeof this._mr.getLastSignalMeta === "function") {
      baseMeta = this._mr.getLastSignalMeta();
    }

    const label = this._lastRaceMeta?.strategyLabel
      || (winnerKey ? RACER_LABELS[winnerKey] : null);

    return {
      ...(baseMeta || {}),
      component: winnerKey || baseMeta?.component || "MD_MR",
      winningComponent: winnerKey || null,
      strategyLabel: label,
      mdRace: this._lastRaceMeta,
      mdLayers: this._lastLayerMeta,
      signalComponents: this._lastRaceMeta?.signalComponents || null,
      componentConfidence: this._lastRaceMeta?.winner?.confidence != null
        ? Math.round(this._lastRaceMeta.winner.confidence * 100)
        : baseMeta?.componentConfidence,
    };
  }

  getLastLayerMeta() {
    return this._lastLayerMeta;
  }

  getLastRaceMeta() {
    return this._lastRaceMeta;
  }

  calculateRiskConfig(entryPrice, atr, signal, component, opts) {
    const winner = this._lastRaceMeta?.winningComponent || component;
    if (winner === "MD_SD" && typeof this._sd.calculateRiskConfig === "function") {
      return this._sd.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    if (winner === "MD_SA" && typeof this._sa.calculateRiskConfig === "function") {
      return this._sa.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    if (typeof this._mr.calculateRiskConfig === "function") {
      return this._mr.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    return this._mr.getRiskConfig();
  }
}

module.exports = MeanDriftUmbrella;
