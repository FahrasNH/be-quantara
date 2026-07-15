/**
 * BreakoutStormUmbrella.js — VAULT Tier umbrella strategy
 *
 * Umbrella key : BREAKOUT_RETEST (tier access bag — not a fusion mechanism)
 * Components   : BREAKOUT_RETEST (Breakout Trading) · ICT_STYLE_TRADING (ICT-style) · LIQUIDATION_SQUEEZE (Liquidation/Squeeze)
 *
 * Sprint 11: race-to-confirm among independent racers.
 * Rollback: set `bsCombinationMode: "single"` to run BREAKOUT_RETEST only.
 */

const UmbrellaStrategy = require("../base/UmbrellaStrategy");
const BreakoutTradingStrategy = require("../implementations/BreakoutTradingStrategy");
const IctStyleStrategy = require("../implementations/IctStyleStrategy");
const LiquidationSqueezeStrategy = require("../implementations/LiquidationSqueezeStrategy");
const { BS_BR_HALTED } = require("../../../config/strategies");
const { normalizeStrategyKey } = require("../../../config/strategyKeyNormalizer");

const RACER_PRIORITY = ["BREAKOUT_RETEST", "ICT_STYLE_TRADING", "LIQUIDATION_SQUEEZE"];
const RACER_LABELS = {
  BREAKOUT_RETEST: "Breakout Trading",
  ICT_STYLE_TRADING: "ICT-style trading",
  LIQUIDATION_SQUEEZE: "Liquidation/Squeeze Trading",
};

/** Default race pool — BREAKOUT_RETEST excluded while halted (Sprint 14). */
function defaultActiveRacers(config = {}) {
  const halt = config.bsBrHalted !== false && (BS_BR_HALTED || config.bsBrHalted === true);
  return halt ? new Set(["ICT_STYLE_TRADING", "LIQUIDATION_SQUEEZE"]) : new Set(RACER_PRIORITY);
}

class BreakoutStormUmbrella extends UmbrellaStrategy {
  constructor() {
    super({
      name: "BREAKOUT_RETEST",
      label: "Breakout Storm",
      description:
        "VAULT umbrella (tier access): Breakout Trading, ICT-style trading, and Liquidation/Squeeze race independently — highest confirmation wins.",
      version: "3.0.0",
      enabled: true,
      votingThreshold: 0.70,
    });

    this._br = new BreakoutTradingStrategy();
    this._ict = new IctStyleStrategy();
    this._ls = new LiquidationSqueezeStrategy();

    this.addComponent("BREAKOUT_RETEST", this._br);
    this.addComponent("ICT_STYLE_TRADING", this._ict);
    this.addComponent("LIQUIDATION_SQUEEZE", this._ls);

    this._lastLayerMeta = null;
    this._lastRaceMeta = null;
  }

  _resolveActiveRacers(config = {}) {
    const halt = config.bsBrHalted !== false && (BS_BR_HALTED || config.bsBrHalted === true);
    const raw = config.bsActiveRacers || config.selectedComponents || config.activeStrategyComponents || null;
    if (!Array.isArray(raw) || raw.length === 0) {
      // Default VAULT race: BREAKOUT_RETEST excluded while halted (Sprint 14)
      return defaultActiveRacers(config);
    }
    const active = new Set();
    for (const c of raw) {
      const k = normalizeStrategyKey(String(c || "").toUpperCase());
      if (k === "BREAKOUT_RETEST" || String(c || "").toUpperCase() === "BREAKOUT_TRADING") {
        // Explicit selection (dedicated backtest / override) still allowed —
        // live bots blocked by strategyGuard + getTierStrategies filter.
        active.add("BREAKOUT_RETEST");
      } else if (k === "ICT_STYLE_TRADING" || k === "ICT" || k === "ICT_STYLE") {
        active.add("ICT_STYLE_TRADING");
      } else if (k === "LIQUIDATION_SQUEEZE" || k === "LIQUIDATION_SQUEEZE" || k === "LIQUIDATION") {
        active.add("LIQUIDATION_SQUEEZE");
      }
    }
    // If caller only picked the halted racer under default halt+implicit race,
    // keep it (explicit). Empty after filter → fall back to non-halted default.
    if (active.size === 0) return defaultActiveRacers(config);
    if (halt && active.has("BREAKOUT_RETEST") && active.size > 1) {
      // Multi-racer race pool: drop BREAKOUT_RETEST so ICT/LS compete without the broken leg
      active.delete("BREAKOUT_RETEST");
    }
    if (active.size === 0) return defaultActiveRacers(config);
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
      BREAKOUT_RETEST: this._br,
      ICT_STYLE_TRADING: this._ict,
      LIQUIDATION_SQUEEZE: this._ls,
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
        BREAKOUT_RETEST: evaluations.BREAKOUT_RETEST?.signal || (active.has("BREAKOUT_RETEST") ? "NEUTRAL" : "DISABLED"),
        ICT_STYLE_TRADING: evaluations.ICT_STYLE_TRADING?.signal || (active.has("ICT_STYLE_TRADING") ? "NEUTRAL" : "DISABLED"),
        LIQUIDATION_SQUEEZE: evaluations.LIQUIDATION_SQUEEZE?.signal || (active.has("LIQUIDATION_SQUEEZE") ? "NEUTRAL" : "DISABLED"),
      },
    };
    this._lastLayerMeta = this._lastRaceMeta;
    return winner.signal;
  }

  _detectSingle(indicators, lastIdx, config = {}) {
    // Explicit single-mode always runs BR engine (used by dedicated backtests).
    // Live starts of BREAKOUT_RETEST are blocked by strategyGuard (DRY_RUN_ONLY).
    const signal = this._br.detectSignal(indicators, lastIdx, config);
    const meta = this._br.getLastSignalMeta?.() || null;
    this._lastRaceMeta = {
      mode: "single",
      winningComponent: signal ? "BREAKOUT_RETEST" : null,
      strategyLabel: RACER_LABELS.BREAKOUT_RETEST,
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
    if (winnerKey === "ICT_STYLE_TRADING" && typeof this._ict.getLastSignalMeta === "function") {
      baseMeta = this._ict.getLastSignalMeta();
    } else if (winnerKey === "LIQUIDATION_SQUEEZE" && typeof this._ls.getLastSignalMeta === "function") {
      baseMeta = this._ls.getLastSignalMeta();
    } else if (typeof this._br.getLastSignalMeta === "function") {
      baseMeta = this._br.getLastSignalMeta();
    }

    const label = this._lastRaceMeta?.strategyLabel
      || (winnerKey ? RACER_LABELS[winnerKey] : null);

    return {
      ...(baseMeta || {}),
      component: winnerKey || baseMeta?.component || "BREAKOUT_RETEST",
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
    if (winner === "ICT_STYLE_TRADING" && typeof this._ict.calculateRiskConfig === "function") {
      return this._ict.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    if (winner === "LIQUIDATION_SQUEEZE" && typeof this._ls.calculateRiskConfig === "function") {
      return this._ls.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    if (typeof this._br.calculateRiskConfig === "function") {
      return this._br.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    return this._br.getRiskConfig();
  }
}

module.exports = BreakoutStormUmbrella;
