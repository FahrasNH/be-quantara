/**
 * ─────────────────────────────────────────────
 * AdaptiveStrategyEngine.js — BotEngine Wrapper with AFS Support
 *
 * Extends BotEngine with Adaptive Fusion Strategy capabilities:
 * - Multi-strategy signal detection
 * - Position conflict detection
 * - Market-aware ranking
 * ─────────────────────────────────────────────
 */

const BotEngine = require("./BotEngine");
const PositionManager = require("../domain/PositionManager");
const { strategyRegistry } = require("../domain/strategy");

class AdaptiveStrategyEngine extends BotEngine {
  constructor(config = {}) {
    const strategyKey = config.strategyKey || "ADAPTIVE_FUSION";

    // Validate and load strategy
    const validation = strategyRegistry.validate(strategyKey);
    if (!validation.valid) {
      throw new Error(
        `Invalid strategy "${strategyKey}": ${validation.error}`
      );
    }

    // Initialize parent BotEngine
    super(config);

    // Load strategy
    this.strategy = validation.strategy;
    this.strategyKey = strategyKey;

    // Position manager for conflict detection
    this.positionManager = new PositionManager(2); // Max 2 positions

    // Restore positions from state
    if (this.state && this.state.openPositions) {
      for (const pos of this.state.openPositions) {
        this.positionManager.addPosition({
          id: pos.id,
          symbol: this.symbol,
          side: pos.side,
          entry: pos.entry,
          strategyKey: this.strategyKey,
        });
      }
    }

    console.log(
      `[AdaptiveStrategyEngine] Initialized with strategy: ${this.strategyKey}`
    );
  }

  /**
   * Get strategy rankings for current market conditions
   * Returns: [{ key, label, score, canActivate }, ...]
   */
  getStrategyRankings() {
    try {
      // Only works for Adaptive Fusion Strategy
      if (!this.strategy.rankByMarketConditions) {
        return null;
      }

      const marketConditions = {
        volatility: this.lastVolatility || 1.0,
        trend_strength: this.lastTrendStrength || 0.1,
      };

      const rankings = this.strategy.rankByMarketConditions(marketConditions);

      // Add activation check
      return rankings.map((r) => {
        const canActivate = this.strategy.canActivate(
          this.capital,
          "NEUTRAL",
          marketConditions.volatility
        );
        return {
          ...r,
          canActivate: canActivate.allowed,
        };
      });
    } catch (err) {
      console.error("[AdaptiveStrategyEngine] Error getting rankings:", err);
      return null;
    }
  }

  /**
   * Get position conflicts
   */
  getPositionConflicts() {
    return this.positionManager.checkEntryConflict(this.symbol);
  }

  /**
   * Override _tick() for AFS multi-strategy scanning
   */
  async _tick() {
    try {
      // Get latest data
      const klines = await this._fetchLatestKlines();
      if (!klines || klines.length < 2) return;

      // Calculate indicators
      const indicators = this._calculateIndicators(klines);
      const lastIdx = klines.length - 1;

      // Hitung volatility (ATR%) dan trend_strength (jarak EMA9-EMA21 relatif) dari
      // data candle nyata. calcIndicators() tidak menghasilkan field ini sehingga
      // tanpa kalkulasi manual AF selalu menerima default volatility=1, ts=0.1
      // → komponen A/B/C dipilih dengan asumsi "dead market", bukan kondisi aktual.
      {
        const price  = klines[lastIdx].close;
        const atr    = indicators.atr?.[lastIdx];
        const emaF   = indicators.emaFast?.[lastIdx];
        const emaS   = indicators.emaSlow?.[lastIdx];
        this.lastVolatility    = atr && price ? (atr / price) * 100 : 1.0;
        const emaDelta         = emaS > 0 ? Math.abs(emaF - emaS) / emaS : 0;
        this.lastTrendStrength = Math.min(emaDelta * 50, 1.0);
      }

      // Detect signal using strategy
      const signal = this.strategy.detectSignal(indicators, lastIdx, {
        balance:        this.capital,
        volatility:     this.lastVolatility,
        trend_strength: this.lastTrendStrength,
        htfTrend:       "NEUTRAL",
      });

      if (!signal) return;

      // Check position conflicts
      const conflict = this.positionManager.checkEntryConflict(this.symbol);
      if (!conflict.allowed) {
        console.log(
          `[${this.symbol}] Position conflict: ${conflict.reason}`
        );
        return;
      }

      // Validate entry
      const validation = this.strategy.validateEntry(
        klines[lastIdx].close,
        indicators.atr[lastIdx],
        klines[lastIdx].volume,
        indicators.volSMA || 0
      );

      if (!validation.valid) {
        console.log(
          `[${this.symbol}] Entry validation failed: ${validation.reason}`
        );
        return;
      }

      // Execute trade
      await this._handleSignal(signal, klines[lastIdx], indicators);
    } catch (err) {
      console.error(`[${this.symbol}] Tick error:`, err.message);
    }
  }

  /**
   * Override _handleSignal() to track positions
   */
  async _handleSignal(signal, candle, indicators) {
    try {
      // Call parent implementation
      const result = await super._handleSignal(signal, candle, indicators);

      // Track position in manager
      if (result && result.positionId) {
        this.positionManager.addPosition({
          id: result.positionId,
          symbol: this.symbol,
          side: signal,
          entry: candle.close,
          strategyKey: this.strategyKey,
          timestamp: new Date().getTime(),
        });

        console.log(
          `[${this.symbol}] Position tracked: ${result.positionId}`
        );
      }

      return result;
    } catch (err) {
      console.error(`[${this.symbol}] Signal handling error:`, err.message);
      throw err;
    }
  }

  /**
   * Sync positions from state to position manager
   */
  _checkOpenPositions() {
    if (!this.state || !this.state.openPositions) return;

    // Get positions tracked in state
    const statePositions = new Set(
      this.state.openPositions.map((p) => p.id)
    );

    // Get positions in manager
    const managerPositions = new Set(
      this.positionManager.getAll().map((p) => p.id)
    );

    // Remove positions closed in state
    for (const id of managerPositions) {
      if (!statePositions.has(id)) {
        this.positionManager.removePosition(id);
        console.log(`[${this.symbol}] Position removed from manager: ${id}`);
      }
    }

    // Add positions from state not in manager
    for (const pos of this.state.openPositions) {
      if (!managerPositions.has(pos.id)) {
        this.positionManager.addPosition({
          id: pos.id,
          symbol: this.symbol,
          side: pos.side,
          entry: pos.entry,
          strategyKey: this.strategyKey,
        });
        console.log(`[${this.symbol}] Position added to manager: ${pos.id}`);
      }
    }
  }

  /**
   * Override getState() to include AFS data
   */
  getState() {
    const baseState = super.getState();

    return {
      ...baseState,
      strategy: this.strategyKey,
      afsEnabled: true,
      rankings: this.getStrategyRankings(),
      positionConflicts: this.positionManager.checkEntryConflict(
        this.symbol
      ),
      positionManager: this.positionManager.getSummary(),
    };
  }

  /**
   * Get metrics for monitoring
   */
  getMetrics() {
    const baseMetrics = super.getMetrics();

    return {
      ...baseMetrics,
      strategy: this.strategyKey,
      positionsOpen: this.positionManager.positions.size,
      positionsMax: this.positionManager.maxTotalPositions,
      rankings: this.getStrategyRankings(),
    };
  }
}

module.exports = AdaptiveStrategyEngine;
