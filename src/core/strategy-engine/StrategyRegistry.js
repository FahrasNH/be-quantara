/**
 * StrategyRegistry.js — Factory Pattern for Strategy Management
 *
 * v2.1 — Umbrella architecture (race-to-confirm pools).
 * Canonical engine keys : AF_SMC · TS_TF · MD_MR · BS_BR
 * Component aliases     : AF_WYCKOFF / AF_VSA → AF umbrella instance
 *                         TS_MS / TS_VP → TS umbrella instance
 *                         MD_SD / MD_SA → MD umbrella instance
 *                         BS_ICT / BS_LS → BS umbrella instance
 * Legacy ingress aliases normalize via strategyKeyNormalizer ACL → AF_SMC / TS_TF / MD_MR / BS_BR.
 *
 * GROK_AI_TRADING — experimental VAULT bonus (LLM entry engine). Registered
 * but NOT part of any tier race pool. Prefer GrokConfirm overlay in production.
 *
 * Legacy aliases ensure bots created before the v2.0 migration continue to
 * work while the DB migration is applied in the background.
 */

const AdaptiveFusionUmbrella = require("./umbrellas/AdaptiveFusionUmbrella");
const TrendSurgeUmbrella     = require("./umbrellas/TrendSurgeUmbrella");
const MeanDriftUmbrella      = require("./umbrellas/MeanDriftUmbrella");
const BreakoutStormUmbrella  = require("./umbrellas/BreakoutStormUmbrella");
const GrokAiTradingStrategy  = require("./implementations/GrokAiTradingStrategy");

const { normalizeStrategyKey } = require("../../config/strategies");

class StrategyRegistry {
  constructor() {
    this.strategies = new Map();
    this.defaultKey = null;

    this._registerBuiltInStrategies();
  }

  _registerBuiltInStrategies() {
    // ── Primary (umbrella engine) keys ────────────────────────────────────
    const af = new AdaptiveFusionUmbrella();
    const ts = new TrendSurgeUmbrella();
    const md = new MeanDriftUmbrella();
    const bs = new BreakoutStormUmbrella();
    const ga = new GrokAiTradingStrategy();

    this.register("AF_SMC",          af);
    this.register("TS_TF",           ts);
    this.register("MD_MR",           md);
    this.register("BS_BR",           bs);
    // Experimental — VAULT bonus; see config/strategies.js EXPERIMENTAL_STRATEGIES
    this.register("GROK_AI_TRADING", ga);

    // ── Component keys → same umbrella instances (race pools) ─────────────
    this.strategies.set("AF_WYCKOFF", af);
    this.strategies.set("AF_VSA",     af);
    this.strategies.set("TS_MS",      ts);
    this.strategies.set("TS_VP",      ts);
    this.strategies.set("MD_SD",      md);
    this.strategies.set("MD_SA",      md);
    this.strategies.set("BS_ICT",     bs);
    this.strategies.set("BS_LS",      bs);

    this.defaultKey = "AF_SMC";
  }

  /**
   * Register a strategy.
   * @param {string} key
   * @param {StrategyBase} instance
   */
  register(key, instance) {
    if (!key || typeof key !== "string") {
      throw new Error("Strategy key must be a non-empty string");
    }
    if (!instance || typeof instance.detectSignal !== "function") {
      throw new Error("Strategy must be a StrategyBase instance");
    }
    this.strategies.set(key, instance);
    if (!this.defaultKey) this.defaultKey = key;
    return this;
  }

  /**
   * Get a strategy by key.
   * Automatically resolves legacy keys via the migration map.
   */
  get(key) {
    if (!key) return null;
    // Try direct lookup first
    let instance = this.strategies.get(key);
    if (!instance) {
      // Try normalized key (legacy → new)
      const normalized = normalizeStrategyKey(key);
      instance = this.strategies.get(normalized) || null;
    }
    return instance;
  }

  getDefault() {
    return this.defaultKey ? this.get(this.defaultKey) : null;
  }

  listAll() {
    // Return unique instances (dedup aliases)
    const seen = new Set();
    const result = [];
    for (const instance of this.strategies.values()) {
      if (!seen.has(instance)) {
        seen.add(instance);
        result.push(instance);
      }
    }
    return result;
  }

  listEnabled() {
    return this.listAll().filter((s) => s.config.enabled);
  }

  validate(key) {
    const strategy = this.get(key);
    if (!strategy) {
      return { valid: false, error: `Strategy "${key}" not found`, available: this.getUIChoices() };
    }
    if (!strategy.config.enabled) {
      return { valid: false, error: `Strategy "${key}" is disabled`, available: this.getUIChoices() };
    }
    return { valid: true, strategy };
  }

  getUIChoices() {
    return this.listEnabled().map((s) => ({
      value:       s.config.name,
      label:       s.config.label,
      description: s.config.description,
      version:     s.config.version,
    }));
  }

  getInfo(key) {
    const strategy = this.get(key);
    if (!strategy) return null;
    return {
      name:            strategy.config.name,
      label:           strategy.config.label,
      description:     strategy.config.description,
      version:         strategy.config.version,
      enabled:         strategy.config.enabled,
      riskConfig:      strategy.getRiskConfig(),
      timeframeConfig: strategy.getTimeframeConfig(),
    };
  }

  count() {
    return this.strategies.size;
  }
}

const strategyRegistry = new StrategyRegistry();

module.exports = { StrategyRegistry, strategyRegistry };
