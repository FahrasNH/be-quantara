/**
 * BacktestLoader Service
 * Loads and caches backtest data from CSV and JSON files
 * No external dependencies - uses native Node.js APIs
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

class BacktestLoader {
  constructor() {
    this.cache = {
      summary: {},      // symbol -> summary JSON
      equity: {},       // symbol -> array of equity points
      trades: {},       // symbol -> array of trades
      lastLoad: {},     // symbol -> timestamp
    };
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Load latest backtest summary for a symbol
   */
  async loadSummary(symbol) {
    if (this._isCacheValid(symbol)) {
      return this.cache.summary[symbol] || null;
    }

    const backtest_root = path.join(__dirname, "../../../..");
    const pattern = `backtest_summary_${symbol}_*.json`;
    const files = fs
      .readdirSync(backtest_root)
      .filter(f => f.match(new RegExp(pattern)))
      .sort()
      .reverse();

    if (!files.length) return null;

    try {
      const latestFile = path.join(backtest_root, files[0]);
      const content = fs.readFileSync(latestFile, "utf8");
      const summary = JSON.parse(content);
      this.cache.summary[symbol] = summary;
      this.cache.lastLoad[symbol] = Date.now();
      return summary;
    } catch (err) {
      console.error(`[BacktestLoader] Error loading ${symbol} summary:`, err.message);
      return null;
    }
  }

  /**
   * Load latest equity curve for a symbol
   */
  async loadEquityCurve(symbol) {
    if (this._isCacheValid(symbol) && this.cache.equity[symbol]) {
      return this.cache.equity[symbol];
    }

    const backtest_root = path.join(__dirname, "../../../..");
    const pattern = `backtest_equity_${symbol}_*.csv`;
    const files = fs
      .readdirSync(backtest_root)
      .filter(f => f.match(new RegExp(pattern)))
      .sort()
      .reverse();

    if (!files.length) return [];

    return new Promise((resolve) => {
      const latestFile = path.join(backtest_root, files[0]);
      const equity = [];
      let headers = [];
      let lineNum = 0;

      const rl = readline.createInterface({
        input: fs.createReadStream(latestFile),
        crlfDelay: Infinity,
      });

      rl.on("line", (line) => {
        lineNum++;
        if (lineNum === 1) {
          headers = line.split(",");
          return;
        }

        const values = line.split(",");
        const row = {};
        headers.forEach((h, i) => {
          row[h] = values[i];
        });

        equity.push({
          timestamp: row.timestamp,
          capital: parseFloat(row.capital),
          drawdown_pct: parseFloat(row.drawdown_pct),
          return_pct: parseFloat(row.return_pct),
          trades_count: parseInt(row.trades_count),
          wins: parseInt(row.wins),
          losses: parseInt(row.losses),
          win_rate_pct: parseFloat(row.win_rate_pct),
        });
      });

      rl.on("close", () => {
        this.cache.equity[symbol] = equity;
        this.cache.lastLoad[symbol] = Date.now();
        resolve(equity);
      });

      rl.on("error", (err) => {
        console.error(`[BacktestLoader] Error loading ${symbol} equity:`, err.message);
        resolve([]);
      });
    });
  }

  /**
   * Load latest trades for a symbol
   */
  async loadTrades(symbol) {
    if (this._isCacheValid(symbol) && this.cache.trades[symbol]) {
      return this.cache.trades[symbol];
    }

    const backtest_root = path.join(__dirname, "../../../..");
    const pattern = "backtest_trades_all_*.csv";
    const files = fs
      .readdirSync(backtest_root)
      .filter(f => f.match(new RegExp(pattern)))
      .sort()
      .reverse();

    if (!files.length) return [];

    return new Promise((resolve) => {
      const latestFile = path.join(backtest_root, files[0]);
      const trades = [];
      let headers = [];
      let lineNum = 0;

      const rl = readline.createInterface({
        input: fs.createReadStream(latestFile),
        crlfDelay: Infinity,
      });

      rl.on("line", (line) => {
        lineNum++;
        if (lineNum === 1) {
          headers = line.split(",");
          return;
        }

        const values = line.split(",");
        const row = {};
        headers.forEach((h, i) => {
          row[h] = values[i];
        });

        if (row.symbol === symbol) {
          trades.push({
            timestamp: row.timestamp,
            open_time: row.open_time,
            close_time: row.close_time,
            symbol: row.symbol,
            side: row.side,
            entry: parseFloat(row.entry),
            exit: parseFloat(row.exit),
            sl: parseFloat(row.sl),
            tp: parseFloat(row.tp),
            size: parseFloat(row.size),
            pnl: parseFloat(row.pnl),
            pnl_pct: parseFloat(row.pnl_pct),
            result: row.result,
            reason: row.reason,
            capital_before: parseFloat(row.capital_before),
            capital_after: parseFloat(row.capital_after),
            drawdown_at_close: parseFloat(row.drawdown_at_close),
            win_rate_pct: parseFloat(row.win_rate_pct),
            actual_risk_pct: parseFloat(row.actual_risk_pct),
          });
        }
      });

      rl.on("close", () => {
        this.cache.trades[symbol] = trades;
        resolve(trades);
      });

      rl.on("error", (err) => {
        console.error(`[BacktestLoader] Error loading ${symbol} trades:`, err.message);
        resolve([]);
      });
    });
  }

  /**
   * Get all latest backtest metrics
   */
  async getAllMetrics(symbols = []) {
    const metrics = {};
    for (const symbol of symbols) {
      const summary = await this.loadSummary(symbol);
      if (summary) {
        metrics[symbol] = summary.metrics;
      }
    }
    return metrics;
  }

  /**
   * Clear cache for a symbol or all symbols
   */
  clearCache(symbol = null) {
    if (!symbol) {
      this.cache = {
        summary: {},
        equity: {},
        trades: {},
        lastLoad: {},
      };
    } else {
      delete this.cache.summary[symbol];
      delete this.cache.equity[symbol];
      delete this.cache.trades[symbol];
      delete this.cache.lastLoad[symbol];
    }
  }

  /**
   * Check if cache is still valid
   */
  _isCacheValid(symbol) {
    const lastLoad = this.cache.lastLoad[symbol];
    if (!lastLoad) return false;
    return Date.now() - lastLoad < this.cacheTimeout;
  }
}

module.exports = new BacktestLoader();
