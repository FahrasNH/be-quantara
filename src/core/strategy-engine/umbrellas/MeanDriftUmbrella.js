/**
 * MeanDriftUmbrella.js — MINT Tier umbrella strategy
 *
 * Umbrella key : MEAN_REVERSION (tier access bag — not a fusion mechanism)
 * Components   : MEAN_REVERSION (Mean Reversion) · SUPPLY_AND_DEMAND (Supply and Demand) · STATISTICAL_ARBITRAGE (Statistical Arbitrage)
 *
 * Sprint 10: race-to-confirm among independent racers.
 * ADX Trend Strength Filter (MD-SUB-01) remains an overlay inside MEAN_REVERSION — not a racer.
 *
 * Rollback: set `mdCombinationMode: "pipeline"` to run MEAN_REVERSION only (legacy layered).
 */

const UmbrellaStrategy = require("../base/UmbrellaStrategy");
const MeanReversionStrategy = require("../implementations/MeanReversionStrategy");
const { normalizeStrategyKey } = require("../../../config/strategyKeyNormalizer");
const SupplyDemandStrategy = require("../implementations/SupplyDemandStrategy");
const StatisticalArbitrageStrategy = require("../implementations/StatisticalArbitrageStrategy");

const RACER_PRIORITY = ["MEAN_REVERSION", "SUPPLY_AND_DEMAND", "STATISTICAL_ARBITRAGE"];
const RACER_LABELS = {
  MEAN_REVERSION: "Mean Reversion",
  SUPPLY_AND_DEMAND: "Supply and Demand",
  STATISTICAL_ARBITRAGE: "Statistical Arbitrage",
};

class MeanDriftUmbrella extends UmbrellaStrategy {
  constructor() {
    super({
      name: "MEAN_REVERSION",
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

    this.addComponent("MEAN_REVERSION", this._mr);
    this.addComponent("SUPPLY_AND_DEMAND", this._sd);
    this.addComponent("STATISTICAL_ARBITRAGE", this._sa);

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
      if (k === "MEAN_REVERSION") active.add("MEAN_REVERSION");
      else if (k === "SUPPLY_AND_DEMAND" || k === "SUPPLY_AND_DEMAND" || k === "SUPPLY_DEMAND") active.add("SUPPLY_AND_DEMAND");
      else if (k === "STATISTICAL_ARBITRAGE" || k === "STATISTICAL_ARBITRAGE" || k === "STAT_ARB") active.add("STATISTICAL_ARBITRAGE");
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
      MEAN_REVERSION: this._mr,
      SUPPLY_AND_DEMAND: this._sd,
      STATISTICAL_ARBITRAGE: this._sa,
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
        MEAN_REVERSION: evaluations.MEAN_REVERSION?.signal || (active.has("MEAN_REVERSION") ? "NEUTRAL" : "DISABLED"),
        SUPPLY_AND_DEMAND: evaluations.SUPPLY_AND_DEMAND?.signal || (active.has("SUPPLY_AND_DEMAND") ? "NEUTRAL" : "DISABLED"),
        STATISTICAL_ARBITRAGE: evaluations.STATISTICAL_ARBITRAGE?.signal || (active.has("STATISTICAL_ARBITRAGE") ? "NEUTRAL" : "DISABLED"),
      },
    };
    this._lastLayerMeta = this._lastRaceMeta;
    return winner.signal;
  }

  /** Legacy: MEAN_REVERSION layered pipeline only. */
  _detectPipeline(indicators, lastIdx, config = {}) {
    const signal = this._mr.detectSignal(indicators, lastIdx, config);
    const meta = this._mr.getLastSignalMeta();
    this._lastRaceMeta = {
      mode: "pipeline",
      winningComponent: signal ? "MEAN_REVERSION" : null,
      strategyLabel: RACER_LABELS.MEAN_REVERSION,
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
    if (winnerKey === "SUPPLY_AND_DEMAND" && typeof this._sd.getLastSignalMeta === "function") {
      baseMeta = this._sd.getLastSignalMeta();
    } else if (winnerKey === "STATISTICAL_ARBITRAGE" && typeof this._sa.getLastSignalMeta === "function") {
      baseMeta = this._sa.getLastSignalMeta();
    } else if (typeof this._mr.getLastSignalMeta === "function") {
      baseMeta = this._mr.getLastSignalMeta();
    }

    const label = this._lastRaceMeta?.strategyLabel
      || (winnerKey ? RACER_LABELS[winnerKey] : null);

    return {
      ...(baseMeta || {}),
      component: winnerKey || baseMeta?.component || "MEAN_REVERSION",
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
    if (winner === "SUPPLY_AND_DEMAND" && typeof this._sd.calculateRiskConfig === "function") {
      return this._sd.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    if (winner === "STATISTICAL_ARBITRAGE" && typeof this._sa.calculateRiskConfig === "function") {
      return this._sa.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    if (typeof this._mr.calculateRiskConfig === "function") {
      return this._mr.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    return this._mr.getRiskConfig();
  }
}

module.exports = MeanDriftUmbrella;
