/**
 * AdaptiveFusionUmbrella.js — FOUNDRY Tier umbrella strategy
 *
 * Umbrella key : SMART_MONEY_CONCEPTS (tier access bag — not a fusion mechanism)
 * Components   : SMART_MONEY_CONCEPTS (Smart Money Concepts) · WYCKOFF · VOLUME_SPREAD_ANALYSIS
 *
 * ARCHITECTURE DECISION (Fahras, 10 Jul 2026) — AF-SUB-03 rescope:
 *   Race-to-Confirm replaces Sprint 8 2/3 voting. Each unlocked component is an
 *   independent signal generator. Same-bar winner = highest confidence; ties
 *   break SMART_MONEY_CONCEPTS → WYCKOFF → VOLUME_SPREAD_ANALYSIS. Trade attribution = winning component
 *   only (never joined "SMC + Wyckoff + VSA").
 *
 * Rollback:
 *   afCombinationMode: "vote"  → Sprint 8 2/3 (altcoin 3/3) voting
 *   afUseThreeComponentVoting: false → SMC-only passthrough
 */

const UmbrellaStrategy           = require("../base/UmbrellaStrategy");
const SmartMoneyConceptsStrategy = require("../implementations/SmartMoneyConceptsStrategy");
const WyckoffStrategy            = require("../implementations/WyckoffStrategy");
const VsaStrategy                = require("../implementations/VsaStrategy");
const { aggregateAfVotes }       = require("../af/afVoting");
const { normalizeStrategyKey } = require("../../../config/strategyKeyNormalizer");
const {
  enrichMetaWithGradedScore,
  gradedConfidenceFromMeta,
} = require("../scoring/ComponentScoringEngine");

const RACER_PRIORITY = ["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"];
const RACER_LABELS = {
  SMART_MONEY_CONCEPTS:     "Smart Money Concepts",
  WYCKOFF: "Wyckoff Method",
  VOLUME_SPREAD_ANALYSIS:     "Volume Spread Analysis",
};

function smcVoteFromMulti(multi) {
  if (!multi) return { vote: "NEUTRAL", confidence: 0, reason: "smc_no_multi" };
  const signals = [multi.Scalping, multi.Intraday, multi.Swing].filter(Boolean);
  const longs = signals.filter((s) => s === "LONG").length;
  const shorts = signals.filter((s) => s === "SHORT").length;
  const agg =
    multi.meta?.aggregateConfidence != null
      ? multi.meta.aggregateConfidence / 100
      : 0.7;

  if (longs > 0 && shorts > 0) {
    return { vote: "NEUTRAL", confidence: 0, reason: "smc_conflict" };
  }
  if (longs > 0) return { vote: "LONG", confidence: agg, reason: "smc_signal" };
  if (shorts > 0) return { vote: "SHORT", confidence: agg, reason: "smc_signal" };
  return { vote: "NEUTRAL", confidence: 0, reason: "smc_no_signal" };
}

class AdaptiveFusionUmbrella extends UmbrellaStrategy {
  constructor() {
    super({
      name:        "SMART_MONEY_CONCEPTS",
      label:       "Adaptive Fusion",
      description:
        "FOUNDRY umbrella (tier access): Smart Money Concepts, Wyckoff, and VSA race independently — highest confirmation wins.",
      version:     "4.0.0",
      enabled:     true,
      // Kept for vote-mode rollback (2/3 → ceil). Race mode ignores this.
      votingThreshold: 0.67,
    });

    this._smc     = new SmartMoneyConceptsStrategy();
    this._wyckoff = new WyckoffStrategy();
    this._vsa     = new VsaStrategy();

    this.addComponent("SMART_MONEY_CONCEPTS",     this._smc);
    this.addComponent("WYCKOFF", this._wyckoff);
    this.addComponent("VOLUME_SPREAD_ANALYSIS",     this._vsa);

    this._lastVoteMeta = null;
    this._lastRaceMeta = null;
  }

  /**
   * Resolve combination mode.
   * Default: race (Sprint 12 architecture). Vote kept as explicit rollback.
   */
  _resolveMode(config = {}) {
    if (config.afUseThreeComponentVoting === false) return "smc_only";
    const raw = String(config.afCombinationMode || "race").toLowerCase();
    if (raw === "vote" || raw === "voting" || raw === "majority") return "vote";
    if (raw === "smc" || raw === "smc_only") return "smc_only";
    return "race";
  }

  /**
   * Which AF racers/voters participate. Advance selectedComponents restrict the set;
   * empty/missing → all three (FOUNDRY default).
   */
  _resolveActiveRacers(config = {}) {
    const raw = config.afActiveRacers || config.afActiveVoters
      || config.selectedComponents || config.activeStrategyComponents || null;
    if (!Array.isArray(raw) || raw.length === 0) {
      return new Set(RACER_PRIORITY);
    }
    const active = new Set();
    for (const c of raw) {
      const k = normalizeStrategyKey(String(c || "").toUpperCase());
      if (k === "SMART_MONEY_CONCEPTS" || String(c || "").toUpperCase() === "SMC") {
        active.add("SMART_MONEY_CONCEPTS");
      } else if (k === "WYCKOFF" || String(c || "").toUpperCase() === "WYCKOFF") {
        active.add("WYCKOFF");
      } else if (k === "VOLUME_SPREAD_ANALYSIS" || k === "VSA") {
        active.add("VOLUME_SPREAD_ANALYSIS");
      }
    }
    if (active.size === 0) return new Set(RACER_PRIORITY);
    return active;
  }

  /** @deprecated alias — vote-mode callers */
  _resolveActiveVoters(config = {}) {
    const active = this._resolveActiveRacers(config);
    // Vote-mode collectComponentVotes also checks short aliases SMC/WYCKOFF/VSA
    const withAliases = new Set(active);
    if (active.has("SMART_MONEY_CONCEPTS")) { withAliases.add("SMC"); }
    if (active.has("WYCKOFF")) { withAliases.add("WYCKOFF"); }
    if (active.has("VOLUME_SPREAD_ANALYSIS")) { withAliases.add("VSA"); }
    return withAliases;
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

  /** Last signal meta from the winning AF racer (Wyckoff/VSA/SMC). */
  _winnerComponentMeta(winnerKey) {
    if (winnerKey === "WYCKOFF" && typeof this._wyckoff.getLastSignalMeta === "function") {
      return this._wyckoff.getLastSignalMeta() || {};
    }
    if (winnerKey === "VOLUME_SPREAD_ANALYSIS" && typeof this._vsa.getLastSignalMeta === "function") {
      return this._vsa.getLastSignalMeta() || {};
    }
    if (typeof this._smc.getLastSignalMeta === "function") {
      return this._smc.getLastSignalMeta() || {};
    }
    return {};
  }

  /**
   * Collect per-component votes (NEUTRAL included) for vote-mode breakdown.
   * @param {object} [precomputedMulti] - optional SMC detectSignalMulti result
   */
  collectComponentVotes(indicators, lastIdx, config = {}, precomputedMulti = null) {
    const votes = [];
    const active = this._resolveActiveVoters(config);

    if (active.has("SMART_MONEY_CONCEPTS") || active.has("SMC")) {
      let smc;
      if (precomputedMulti) {
        smc = smcVoteFromMulti(precomputedMulti);
      } else {
        try {
          const sig = this._smc.detectSignal(indicators, lastIdx, config);
          const meta = typeof this._smc.getLastSignalMeta === "function"
            ? this._smc.getLastSignalMeta()
            : null;
          if (sig === "LONG" || sig === "SHORT") {
            smc = {
              vote: sig,
              confidence: (meta?.aggregateConfidence ?? 70) / 100,
              reason: "smc_signal",
            };
          } else {
            smc = { vote: "NEUTRAL", confidence: 0, reason: "smc_no_signal" };
          }
        } catch (err) {
          smc = { vote: "NEUTRAL", confidence: 0, reason: `smc_error:${err.message}` };
        }
      }
      votes.push({ key: "SMC", ...smc });
    }

    if (active.has("WYCKOFF") || active.has("WYCKOFF")) {
      let wyResult = { vote: "NEUTRAL", confidence: 0, reason: "unevaluated" };
      try {
        wyResult = this._wyckoff.evaluate(indicators, lastIdx, config);
      } catch (err) {
        wyResult = { vote: "NEUTRAL", confidence: 0, reason: `wyckoff_error:${err.message}` };
      }
      votes.push({
        key: "WYCKOFF",
        vote: wyResult.vote || "NEUTRAL",
        confidence: wyResult.confidence || 0,
        reason: wyResult.reason,
      });
    }

    if (active.has("VOLUME_SPREAD_ANALYSIS") || active.has("VSA")) {
      let vsaResult = { vote: "NEUTRAL", confidence: 0, reason: "unevaluated" };
      try {
        vsaResult = this._vsa.evaluate(indicators, lastIdx, config);
      } catch (err) {
        vsaResult = { vote: "NEUTRAL", confidence: 0, reason: `vsa_error:${err.message}` };
      }
      votes.push({
        key: "VSA",
        vote: vsaResult.vote || "NEUTRAL",
        confidence: vsaResult.confidence || 0,
        reason: vsaResult.reason,
      });
    }

    return votes;
  }

  _aggregate(componentVotes, config = {}) {
    const n = componentVotes.length || 1;
    const rawMin = config.afMinVotes != null
      ? config.afMinVotes
      : Math.max(1, Math.ceil(n * 2 / 3));
    const scaledMin = Math.min(Math.max(1, rawMin), n);
    const aggregated = aggregateAfVotes(componentVotes, {
      pairTier: config.pairTier,
      symbol: config.symbol,
      afMinVotes: scaledMin,
      isAltcoin: config.isAltcoin,
    });
    this._lastVoteMeta = {
      ...aggregated,
      componentVotes,
      capturedAt: new Date().toISOString(),
    };
    return aggregated;
  }

  /**
   * Race-to-confirm: evaluate active racers in parallel; winner takes the trade.
   */
  _detectRace(indicators, lastIdx, config = {}, precomputedMulti = null) {
    const active = this._resolveActiveRacers(config);
    const candidates = [];
    const evaluations = {};

    let smcMulti = precomputedMulti;
    if (active.has("SMART_MONEY_CONCEPTS")) {
      let signal = null;
      let confidence = 0;
      let reason = "smc_no_signal";
      try {
        if (!smcMulti && typeof this._smc.detectSignalMulti === "function") {
          smcMulti = this._smc.detectSignalMulti(indicators, lastIdx, config);
        }
        if (smcMulti) {
          const smc = smcVoteFromMulti(smcMulti);
          signal = smc.vote === "LONG" || smc.vote === "SHORT" ? smc.vote : null;
          const smcMeta = enrichMetaWithGradedScore(
            { ...(smcMulti.meta || {}), winningComponent: "SMART_MONEY_CONCEPTS" },
            "SMART_MONEY_CONCEPTS",
          );
          confidence = gradedConfidenceFromMeta(smcMeta, "SMART_MONEY_CONCEPTS") || smc.confidence || 0;
          reason = smc.reason || (signal ? "smc_signal" : "smc_no_signal");
        } else {
          signal = this._smc.detectSignal(indicators, lastIdx, config);
          const meta = typeof this._smc.getLastSignalMeta === "function"
            ? enrichMetaWithGradedScore(
              { ...(this._smc.getLastSignalMeta() || {}), winningComponent: "SMART_MONEY_CONCEPTS" },
              "SMART_MONEY_CONCEPTS",
            )
            : null;
          confidence = gradedConfidenceFromMeta(meta, "SMART_MONEY_CONCEPTS")
            || (meta?.aggregateConfidence != null ? meta.aggregateConfidence / 100 : (signal ? 0.7 : 0));
          reason = signal ? "smc_signal" : "smc_no_signal";
        }
      } catch (err) {
        reason = `smc_error:${err.message}`;
      }
      evaluations.SMART_MONEY_CONCEPTS = { signal, confidence, reason };
      if (signal === "LONG" || signal === "SHORT") {
        candidates.push({
          key: "SMART_MONEY_CONCEPTS",
          label: RACER_LABELS.SMART_MONEY_CONCEPTS,
          signal,
          confidence,
          reason,
        });
      }
    }

    if (active.has("WYCKOFF")) {
      let signal = null;
      let confidence = 0;
      let reason = "wyckoff_no_signal";
      try {
        const result = this._wyckoff.evaluate(indicators, lastIdx, config);
        signal = result.vote === "LONG" || result.vote === "SHORT" ? result.vote : null;
        const wyMeta = enrichMetaWithGradedScore(
          { ...(this._wyckoff.getLastSignalMeta() || {}), winningComponent: "WYCKOFF", signal },
          "WYCKOFF",
        );
        confidence = gradedConfidenceFromMeta(wyMeta, "WYCKOFF") || result.confidence || 0;
        reason = result.reason || (signal ? "wyckoff_pattern" : "wyckoff_no_signal");
      } catch (err) {
        reason = `wyckoff_error:${err.message}`;
      }
      evaluations.WYCKOFF = { signal, confidence, reason };
      if (signal === "LONG" || signal === "SHORT") {
        candidates.push({
          key: "WYCKOFF",
          label: RACER_LABELS.WYCKOFF,
          signal,
          confidence,
          reason,
        });
      }
    }

    if (active.has("VOLUME_SPREAD_ANALYSIS")) {
      let signal = null;
      let confidence = 0;
      let reason = "vsa_no_signal";
      try {
        const result = this._vsa.evaluate(indicators, lastIdx, config);
        signal = result.vote === "LONG" || result.vote === "SHORT" ? result.vote : null;
        const vsaMeta = enrichMetaWithGradedScore(
          { ...(this._vsa.getLastSignalMeta() || {}), winningComponent: "VOLUME_SPREAD_ANALYSIS", signal },
          "VOLUME_SPREAD_ANALYSIS",
        );
        confidence = gradedConfidenceFromMeta(vsaMeta, "VOLUME_SPREAD_ANALYSIS") || result.confidence || 0;
        reason = result.reason || (signal ? "vsa_pattern" : "vsa_no_signal");
      } catch (err) {
        reason = `vsa_error:${err.message}`;
      }
      evaluations.VOLUME_SPREAD_ANALYSIS = { signal, confidence, reason };
      if (signal === "LONG" || signal === "SHORT") {
        candidates.push({
          key: "VOLUME_SPREAD_ANALYSIS",
          label: RACER_LABELS.VOLUME_SPREAD_ANALYSIS,
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
        smcMulti: smcMulti || null,
      };
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
        SMART_MONEY_CONCEPTS: evaluations.SMART_MONEY_CONCEPTS?.signal || (active.has("SMART_MONEY_CONCEPTS") ? "NEUTRAL" : "DISABLED"),
        WYCKOFF: evaluations.WYCKOFF?.signal || (active.has("WYCKOFF") ? "NEUTRAL" : "DISABLED"),
        VOLUME_SPREAD_ANALYSIS: evaluations.VOLUME_SPREAD_ANALYSIS?.signal || (active.has("VOLUME_SPREAD_ANALYSIS") ? "NEUTRAL" : "DISABLED"),
      },
      smcMulti: smcMulti || null,
    };
    return winner.signal;
  }

  /**
   * Sprint 8 voting (rollback via afCombinationMode:"vote").
   */
  _detectVote(indicators, lastIdx, config = {}) {
    const componentVotes = this.collectComponentVotes(indicators, lastIdx, config);
    const aggregated = this._aggregate(componentVotes, config);
    this._lastRaceMeta = {
      mode: "vote",
      ...this._lastVoteMeta,
      winningComponent: aggregated.signal
        ? (componentVotes.find((v) => v.vote === aggregated.signal)?.key === "SMC"
          ? "SMART_MONEY_CONCEPTS"
          : componentVotes.find((v) => v.vote === aggregated.signal)?.key === "WYCKOFF"
            ? "WYCKOFF"
            : componentVotes.find((v) => v.vote === aggregated.signal)?.key === "VSA"
              ? "VOLUME_SPREAD_ANALYSIS"
              : null)
        : null,
      strategyLabel: aggregated.signal ? "Adaptive Fusion (vote)" : null,
    };
    return aggregated.signal;
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const mode = this._resolveMode(config);
    if (mode === "smc_only") {
      this._lastRaceMeta = { mode: "smc_only", winningComponent: "SMART_MONEY_CONCEPTS", strategyLabel: RACER_LABELS.SMART_MONEY_CONCEPTS };
      return this._smc.detectSignal(indicators, lastIdx, config);
    }
    if (mode === "vote") {
      return this._detectVote(indicators, lastIdx, config);
    }
    return this._detectRace(indicators, lastIdx, config);
  }

  /**
   * Multi-position: race winner drives type legs.
   * - SMART_MONEY_CONCEPTS wins → SMC type legs filtered to winner direction
   * - Wyckoff/VSA wins → promote direction to all type legs (standalone racer)
   * Vote mode keeps Sprint 8 gating behaviour.
   */
  detectSignalMulti(indicators, lastIdx, config = {}) {
    const mode = this._resolveMode(config);
    const multi = this._smc.detectSignalMulti(indicators, lastIdx, config);

    if (mode === "smc_only") {
      this._lastRaceMeta = {
        mode: "smc_only",
        winningComponent: "SMART_MONEY_CONCEPTS",
        strategyLabel: RACER_LABELS.SMART_MONEY_CONCEPTS,
      };
      return multi;
    }

    if (mode === "vote") {
      return this._detectSignalMultiVote(multi, indicators, lastIdx, config);
    }

    return this._detectSignalMultiRace(multi, indicators, lastIdx, config);
  }

  _detectSignalMultiVote(multi, indicators, lastIdx, config = {}) {
    const componentVotes = this.collectComponentVotes(indicators, lastIdx, config, multi);
    const aggregated = this._aggregate(componentVotes, config);

    const attachMeta = (base) => ({
      ...(base || {}),
      afVotes: this._lastVoteMeta,
      afRace: null,
      signalComponents: aggregated.breakdown,
      gatedByVoting: true,
      combinationMode: "vote",
    });

    if (!aggregated.signal) {
      return {
        Scalping: null,
        Intraday: null,
        Swing: null,
        A: null,
        B: null,
        C: null,
        meta: attachMeta({
          ...(multi?.meta || {}),
          gateReason: aggregated.reason,
        }),
      };
    }

    const dir = aggregated.signal;
    const voters = this._resolveActiveVoters(config);
    const smcActive = voters.has("SMART_MONEY_CONCEPTS") || voters.has("SMC");
    if (!smcActive) {
      const voterKey = componentVotes.find((v) => v.vote === dir)?.key;
      const winnerKey = voterKey === "SMC"
        ? "SMART_MONEY_CONCEPTS"
        : voterKey === "VSA"
          ? "VOLUME_SPREAD_ANALYSIS"
          : voterKey === "WYCKOFF"
            ? "WYCKOFF"
            : null;
      return {
        Scalping: dir,
        Intraday: dir,
        Swing:    dir,
        A: dir,
        B: dir,
        C: dir,
        meta: attachMeta({
          ...(winnerKey ? this._winnerComponentMeta(winnerKey) : {}),
          gateDirection: dir,
          standaloneVoterEntry: true,
        }),
      };
    }

    const filter = (sig) => (sig === dir ? sig : null);
    return {
      Scalping: filter(multi?.Scalping),
      Intraday: filter(multi?.Intraday),
      Swing: filter(multi?.Swing),
      A: filter(multi?.A),
      B: filter(multi?.B),
      C: filter(multi?.C),
      meta: attachMeta({
        ...(multi?.meta || {}),
        gateDirection: dir,
      }),
    };
  }

  _detectSignalMultiRace(multi, indicators, lastIdx, config = {}) {
    const signal = this._detectRace(indicators, lastIdx, config, multi);
    const race = this._lastRaceMeta;

    const attachMeta = (base) => ({
      ...(base || {}),
      afVotes: null,
      afRace: race,
      signalComponents: race?.signalComponents || null,
      winningComponent: race?.winningComponent || null,
      strategyLabel: race?.strategyLabel || null,
      gatedByVoting: false,
      combinationMode: "race",
    });

    if (!signal || !race?.winner) {
      return {
        Scalping: null,
        Intraday: null,
        Swing: null,
        A: null,
        B: null,
        C: null,
        meta: attachMeta({
          ...(multi?.meta || {}),
          gateReason: race?.reason || "no_racer_confirmed",
        }),
      };
    }

    const dir = signal;
    const winnerKey = race.winningComponent;

    // Non-SMC racers: promote into AF-supported type legs only (Scalping + Swing).
    // Do NOT paint Intraday — WYCKOFF/VOLUME_SPREAD_ANALYSIS are not Intraday strategies, and
    // painting all three legs caused false Intraday type attribution when the
    // multi-position engine ran without per-type activeComponents filtering.
    if (winnerKey === "WYCKOFF" || winnerKey === "VOLUME_SPREAD_ANALYSIS") {
      return {
        Scalping: dir,
        Intraday: null,
        Swing:    dir,
        A: dir,
        B: null,
        C: dir,
        meta: attachMeta({
          ...this._winnerComponentMeta(winnerKey),
          gateDirection: dir,
          standaloneRacerEntry: true,
        }),
      };
    }

    // SMC wins: keep SMC multi-position type legs matching winner direction
    const filter = (sig) => (sig === dir ? sig : null);
    return {
      Scalping: filter(multi?.Scalping),
      Intraday: filter(multi?.Intraday),
      Swing: filter(multi?.Swing),
      A: filter(multi?.A),
      B: filter(multi?.B),
      C: filter(multi?.C),
      meta: attachMeta({
        ...(multi?.meta || {}),
        gateDirection: dir,
      }),
    };
  }

  getLastSignalMeta() {
    const winnerKey = this._lastRaceMeta?.winningComponent;
    let baseMeta = null;
    if (winnerKey === "WYCKOFF" && typeof this._wyckoff.getLastSignalMeta === "function") {
      baseMeta = this._wyckoff.getLastSignalMeta();
    } else if (winnerKey === "VOLUME_SPREAD_ANALYSIS" && typeof this._vsa.getLastSignalMeta === "function") {
      baseMeta = this._vsa.getLastSignalMeta();
    } else if (typeof this._smc.getLastSignalMeta === "function") {
      baseMeta = this._smc.getLastSignalMeta();
    }

    const label = this._lastRaceMeta?.strategyLabel
      || (winnerKey ? RACER_LABELS[winnerKey] : null);

    return enrichMetaWithGradedScore({
      ...(baseMeta || {}),
      component: winnerKey || baseMeta?.component || "SMART_MONEY_CONCEPTS",
      winningComponent: winnerKey || null,
      strategyLabel: label,
      afRace: this._lastRaceMeta,
      afVotes: this._lastVoteMeta,
      signalComponents: this._lastRaceMeta?.signalComponents
        || this._lastVoteMeta?.breakdown
        || null,
      componentConfidence: this._lastRaceMeta?.winner?.confidence != null
        ? Math.round(this._lastRaceMeta.winner.confidence * 100)
        : baseMeta?.componentConfidence ?? baseMeta?.aggregateConfidence,
    }, winnerKey || baseMeta?.component || "SMART_MONEY_CONCEPTS");
  }

  getLastVoteMeta() {
    return this._lastVoteMeta;
  }

  getLastRaceMeta() {
    return this._lastRaceMeta;
  }

  calculateRiskConfig(entryPrice, atr, signal, component, opts) {
    const winner = this._lastRaceMeta?.winningComponent || component;
    if (winner === "WYCKOFF" && typeof this._wyckoff.calculateRiskConfig === "function") {
      return this._wyckoff.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    if (winner === "VOLUME_SPREAD_ANALYSIS" && typeof this._vsa.calculateRiskConfig === "function") {
      return this._vsa.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    if (typeof this._smc.calculateRiskConfig === "function") {
      return this._smc.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    return this._smc.getRiskConfig();
  }
}

module.exports = AdaptiveFusionUmbrella;
