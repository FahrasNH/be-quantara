/**
 * UmbrellaStrategy.js — Base class for umbrella/parent strategies.
 *
 * An umbrella wraps one or more component strategies and aggregates
 * their signals via a voting mechanism. Currently each umbrella has
 * one active component; when future components are added, voting kicks in
 * automatically (≥2/3 qualified components → entry).
 *
 * Subclasses only need to:
 *   1. Call super(config) with their config.
 *   2. Call this.addComponent(key, instance) for each component.
 */

const StrategyBase = require("./StrategyBase");

class UmbrellaStrategy extends StrategyBase {
  constructor(config = {}) {
    super(config);
    // key → StrategyBase instance
    this._components = new Map();
    // First added component is the default active one
    this._activeComponentKey = null;
    // Minimum fraction of qualified components required for entry (default 1/3)
    this._votingThreshold = config.votingThreshold || 0.34;
  }

  // ─── Component management ────────────────────────────────────────────────

  addComponent(key, instance) {
    if (!key || !instance) throw new Error("addComponent: key and instance required");
    this._components.set(key, instance);
    if (!this._activeComponentKey) this._activeComponentKey = key;
    return this;
  }

  getActiveComponent() {
    if (!this._activeComponentKey) throw new Error(`${this.config.name}: no component registered`);
    return this._components.get(this._activeComponentKey);
  }

  getComponentKeys() {
    return Array.from(this._components.keys());
  }

  // ─── StrategyBase abstract method implementations ─────────────────────────

  rankByMarketConditions(marketConditions = {}) {
    return this.getActiveComponent().rankByMarketConditions(marketConditions);
  }

  canActivate(balance, htfTrend, volatility) {
    return this.getActiveComponent().canActivate(balance, htfTrend, volatility);
  }

  getTimeframeConfig() {
    return this.getActiveComponent().getTimeframeConfig();
  }

  validateEntry(price, atr, volume, volSMA) {
    return this.getActiveComponent().validateEntry(price, atr, volume, volSMA);
  }

  getRiskConfig() {
    return this.getActiveComponent().getRiskConfig();
  }

  /**
   * Core voting logic.
   *
   * For 1 component  → direct delegation (no vote needed).
   * For N components → run each, collect qualified signals, take majority direction.
   * If tied or no clear majority → null.
   */
  detectSignal(indicators, lastIdx, config = {}) {
    const components = Array.from(this._components.values());

    // Fast path: single component
    if (components.length === 1) {
      return components[0].detectSignal(indicators, lastIdx, config);
    }

    const votes = [];
    for (const component of components) {
      try {
        const signal = component.detectSignal(indicators, lastIdx, config);
        if (signal === "LONG" || signal === "SHORT") {
          votes.push(signal);
        }
      } catch (_) {
        // component error → abstain
      }
    }

    const required = Math.max(1, Math.ceil(components.length * this._votingThreshold));
    if (votes.length < required) return null;

    const longs  = votes.filter((v) => v === "LONG").length;
    const shorts = votes.filter((v) => v === "SHORT").length;

    if (longs > shorts && longs >= required)  return "LONG";
    if (shorts > longs && shorts >= required) return "SHORT";
    return null;
  }

  // ─── Passthrough for calculateRiskConfig (SAC-specific) ──────────────────

  calculateRiskConfig(entryPrice, atr, signal, component, opts) {
    const active = this.getActiveComponent();
    if (typeof active.calculateRiskConfig === "function") {
      return active.calculateRiskConfig(entryPrice, atr, signal, component, opts);
    }
    return active.getRiskConfig();
  }

  // ─── Passthrough for detectSignalMulti (SAC-specific) ────────────────────

  detectSignalMulti(indicators, lastIdx, config) {
    const active = this.getActiveComponent();
    if (typeof active.detectSignalMulti === "function") {
      return active.detectSignalMulti(indicators, lastIdx, config);
    }
    return null;
  }

  // ─── Passthrough for AF-SCALP-13 ablation telemetry ──────────────────────
  // The backtest resets/reads these on the umbrella (what the registry returns),
  // but the counters live on the active component (SMC). Without these the funnel
  // stayed null even though the leg ran. BUG: registry returns AdaptiveFusionUmbrella.
  resetAblation() {
    const active = this.getActiveComponent();
    if (typeof active.resetAblation === "function") active.resetAblation();
  }
  getAblation() {
    const active = this.getActiveComponent();
    return typeof active.getAblation === "function" ? active.getAblation() : null;
  }

  // ─── Passthrough for getLastSignalMeta (real-engine component labeling) ───

  getLastSignalMeta() {
    const active = this.getActiveComponent();
    return typeof active.getLastSignalMeta === "function"
      ? active.getLastSignalMeta()
      : null;
  }

  // ─── Metadata ────────────────────────────────────────────────────────────

  getMetadata() {
    return {
      ...super.getMetadata(),
      umbrella: true,
      components: this.getComponentKeys(),
      activeComponent: this._activeComponentKey,
    };
  }
}

module.exports = UmbrellaStrategy;
