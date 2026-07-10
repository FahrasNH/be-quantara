/**
 * AdaptiveFusionUmbrella.js — FOUNDRY Tier umbrella strategy
 *
 * Umbrella key : AF_SMC
 * Components   : AF_SMC (A) · AF_WYCKOFF (B) · AF_VSA (C)
 *
 * Voting (AF-SUB-03):
 *   - Default 2/3 majority
 *   - Altcoin (VOLATILE / SEMI_VOLATILE) → 3/3 unanimity
 *   - Vote breakdown stored on lastSignalMeta for entryContext
 *
 * Multi-position (Scalping/Intraday/Swing) still comes from SMC; when
 * afUseThreeComponentVoting is enabled (default true), type entries are
 * gated so their direction must match the umbrella majority vote.
 */

const UmbrellaStrategy           = require("../base/UmbrellaStrategy");
const SmartMoneyConceptsStrategy = require("../implementations/SmartMoneyConceptsStrategy");
const WyckoffStrategy            = require("../implementations/WyckoffStrategy");
const VsaStrategy                = require("../implementations/VsaStrategy");
const { aggregateAfVotes }       = require("../af/afVoting");

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
      name:        "AF_SMC",
      label:       "Adaptive Fusion",
      description:
        "3-component Adaptive Fusion: SMC + Wyckoff + VSA (2/3 majority; 3/3 altcoin)",
      version:     "3.0.0",
      enabled:     true,
      // 3 components × 0.67 → ceil = 2 (2/3). Altcoin override uses absolute votes.
      votingThreshold: 0.67,
    });

    this._smc     = new SmartMoneyConceptsStrategy();
    this._wyckoff = new WyckoffStrategy();
    this._vsa     = new VsaStrategy();

    this.addComponent("AF_SMC",     this._smc);
    this.addComponent("AF_WYCKOFF", this._wyckoff);
    this.addComponent("AF_VSA",     this._vsa);

    this._lastVoteMeta = null;
  }

  /**
   * Collect per-component votes (NEUTRAL included) for breakdown logging.
   * @param {object} [precomputedMulti] - optional SMC detectSignalMulti result
   */
  collectComponentVotes(indicators, lastIdx, config = {}, precomputedMulti = null) {
    const votes = [];

    // Component A — SMC
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

    // Component B — Wyckoff
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

    // Component C — VSA
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

    return votes;
  }

  _aggregate(componentVotes, config = {}) {
    const aggregated = aggregateAfVotes(componentVotes, {
      pairTier: config.pairTier,
      symbol: config.symbol,
      afMinVotes: config.afMinVotes ?? config.afVotingMinVotes,
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
   * 3-component voting with altcoin threshold + vote breakdown.
   */
  detectSignal(indicators, lastIdx, config = {}) {
    const useVoting = config.afUseThreeComponentVoting !== false;
    if (!useVoting) {
      return this._smc.detectSignal(indicators, lastIdx, config);
    }

    const componentVotes = this.collectComponentVotes(indicators, lastIdx, config);
    const aggregated = this._aggregate(componentVotes, config);
    return aggregated.signal;
  }

  /**
   * Multi-position: SMC type legs gated by umbrella majority direction.
   * When voting disabled, passthrough to SMC unchanged.
   */
  detectSignalMulti(indicators, lastIdx, config = {}) {
    const multi = this._smc.detectSignalMulti(indicators, lastIdx, config);
    const useVoting = config.afUseThreeComponentVoting !== false;

    if (!useVoting) {
      return multi;
    }

    const componentVotes = this.collectComponentVotes(indicators, lastIdx, config, multi);
    const aggregated = this._aggregate(componentVotes, config);

    const attachMeta = (base) => ({
      ...(base || {}),
      afVotes: this._lastVoteMeta,
      signalComponents: aggregated.breakdown,
      gatedByVoting: true,
    });

    // No majority → suppress all type entries
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
    const filter = (sig) => (sig === dir ? sig : null);
    return {
      Scalping: filter(multi?.Scalping),
      Intraday: filter(multi?.Intraday),
      Swing:    filter(multi?.Swing),
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
    const smcMeta = typeof this._smc.getLastSignalMeta === "function"
      ? this._smc.getLastSignalMeta()
      : null;
    return {
      ...(smcMeta || {}),
      afVotes: this._lastVoteMeta,
      signalComponents: this._lastVoteMeta?.breakdown || null,
    };
  }

  getLastVoteMeta() {
    return this._lastVoteMeta;
  }

  resetAblation() {
    if (typeof this._smc.resetAblation === "function") this._smc.resetAblation();
  }
  getAblation() {
    return typeof this._smc.getAblation === "function" ? this._smc.getAblation() : null;
  }

  calculateRiskConfig(entryPrice, atr, signal, component, opts) {
    if (typeof this._smc.calculateRiskConfig === "function") {
      return this._smc.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    return this._smc.getRiskConfig();
  }
}

module.exports = AdaptiveFusionUmbrella;
