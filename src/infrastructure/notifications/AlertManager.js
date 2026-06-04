/**
 * Alert Manager — manages alerts and notification routing
 * Handles deduplication, throttling, and multiple channels
 */

class AlertManager {
  constructor(notifiers = []) {
    this.notifiers = notifiers; // Array of notifier instances (Telegram, Email, Slack, etc)
    this.recentAlerts = new Map(); // Track recent alerts to avoid spam
    this.alertThrottleMs = 60000; // Don't send same alert more than once per minute
  }

  /**
   * Send alert through all registered notifiers
   * @param {string} level - 'info', 'warning', 'critical'
   * @param {string} message - Alert message
   * @param {object} metadata - Additional context
   */
  async alert(level, message, metadata = {}) {
    const alertKey = this._generateAlertKey(level, message);
    const lastAlert = this.recentAlerts.get(alertKey);

    // Throttle duplicate alerts
    if (lastAlert && Date.now() - lastAlert < this.alertThrottleMs) {
      return; // Skip sending duplicate alert
    }

    this.recentAlerts.set(alertKey, Date.now());

    // Format alert message
    const formattedAlert = this._formatAlert(level, message, metadata);

    // Send through all notifiers
    const results = await Promise.allSettled(
      this.notifiers.map(notifier => notifier.send(formattedAlert, level, metadata))
    );

    // Log any failures
    results.forEach((result, idx) => {
      if (result.status === "rejected") {
        console.error(`[ALERT] Notifier ${idx} failed:`, result.reason.message);
      }
    });
  }

  /**
   * Send info-level alert (non-critical)
   */
  async info(message, metadata = {}) {
    return this.alert("info", message, metadata);
  }

  /**
   * Send warning-level alert
   */
  async warning(message, metadata = {}) {
    return this.alert("warning", message, metadata);
  }

  /**
   * Send critical-level alert (requires immediate attention)
   */
  async critical(message, metadata = {}) {
    return this.alert("critical", message, metadata);
  }

  /**
   * Send trade notification (special alert type)
   */
  async notifyTrade(side, symbol, entry, exit, pnl, reason) {
    const emoji = pnl > 0 ? "🎉" : "😢";
    const message = `${emoji} ${side} ${symbol} | Entry: $${entry.toFixed(2)} | Exit: $${exit.toFixed(2)} | PnL: $${pnl.toFixed(2)} (${reason})`;
    return this.alert("info", message, { type: "trade", symbol, side, pnl });
  }

  /**
   * Send error notification
   */
  async notifyError(source, error) {
    const message = `⚠️ ERROR in ${source}: ${error.message}`;
    return this.alert("warning", message, { type: "error", source });
  }

  /**
   * Generate cache key for alert deduplication
   */
  _generateAlertKey(level, message) {
    return `${level}:${message.substring(0, 100)}`; // First 100 chars
  }

  /**
   * Format alert with emoji and timestamp
   */
  _formatAlert(level, message, metadata = {}) {
    const emoji = {
      info: "ℹ️",
      warning: "⚠️",
      critical: "🚨",
    }[level] || "📢";

    const timestamp = new Date().toISOString();
    return `${emoji} [${timestamp}] ${message}`;
  }

  /**
   * Add a notifier
   */
  addNotifier(notifier) {
    this.notifiers.push(notifier);
  }

  /**
   * Remove a notifier
   */
  removeNotifier(notifier) {
    const idx = this.notifiers.indexOf(notifier);
    if (idx > -1) this.notifiers.splice(idx, 1);
  }

  /**
   * Clear recent alerts cache
   */
  clearCache() {
    this.recentAlerts.clear();
  }
}

module.exports = AlertManager;
