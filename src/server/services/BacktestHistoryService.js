/**
 * BacktestHistoryService.js
 * Service untuk mengelola penyimpanan dan pengambilan backtest history dari database
 */

const db = require("../../infrastructure/db/database");
const prisma = require("../../infrastructure/db/prismaClient");
const { ADMIN_ROLES } = require("../../middleware/adminGuard");
const {
  ENGINE_VERSION,
  buildCanonicalKey,
  filterSubset,
  resolveAction,
} = require("./BacktestCanonicalService");

class BacktestHistoryService {
  /**
   * Simpan hasil backtest ke database
   * @param {string} symbol - Trading pair (e.g., "BTCUSDT")
   * @param {object} metrics - Backtest metrics (win_rate, profit_factor, etc)
   * @param {array} equityCurve - Array of equity data points
   * @param {array} tradesData - Array of all trades
   * @param {object} config - Optional backtest configuration
   * @param {string} notes - Optional notes/description
   * @returns {number} - ID of inserted record
   */
  static async saveBacktest(symbol, metrics, equityCurve = null, tradesData = null, config = null, notes = null, meta = {}) {
    try {
      const id = await db.insertBacktestHistory({
        symbol,
        metrics,
        equityCurve,
        tradesData,
        config,
        notes,
        userId: meta.userId ?? null,
        strategyKey: meta.strategyKey ?? config?.strategyKey ?? null,
        timeframe: meta.timeframe ?? config?.timeframe ?? null,
        periodLabel: meta.periodLabel ?? config?.periodLabel ?? null,
      });

      console.log(`[BacktestHistory] Saved backtest for ${symbol} with ID ${id}`);
      return id;
    } catch (err) {
      console.error(`[BacktestHistory] Error saving backtest: ${err.message}`);
      throw err;
    }
  }

  /**
   * Ambil history backtest untuk symbol tertentu
   * @param {string} symbol - Trading pair
   * @param {number} limit - Max records to return
   * @returns {array} - Array of backtest history records
   */
  static async getHistory(symbol, limit = 20) {
    try {
      const records = await db.getBacktestHistory(symbol, limit);
      return records;
    } catch (err) {
      console.error(`[BacktestHistory] Error fetching history for ${symbol}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Ambil semua history dari semua symbols
   * @param {number} limit - Max records to return
   * @returns {array} - Array of all backtest history records
   */
  static async getAllHistory(limit = 50) {
    try {
      const records = await db.getAllBacktestHistory(limit);
      return records;
    } catch (err) {
      console.error(`[BacktestHistory] Error fetching all history: ${err.message}`);
      throw err;
    }
  }

  /**
   * Ambil detail history berdasarkan ID
   * @param {number} id - Record ID
   * @returns {object|null} - Backtest history record atau null
   */
  static async getById(id) {
    try {
      const record = await db.getBacktestHistoryById(id);
      return record;
    } catch (err) {
      console.error(`[BacktestHistory] Error fetching history by ID ${id}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Hitung statistik dari backtest history untuk symbol
   * @param {string} symbol - Trading pair
   * @returns {object} - Statistics object
   */
  static async getStatistics(symbol) {
    try {
      const history = await this.getHistory(symbol, 100);

      if (history.length === 0) {
        return {
          symbol,
          total_backtests: 0,
          avg_win_rate: 0,
          avg_profit_factor: 0,
          avg_roi: 0,
          best_roi: 0,
          worst_roi: 0,
        };
      }

      const metrics = history.map((h) => h.metrics);
      const winRates = metrics.map((m) => m.win_rate_pct || 0);
      const profitFactors = metrics.map((m) => m.profit_factor || 0);
      const rois = metrics.map((m) => m.roi_pct || 0);

      return {
        symbol,
        total_backtests: history.length,
        avg_win_rate: (winRates.reduce((a, b) => a + b, 0) / winRates.length).toFixed(2),
        avg_profit_factor: (profitFactors.reduce((a, b) => a + b, 0) / profitFactors.length).toFixed(3),
        avg_roi: (rois.reduce((a, b) => a + b, 0) / rois.length).toFixed(2),
        best_roi: Math.max(...rois).toFixed(2),
        worst_roi: Math.min(...rois).toFixed(2),
        latest_timestamp: history[0].timestamp,
      };
    } catch (err) {
      console.error(`[BacktestHistory] Error calculating statistics: ${err.message}`);
      throw err;
    }
  }

  static async getArchive(filters = {}) {
    try {
      return await db.getBacktestArchive(filters);
    } catch (err) {
      console.error(`[BacktestHistory] Error fetching archive: ${err.message}`);
      throw err;
    }
  }

  static async getByIds(ids) {
    try {
      return await db.getBacktestHistoryByIds(ids);
    } catch (err) {
      console.error(`[BacktestHistory] Error fetching by IDs: ${err.message}`);
      throw err;
    }
  }

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

  /**
   * Bandingkan dua backtest runs
   * @param {number} id1 - First backtest ID
   * @param {number} id2 - Second backtest ID
   * @returns {object} - Comparison object
   */
  static async _getCallerRole(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return user?.role || "USER";
  }

  static _assertCanDelete(record, userId, role) {
    if (!record) {
      const err = new Error("Backtest tidak ditemukan");
      err.statusCode = 404;
      throw err;
    }
    if (record.canonical_key || record.canonicalKey) {
      if (ADMIN_ROLES.includes(role)) return;
      const err = new Error("Forbidden — hanya admin bisa menghapus arsip shared");
      err.statusCode = 403;
      throw err;
    }
    if (ADMIN_ROLES.includes(role)) return;
    if (record.user_id === userId || record.user_id == null) return;
    const err = new Error("Forbidden — tidak bisa menghapus backtest pengguna lain");
    err.statusCode = 403;
    throw err;
  }

  static _buildKeyFromMeta({
    symbol, strategyKey, timeframe, parameters = {},
    enableFees = true, enableSlippage = false,
    exchange = "sim", dataSource = "sim", periodLabel = "500",
  }) {
    return buildCanonicalKey({
      symbol,
      strategyKey,
      timeframe,
      parameters,
      enableFees,
      enableSlippage,
      exchange,
      dataSource,
      periodLabel,
    });
  }

  /**
   * Lookup shared canonical archive — miss|reused|subset|extend
   */
  static async lookupCanonical({
    symbol,
    strategyKey,
    timeframe = "1d",
    parameters = {},
    enableFees = true,
    enableSlippage = false,
    exchange = "sim",
    dataSource = "sim",
    periodLabel = "500",
    requestedStart,
    requestedEnd,
  }) {
    const canonicalKey = this._buildKeyFromMeta({
      symbol, strategyKey, timeframe, parameters,
      enableFees, enableSlippage, exchange, dataSource, periodLabel,
    });

    const reqStartMs = Date.parse(requestedStart);
    const reqEndMs = Date.parse(requestedEnd);
    if (!Number.isFinite(reqStartMs) || !Number.isFinite(reqEndMs)) {
      const err = new Error("requested_start dan requested_end diperlukan (ISO date)");
      err.statusCode = 400;
      throw err;
    }

    const record = await db.findBacktestByCanonicalKey(canonicalKey);
    const action = resolveAction(record, reqStartMs, reqEndMs);

    if (action === "miss") {
      return { action, canonicalKey, id: null };
    }

    if (action === "extend") {
      return {
        action,
        canonicalKey,
        id: record.id,
        dataStart: record.data_start,
        dataEnd: record.data_end,
      };
    }

    await db.incrementBacktestHitCount(record.id);

    if (action === "subset") {
      const filtered = filterSubset(record, reqStartMs, reqEndMs);
      return {
        action,
        canonicalKey,
        id: record.id,
        metrics: filtered.metrics,
        trades: filtered.trades,
        equity_curve: filtered.equity,
        dataStart: record.data_start,
        dataEnd: record.data_end,
        hitCount: (record.hit_count ?? 1) + 1,
      };
    }

    return {
      action: "reused",
      canonicalKey,
      id: record.id,
      metrics: record.metrics,
      trades: record.trades_data,
      equity_curve: record.equity_curve,
      dataStart: record.data_start,
      dataEnd: record.data_end,
      hitCount: (record.hit_count ?? 1) + 1,
    };
  }

  /**
   * Simpan atau perbarui row canonical shared (INSERT / UPDATE in-place)
   */
  static async saveOrUpdateCanonical({
    symbol,
    strategyKey,
    timeframe = "1d",
    periodLabel = "500",
    parameters = {},
    enableFees = true,
    enableSlippage = false,
    exchange = "sim",
    dataSource = "sim",
    metrics,
    equityCurve = null,
    tradesData = null,
    config = null,
    notes = null,
    userId = null,
    dataStart = null,
    dataEnd = null,
    action = null,
  }) {
    const canonicalKey = this._buildKeyFromMeta({
      symbol, strategyKey, timeframe, parameters,
      enableFees, enableSlippage, exchange, dataSource, periodLabel,
    });

    const existing = await db.findBacktestByCanonicalKey(canonicalKey);

    if (action === "reused" && existing) {
      await db.incrementBacktestHitCount(existing.id);
      return existing.id;
    }

    if (existing && action !== "extend" && dataStart && dataEnd) {
      const resolved = resolveAction(existing, Date.parse(dataStart), Date.parse(dataEnd));
      if (resolved === "reused") {
        await db.incrementBacktestHitCount(existing.id);
        return existing.id;
      }
    }

    if (existing && (action === "extend" || resolveAction(
      existing,
      Date.parse(dataStart),
      Date.parse(dataEnd),
    ) === "extend")) {
      const id = await db.updateBacktestHistory(existing.id, {
        metrics,
        equityCurve,
        tradesData,
        config,
        dataStart,
        dataEnd,
        engineVersion: ENGINE_VERSION,
      });
      return id ?? existing.id;
    }

    const runConfig = {
      ...(config || {}),
      strategyKey,
      timeframe,
      periodLabel,
      parameters,
      enableFees,
      enableSlippage,
      exchange,
      dataSource,
    };

    const id = await db.upsertBacktestHistory({
      symbol,
      metrics,
      equityCurve,
      tradesData,
      config: runConfig,
      notes,
      userId,
      strategyKey,
      timeframe,
      periodLabel,
      canonicalKey,
      dataStart,
      dataEnd,
      engineVersion: ENGINE_VERSION,
      createdByUserId: userId,
    });

    console.log(`[BacktestHistory] Canonical ${existing ? "updated" : "saved"} ${symbol}/${strategyKey} id=${id}`);
    return id;
  }

  static async deleteRun(id, userId) {
    try {
      const record = await this.getById(id);
      const role = await this._getCallerRole(userId);
      this._assertCanDelete(record, userId, role);
      const removed = await db.deleteBacktestHistoryById(id);
      if (!removed) {
        const err = new Error("Backtest tidak ditemukan");
        err.statusCode = 404;
        throw err;
      }
      return { deleted: true, id };
    } catch (err) {
      console.error(`[BacktestHistory] Error deleting run ${id}: ${err.message}`);
      throw err;
    }
  }

  static async deleteRuns(ids, userId) {
    try {
      const uniqueIds = [...new Set(ids.map(Number).filter(Number.isFinite))];
      if (!uniqueIds.length) {
        const err = new Error("ids diperlukan");
        err.statusCode = 400;
        throw err;
      }

      const records = await db.getBacktestHistoryByIds(uniqueIds);
      const foundIds = new Set(records.map(r => r.id));
      const missing = uniqueIds.filter(id => !foundIds.has(id));
      if (missing.length) {
        const err = new Error(`Backtest tidak ditemukan: ${missing.join(", ")}`);
        err.statusCode = 404;
        throw err;
      }

      const role = await this._getCallerRole(userId);
      for (const record of records) {
        this._assertCanDelete(record, userId, role);
      }

      const deleted = await db.deleteBacktestHistoryByIds(uniqueIds);
      return { deleted, ids: uniqueIds };
    } catch (err) {
      console.error(`[BacktestHistory] Error bulk deleting runs: ${err.message}`);
      throw err;
    }
  }

  static async compareBacktests(id1, id2) {
    try {
      const bt1 = await this.getById(id1);
      const bt2 = await this.getById(id2);

      if (!bt1 || !bt2) {
        throw new Error("One or both backtest records not found");
      }

      const m1 = bt1.metrics;
      const m2 = bt2.metrics;

      return {
        backtest_1: {
          id: bt1.id,
          symbol: bt1.symbol,
          timestamp: bt1.timestamp,
          metrics: m1,
        },
        backtest_2: {
          id: bt2.id,
          symbol: bt2.symbol,
          timestamp: bt2.timestamp,
          metrics: m2,
        },
        comparison: {
          win_rate_diff: ((m2.win_rate_pct || 0) - (m1.win_rate_pct || 0)).toFixed(2),
          profit_factor_diff: ((m2.profit_factor || 0) - (m1.profit_factor || 0)).toFixed(3),
          roi_diff: ((m2.roi_pct || 0) - (m1.roi_pct || 0)).toFixed(2),
          net_pnl_diff: ((m2.net_pnl || 0) - (m1.net_pnl || 0)).toFixed(2),
          max_drawdown_diff: ((m2.max_drawdown_pct || 0) - (m1.max_drawdown_pct || 0)).toFixed(2),
        },
      };
    } catch (err) {
      console.error(`[BacktestHistory] Error comparing backtests: ${err.message}`);
      throw err;
    }
  }
}

module.exports = BacktestHistoryService;
