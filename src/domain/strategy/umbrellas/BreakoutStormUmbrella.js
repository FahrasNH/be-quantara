/**
 * BreakoutStormUmbrella.js — VAULT Tier umbrella strategy
 *
 * Umbrella key : BS_BR (tier access bag — not a fusion mechanism)
 * Components   : BS_BR (Breakout Retest) · BS_ICT (ICT-style) · BS_LS (Liquidation/Squeeze)
 *
 * Sprint 11: race-to-confirm among independent racers.
 * Rollback: set `bsCombinationMode: "single"` to run BS_BR only.
 */

const UmbrellaStrategy = require("../base/UmbrellaStrategy");
const BreakoutTradingStrategy = require("../implementations/BreakoutTradingStrategy");
const IctStyleStrategy = require("../implementations/IctStyleStrategy");
const LiquidationSqueezeStrategy = require("../implementations/LiquidationSqueezeStrategy");

const RACER_PRIORITY = ["BS_BR", "BS_ICT", "BS_LS"];
const RACER_LABELS = {
  BS_BR: "Breakout Retest",
  BS_ICT: "ICT-style trading",
  BS_LS: "Liquidation/Squeeze Trading",
};

class BreakoutStormUmbrella extends UmbrellaStrategy {
  constructor() {
    super({
      name: "BS_BR",
      label: "Breakout Storm",
      description:
        "VAULT umbrella (tier access): Breakout Retest, ICT-style trading, and Liquidation/Squeeze race independently — highest confirmation wins.",
      version: "3.0.0",
      enabled: true,
      votingThreshold: 0.70,
    });

    this._br = new BreakoutTradingStrategy();
    this._ict = new IctStyleStrategy();
    this._ls = new LiquidationSqueezeStrategy();

    this.addComponent("BS_BR", this._br);
    this.addComponent("BS_ICT", this._ict);
    this.addComponent("BS_LS", this._ls);

    this._lastLayerMeta = null;
    this._lastRaceMeta = null;
  }

  _resolveActiveRacers(config = {}) {
    const raw = config.bsActiveRacers || config.selectedComponents || config.activeStrategyComponents || null;
    if (!Array.isArray(raw) || raw.length === 0) {
      return new Set(RACER_PRIORITY);
    }
    const active = new Set();
    for (const c of raw) {
      const k = String(c || "").toUpperCase();
      if (k === "BS_BR" || k === "BREAKOUT_RETEST" || k === "BREAKOUT_TRADING" || k === "BR") {
        active.add("BS_BR");
      } else if (k === "BS_ICT" || k === "ICT" || k === "ICT_STYLE") {
        active.add("BS_ICT");
      } else if (k === "BS_LS" || k === "LIQUIDATION_SQUEEZE" || k === "LIQUIDATION") {
        active.add("BS_LS");
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
      BS_BR: this._br,
      BS_ICT: this._ict,
      BS_LS: this._ls,
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
        BS_BR: evaluations.BS_BR?.signal || (active.has("BS_BR") ? "NEUTRAL" : "DISABLED"),
        BS_ICT: evaluations.BS_ICT?.signal || (active.has("BS_ICT") ? "NEUTRAL" : "DISABLED"),
        BS_LS: evaluations.BS_LS?.signal || (active.has("BS_LS") ? "NEUTRAL" : "DISABLED"),
      },
    };
    this._lastLayerMeta = this._lastRaceMeta;
    return winner.signal;
  }

  _detectSingle(indicators, lastIdx, config = {}) {
    const signal = this._br.detectSignal(indicators, lastIdx, config);
    const meta = this._br.getLastSignalMeta?.() || null;
    this._lastRaceMeta = {
      mode: "single",
      winningComponent: signal ? "BS_BR" : null,
      strategyLabel: RACER_LABELS.BS_BR,
      reason: signal ? (meta?.reason || "bs_br_single") : "no_br_signal",
      brMeta: meta,
    };
    this._lastLayerMeta = this._lastRaceMeta;
    return signal;
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const mode = String(config.bsCombinationMode || "race").toLowerCase();
    if (mode === "single" || mode === "pipeline" || mode === "layering") {
      return this._detectSingle(indicators, lastIdx, config);
    }
    return this._detectRace(indicators, lastIdx, config);
  }

  getLastSignalMeta() {
    const winnerKey = this._lastRaceMeta?.winningComponent;
    let baseMeta = null;
    if (winnerKey === "BS_ICT" && typeof this._ict.getLastSignalMeta === "function") {
      baseMeta = this._ict.getLastSignalMeta();
    } else if (winnerKey === "BS_LS" && typeof this._ls.getLastSignalMeta === "function") {
      baseMeta = this._ls.getLastSignalMeta();
    } else if (typeof this._br.getLastSignalMeta === "function") {
      baseMeta = this._br.getLastSignalMeta();
    }

    const label = this._lastRaceMeta?.strategyLabel
      || (winnerKey ? RACER_LABELS[winnerKey] : null);

    return {
      ...(baseMeta || {}),
      component: winnerKey || baseMeta?.component || "BS_BR",
      winningComponent: winnerKey || null,
      strategyLabel: label,
      bsRace: this._lastRaceMeta,
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
    if (winner === "BS_ICT" && typeof this._ict.calculateRiskConfig === "function") {
      return this._ict.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    if (winner === "BS_LS" && typeof this._ls.calculateRiskConfig === "function") {
      return this._ls.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    if (typeof this._br.calculateRiskConfig === "function") {
      return this._br.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    return this._br.getRiskConfig();
  }
}

module.exports = BreakoutStormUmbrella;
