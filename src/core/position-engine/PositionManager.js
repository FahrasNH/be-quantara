/**
 * ─────────────────────────────────────────────
 * PositionManager.js — Position Tracking & Conflict Detection
 *
 * Tracks all open positions and detects conflicts:
 * - Max 1 position per coin
 * - Max 1-2 total positions
 * - Tracks positions per strategy
 * ─────────────────────────────────────────────
 */

class PositionManager {
  constructor(maxTotalPositions = 2) {
    this.maxTotalPositions = maxTotalPositions;
    this.maxPerSymbol = 1; // Hard limit: 1 position per coin

    // Data structures for O(1) lookups
    this.positions = new Map(); // id -> position
    this.positionsBySymbol = new Map(); // symbol -> [ids]
    this.positionsByStrategy = new Map(); // strategyKey -> [ids]
  }

  /**
   * Add a new position
   * @param {Object} position - { id, symbol, side, entry, strategyKey, ... }
   */
  addPosition(position) {
    if (!position || !position.id || !position.symbol) {
      throw new Error("Position must have id and symbol");
    }

    const { id, symbol, strategyKey } = position;

    // Store position
    this.positions.set(id, position);

    // Track by symbol
    if (!this.positionsBySymbol.has(symbol)) {
      this.positionsBySymbol.set(symbol, []);
    }
    this.positionsBySymbol.get(symbol).push(id);

    // Track by strategy
    if (strategyKey) {
      if (!this.positionsByStrategy.has(strategyKey)) {
        this.positionsByStrategy.set(strategyKey, []);
      }
      this.positionsByStrategy.get(strategyKey).push(id);
    }

    return this;
  }

  /**
   * Remove a position (when trade closes)
   * @param {string} id - Position ID
   */
  removePosition(id) {
    const position = this.positions.get(id);
    if (!position) return this;

    const { symbol, strategyKey } = position;

    // Remove from main map
    this.positions.delete(id);

    // Remove from symbol index
    const symbolPositions = this.positionsBySymbol.get(symbol);
    if (symbolPositions) {
      const idx = symbolPositions.indexOf(id);
      if (idx > -1) symbolPositions.splice(idx, 1);
      if (symbolPositions.length === 0) {
        this.positionsBySymbol.delete(symbol);
      }
    }

    // Remove from strategy index
    if (strategyKey) {
      const strategyPositions = this.positionsByStrategy.get(strategyKey);
      if (strategyPositions) {
        const idx = strategyPositions.indexOf(id);
        if (idx > -1) strategyPositions.splice(idx, 1);
        if (strategyPositions.length === 0) {
          this.positionsByStrategy.delete(strategyKey);
        }
      }
    }

    return this;
  }

  /**
   * Check if can open new position
   * Returns: { allowed: bool, reason: string }
   */
  canOpenNewPosition(symbol, maxTotalPositions = null) {
    const maxTotal = maxTotalPositions || this.maxTotalPositions;
    const totalOpen = this.positions.size;
    const hasSymbolPosition = this.hasOpenPositionForSymbol(symbol);

    // Rule 1: Max positions total
    if (totalOpen >= maxTotal) {
      return {
        allowed: false,
        reason: `Max ${maxTotal} positions reached (currently ${totalOpen})`,
      };
    }

    // Rule 2: Max 1 position per coin
    if (hasSymbolPosition) {
      return {
        allowed: false,
        reason: `Already have position in ${symbol}`,
      };
    }

    return { allowed: true, reason: "Can open new position" };
  }

  /**
   * Check if symbol already has an open position
   */
  hasOpenPositionForSymbol(symbol) {
    const positions = this.positionsBySymbol.get(symbol);
    return positions && positions.length > 0;
  }

  /**
   * Get detailed entry conflict check
   */
  checkEntryConflict(symbol) {
    const symbolPositions = this.positionsBySymbol.get(symbol);
    const totalOpen = this.positions.size;
    const canAdd = this.canOpenNewPosition(symbol);

    return {
      allowed: canAdd.allowed,
      reason: canAdd.reason,
      totalOpen,
      maxTotal: this.maxTotalPositions,
      symbolPositions: symbolPositions ? symbolPositions.length : 0,
      maxPerSymbol: this.maxPerSymbol,
    };
  }

  /**
   * Get all positions
   */
  getAll() {
    return Array.from(this.positions.values());
  }

  /**
   * Get positions by symbol
   */
  getBySymbol(symbol) {
    const ids = this.positionsBySymbol.get(symbol) || [];
    return ids.map((id) => this.positions.get(id));
  }

  /**
   * Get positions by strategy
   */
  getByStrategy(strategyKey) {
    const ids = this.positionsByStrategy.get(strategyKey) || [];
    return ids.map((id) => this.positions.get(id));
  }

  /**
   * Get UI-friendly summary
   */
  getSummary() {
    return {
      total: this.positions.size,
      maxTotal: this.maxTotalPositions,
      bySymbol: Object.fromEntries(this.positionsBySymbol),
      byStrategy: Object.fromEntries(this.positionsByStrategy),
      positions: this.getAll().map((p) => ({
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        entry: p.entry,
        strategy: p.strategyKey,
      })),
    };
  }

  /**
   * For logging/debugging
   */
  toJSON() {
    return {
      totalPositions: this.positions.size,
      maxTotal: this.maxTotalPositions,
      positions: this.getAll(),
    };
  }

  /**
   * Clear all positions (for testing/reset)
   */
  clear() {
    this.positions.clear();
    this.positionsBySymbol.clear();
    this.positionsByStrategy.clear();
    return this;
  }
}

module.exports = PositionManager;
