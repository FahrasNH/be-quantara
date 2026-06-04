/**
 * ReportGeneratorService.js
 * Service untuk menghasilkan laporan backtest dalam berbagai format
 */

const BacktestLoader = require("./BacktestLoader");
const BacktestHistoryService = require("./BacktestHistoryService");

class ReportGeneratorService {
  /**
   * Generate laporan dalam format PDF (sebagai HTML, akan dikonversi di browser)
   */
  static async generatePDFReport(symbol, backtest_id = null, options = {}) {
    try {
      const data = await this._getReportData(symbol, backtest_id);
      const html = this._generateHTMLReport(data, options);
      return html;
    } catch (err) {
      console.error(`[ReportGenerator] Error generating PDF report: ${err.message}`);
      throw err;
    }
  }

  /**
   * Generate laporan dalam format JSON
   */
  static async generateJSONReport(symbol, backtest_id = null, options = {}) {
    try {
      const data = await this._getReportData(symbol, backtest_id);
      return {
        report_type: "JSON",
        generated_at: new Date().toISOString(),
        ...data,
        options,
      };
    } catch (err) {
      console.error(`[ReportGenerator] Error generating JSON report: ${err.message}`);
      throw err;
    }
  }

  /**
   * Generate laporan dalam format HTML
   */
  static async generateHTMLReport(symbol, backtest_id = null, options = {}) {
    try {
      const data = await this._getReportData(symbol, backtest_id);
      return this._generateHTMLReport(data, options);
    } catch (err) {
      console.error(`[ReportGenerator] Error generating HTML report: ${err.message}`);
      throw err;
    }
  }

  /**
   * Ambil data untuk laporan
   */
  static async _getReportData(symbol, backtest_id = null) {
    if (backtest_id) {
      const backtest = BacktestHistoryService.getById(backtest_id);
      if (!backtest) throw new Error(`Backtest ${backtest_id} not found`);
      return {
        symbol: backtest.symbol,
        timestamp: backtest.timestamp,
        metrics: backtest.metrics,
        equity_curve: backtest.equity_curve || [],
        trades_data: backtest.trades_data || [],
        config: backtest.config || {},
      };
    } else {
      const summary = await BacktestLoader.loadSummary(symbol);
      const equity = await BacktestLoader.loadEquityCurve(symbol);
      const trades = await BacktestLoader.loadTrades(symbol);

      if (!summary) throw new Error(`No backtest data found for ${symbol}`);

      return {
        symbol,
        timestamp: summary.timestamp_generated || new Date().toISOString(),
        metrics: summary.metrics || {},
        equity_curve: equity || [],
        trades_data: trades || [],
        config: {},
      };
    }
  }

  /**
   * Generate HTML report template
   */
  static _generateHTMLReport(data, options = {}) {
    const { include_charts = true, include_trade_details = true } = options;

    const metricsTable = Object.entries(data.metrics)
      .map(
        ([key, value]) =>
          `<tr>
        <td style="padding:8px;border-bottom:1px solid #ddd">${key.replace(/_/g, " ").toUpperCase()}</td>
        <td style="padding:8px;border-bottom:1px solid #ddd;text-align:right">
          ${typeof value === "number" ? value.toFixed(4) : value || "N/A"}
        </td>
      </tr>`
      )
      .join("");

    const tradesRows =
      include_trade_details && data.trades_data && data.trades_data.length > 0
        ? data.trades_data
            .slice(0, 50) // Limit to first 50 trades
            .map(
              (trade) =>
                `<tr>
          <td style="padding:6px;border-bottom:1px solid #eee;font-size:11px">${trade.timestamp || "N/A"}</td>
          <td style="padding:6px;border-bottom:1px solid #eee;font-size:11px">${trade.side || "N/A"}</td>
          <td style="padding:6px;border-bottom:1px solid #eee;font-size:11px;text-align:right">${trade.entry || "N/A"}</td>
          <td style="padding:6px;border-bottom:1px solid #eee;font-size:11px;text-align:right">${trade.exit || "N/A"}</td>
          <td style="padding:6px;border-bottom:1px solid #eee;font-size:11px;text-align:right">${
                trade.pnl ? (trade.pnl > 0 ? "+" : "") + trade.pnl.toFixed(2) : "N/A"
              }</td>
          <td style="padding:6px;border-bottom:1px solid #eee;font-size:11px;color:${trade.pnl > 0 ? "green" : "red"}">
            ${trade.result || "N/A"}
          </td>
        </tr>`
            )
            .join("")
        : `<tr><td colspan="6" style="padding:12px;text-align:center;color:#999">No trade data</td></tr>`;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Backtest Report - ${data.symbol}</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 20px;
      background: #f5f5f5;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .header {
      border-bottom: 2px solid #333;
      margin-bottom: 20px;
      padding-bottom: 10px;
    }
    .header h1 {
      margin: 0;
      font-size: 28px;
      color: #1a1a2e;
    }
    .header p {
      margin: 5px 0 0 0;
      color: #666;
      font-size: 14px;
    }
    .section {
      margin-bottom: 30px;
    }
    .section h2 {
      font-size: 18px;
      color: #1a1a2e;
      border-bottom: 1px solid #ddd;
      padding-bottom: 8px;
      margin-bottom: 15px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #f9f9f9;
    }
    th {
      background: #e4e1f5;
      padding: 10px;
      text-align: left;
      font-weight: 600;
      color: #1a1a2e;
    }
    td {
      padding: 8px;
      border-bottom: 1px solid #ddd;
    }
    .metric-row {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 15px;
      margin-bottom: 15px;
    }
    .metric-card {
      background: #f9f9f9;
      padding: 12px;
      border-radius: 4px;
      border-left: 4px solid #6c5ce7;
    }
    .metric-label {
      font-size: 11px;
      font-weight: 600;
      color: #666;
      text-transform: uppercase;
    }
    .metric-value {
      font-size: 16px;
      font-weight: 700;
      color: #1a1a2e;
      margin-top: 4px;
    }
    .footer {
      margin-top: 30px;
      padding-top: 15px;
      border-top: 1px solid #ddd;
      font-size: 12px;
      color: #999;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Backtest Report</h1>
      <p><strong>Symbol:</strong> ${data.symbol} | <strong>Generated:</strong> ${new Date(data.timestamp).toLocaleString()}</p>
    </div>

    <!-- Summary Metrics -->
    <div class="section">
      <h2>Summary Metrics</h2>
      <div class="metric-row">
        <div class="metric-card">
          <div class="metric-label">Win Rate</div>
          <div class="metric-value">${data.metrics.win_rate_pct?.toFixed(2) || "N/A"}%</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Profit Factor</div>
          <div class="metric-value">${data.metrics.profit_factor?.toFixed(3) || "N/A"}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Total Trades</div>
          <div class="metric-value">${data.metrics.total_trades || "N/A"}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Net PnL</div>
          <div class="metric-value">$${data.metrics.net_pnl?.toFixed(2) || "N/A"}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Max Drawdown</div>
          <div class="metric-value">${data.metrics.max_drawdown_pct?.toFixed(2) || "N/A"}%</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Sharpe Ratio</div>
          <div class="metric-value">${data.metrics.sharpe_ratio?.toFixed(3) || "N/A"}</div>
        </div>
      </div>
    </div>

    <!-- Detailed Metrics -->
    <div class="section">
      <h2>Detailed Metrics</h2>
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th style="text-align:right">Value</th>
          </tr>
        </thead>
        <tbody>
          ${metricsTable}
        </tbody>
      </table>
    </div>

    <!-- Trades Table -->
    ${
      include_trade_details
        ? `
    <div class="section">
      <h2>Trade Details (First 50)</h2>
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Side</th>
            <th style="text-align:right">Entry</th>
            <th style="text-align:right">Exit</th>
            <th style="text-align:right">PnL</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          ${tradesRows}
        </tbody>
      </table>
    </div>
    `
        : ""
    }

    <div class="footer">
      <p>This report was automatically generated by Quantara Backtest System</p>
      <p>© 2026 Bot Trading | All rights reserved</p>
    </div>
  </div>
</body>
</html>
    `;
  }

  /**
   * Send laporan via email
   */
  static async sendReportEmail(symbol, backtest_id = null, email = null, options = {}) {
    if (!email) {
      throw new Error("Email address is required");
    }

    try {
      const data = await this._getReportData(symbol, backtest_id);
      const htmlContent = this._generateHTMLReport(data, options);

      // TODO: Integrate dengan email service (nodemailer, SendGrid, etc)
      // Untuk sekarang, cukup log dan return success message
      console.log(`[ReportGenerator] Would send report for ${symbol || backtest_id} to ${email}`);

      return {
        ok: true,
        message: `Report for ${symbol || `backtest #${backtest_id}`} would be sent to ${email}`,
        email,
      };
    } catch (err) {
      console.error(`[ReportGenerator] Error sending report email: ${err.message}`);
      throw err;
    }
  }
}

module.exports = ReportGeneratorService;
