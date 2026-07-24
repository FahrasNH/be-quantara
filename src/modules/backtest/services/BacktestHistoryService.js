/**
 * BacktestHistoryService — strategy preset persistence only.
 * Backtest results are session-local; OHLC archive lives in candle_cache.
 */

const db = require("../../../infrastructure/db/database");

class BacktestHistoryService {
  static async savePreset(userId, name, strategyKey, parameters) {
    try {
      return await db.insertStrategyPreset({ userId, name, strategyKey, parameters });
    } catch (err) {
      console.error(`[BacktestHistory] Error saving preset: ${err.message}`);
      throw err;
    }
  }

  static async getPresets(userId) {
    try {
      return await db.getStrategyPresets(userId);
    } catch (err) {
      console.error(`[BacktestHistory] Error fetching presets: ${err.message}`);
      throw err;
    }
  }

  static async deletePreset(userId, presetId) {
    try {
      return await db.deleteStrategyPreset({ userId, presetId });
    } catch (err) {
      console.error(`[BacktestHistory] Error deleting preset: ${err.message}`);
      throw err;
    }
  }
}

module.exports = BacktestHistoryService;
