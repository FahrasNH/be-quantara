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
const { calcIndicators } = require("../domain/indicators");

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

    // BotEngine hanya menyimpan this.config.symbol, tidak this.symbol.
    // Kita set eksplisit agar semua method di class ini bisa pakai this.symbol.
    this.symbol = this.config.symbol;

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
          symbol: this.config.symbol,
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

      // Guard: rankByMarketConditions pada beberapa strategi bisa return null/object bukan array
      if (!Array.isArray(rankings)) return null;

      // Add activation check
      return rankings.map((r) => {
        const canActivate = this.strategy.canActivate(
          this.capital || this.config.capital,
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
   * Override _tick() for AFS multi-strategy scanning.
   *
   * Bug fixes (v2.2):
   *  1. _fetchLatestKlines() tidak ada di BotEngine → pakai this._fetchCandles()
   *  2. _calculateIndicators() tidak ada → pakai calcIndicators() (imported)
   *  3. lastIdx = klines.length-1 salah → pakai candles.length-2 (candle terkonfirmasi)
   *  4. this.symbol undefined → this.config.symbol (BotEngine tidak set this.symbol)
   *  5. _handleSignal dipanggil dengan (signal,candle,indicators) → (signal,price,atr,snap,opts)
   */
  async _tick() {
    try {
      // 1. Ambil data candle — method BotEngine yang benar
      const candles = await this._fetchCandles();
      if (!candles || candles.length < this.config.emaSlow + 20) return;

      // 2. Hitung indikator — fungsi domain (bukan method instance)
      const indicators = calcIndicators(candles, {
        emaFast:   this.config.emaFast,
        emaSlow:   this.config.emaSlow,
        emaTrend:  this.config.emaTrend,
        rsiPeriod: this.config.rsiPeriod,
        atrPeriod: this.config.atrPeriod,
      });

      // 3. Gunakan candle terkonfirmasi (n-2), sama seperti BotEngine parent
      const lastIdx = candles.length - 2;

      // 4. Hitung volatility & trend_strength dari data nyata
      {
        const price  = candles[lastIdx].close;
        const atr    = indicators.atr?.[lastIdx];
        const emaF   = indicators.emaFast?.[lastIdx];
        const emaS   = indicators.emaSlow?.[lastIdx];
        this.lastVolatility    = atr && price ? (atr / price) * 100 : 1.0;
        const emaDelta         = emaS > 0 ? Math.abs(emaF - emaS) / emaS : 0;
        this.lastTrendStrength = Math.min(emaDelta * 50, 1.0);
      }

      // 5. Deteksi sinyal
      const signal = this.strategy.detectSignal(indicators, lastIdx, {
        balance:        this.capital || this.config.capital,
        volatility:     this.lastVolatility,
        trend_strength: this.lastTrendStrength,
        htfTrend:       "NEUTRAL",
      });

      if (!signal) return;

      // 6. Cek konflik posisi — gunakan this.config.symbol
      const conflict = this.positionManager.checkEntryConflict(this.config.symbol);
      if (!conflict.allowed) {
        console.log(`[${this.config.symbol}] Position conflict: ${conflict.reason}`);
        return;
      }

      // 7. Validasi entry
      const price = candles[lastIdx].close;
      const atr   = indicators.atr[lastIdx];
      const validation = this.strategy.validateEntry(
        price,
        atr,
        candles[lastIdx].volume,
        indicators.volSMA?.[lastIdx] || 0
      );

      if (!validation.valid) {
        console.log(`[${this.config.symbol}] Entry validation failed: ${validation.reason}`);
        return;
      }

      // 8. Eksekusi — signature BotEngine: (signal, price, atr, indicatorSnapshot, options)
      await this._handleSignal(signal, price, atr, indicators);
    } catch (err) {
      console.error(`[${this.config.symbol}] Tick error:`, err.message);
    }
  }

  /**
   * Override _handleSignal() to track positions.
   * Signature harus sama dengan BotEngine: (signal, price, atr, indicatorSnapshot, options)
   */
  async _handleSignal(signal, price, atr, indicatorSnapshot = null, options = {}) {
    try {
      // Panggil parent dengan signature yang benar
      const result = await super._handleSignal(signal, price, atr, indicatorSnapshot, options);

      // Track position di manager
      if (result && result.positionId) {
        this.positionManager.addPosition({
          id: result.positionId,
          symbol: this.config.symbol,
          side: signal,
          entry: price,
          strategyKey: this.strategyKey,
          timestamp: new Date().getTime(),
        });

        console.log(`[${this.config.symbol}] Position tracked: ${result.positionId}`);
      }

      return result;
    } catch (err) {
      console.error(`[${this.config.symbol}] Signal handling error:`, err.message);
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
        console.log(`[${this.config.symbol}] Position removed from manager: ${id}`);
      }
    }

    // Add positions from state not in manager
    for (const pos of this.state.openPositions) {
      if (!managerPositions.has(pos.id)) {
        this.positionManager.addPosition({
          id: pos.id,
          symbol: this.config.symbol,
          side: pos.side,
          entry: pos.entry,
          strategyKey: this.strategyKey,
        });
        console.log(`[${this.config.symbol}] Position added to manager: ${pos.id}`);
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
        this.config.symbol
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
