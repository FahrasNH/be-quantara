/**
 * Health Check System — monitors bot health and system status
 * Provides comprehensive health data for monitoring & alerting
 */

const os = require("os");
const { performance } = require("perf_hooks");

class HealthChecker {
  constructor(options = {}) {
    this.startTime = Date.now();
    this.options = {
      checkInterval: options.checkInterval || 60000, // 1 minute
      alertThresholds: {
        errorRatePercent: 0.05, // 5% error rate
        memoryUsagePercent: 0.85, // 85% memory
        cpuUsagePercent: 0.80, // 80% CPU
        exchangeLatencyMs: 10000, // 10 second API latency
      },
      ...options.alertThresholds,
    };

    this.metrics = {
      requests: 0,
      errors: 0,
      lastCheck: null,
      uptime: 0,
      memory: {},
      cpu: {},
      bots: {},
      database: { healthy: false, latency: 0 },
      exchange: { healthy: false, latency: 0 },
      alerts: [],
    };

    this.startChecking();
  }

  startChecking() {
    this.checkInterval = setInterval(() => this.performHealthCheck(), this.options.checkInterval);
  }

  stopChecking() {
    if (this.checkInterval) clearInterval(this.checkInterval);
  }

  /**
   * Perform comprehensive health check
   */
  performHealthCheck() {
    this.metrics.lastCheck = new Date().toISOString();
    this.metrics.uptime = Math.floor((Date.now() - this.startTime) / 1000);

    // System metrics
    this._checkSystemResources();

    // Generate alerts
    this._evaluateAlerts();
  }

  /**
   * Check system resource usage
   */
  _checkSystemResources() {
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    this.metrics.memory = {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      rss: Math.round(memUsage.rss / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024),
      systemUsagePercent: Math.round((1 - freeMem / totalMem) * 100),
    };

    const cpus = os.cpus();
    const avgLoad = os.loadavg();
    this.metrics.cpu = {
      cores: cpus.length,
      model: cpus[0]?.model || "Unknown",
      load1Min: avgLoad[0],
      load5Min: avgLoad[1],
      load15Min: avgLoad[2],
      usagePercent: Math.round((avgLoad[0] / cpus.length) * 100),
    };
  }

  /**
   * Evaluate health and generate alerts
   */
  _evaluateAlerts() {
    this.metrics.alerts = [];

    const { errorRatePercent, memoryUsagePercent, cpuUsagePercent } = this.options.alertThresholds;

    // Error rate check
    if (this.metrics.requests > 0) {
      const errorRate = this.metrics.errors / this.metrics.requests;
      if (errorRate > errorRatePercent) {
        this.metrics.alerts.push({
          level: "warning",
          type: "HIGH_ERROR_RATE",
          message: `Error rate is ${(errorRate * 100).toFixed(1)}% (threshold: ${(errorRatePercent * 100)}%)`,
          value: errorRate,
          threshold: errorRatePercent,
        });
      }
    }

    // Memory check
    const memPercent = this.metrics.memory.systemUsagePercent / 100;
    if (memPercent > memoryUsagePercent) {
      this.metrics.alerts.push({
        level: "warning",
        type: "HIGH_MEMORY_USAGE",
        message: `Memory usage is ${(memPercent * 100).toFixed(1)}% (threshold: ${(memoryUsagePercent * 100)}%)`,
        value: memPercent,
        threshold: memoryUsagePercent,
      });
    }

    // CPU check
    const cpuPercent = this.metrics.cpu.usagePercent / 100;
    if (cpuPercent > cpuUsagePercent) {
      this.metrics.alerts.push({
        level: "warning",
        type: "HIGH_CPU_USAGE",
        message: `CPU usage is ${(cpuPercent * 100).toFixed(1)}% (threshold: ${(cpuUsagePercent * 100)}%)`,
        value: cpuPercent,
        threshold: cpuUsagePercent,
      });
    }
  }

  /**
   * Record request metrics
   */
  recordRequest(success = true) {
    this.metrics.requests++;
    if (!success) this.metrics.errors++;
  }

  /**
   * Update bot status in health metrics
   */
  updateBotStatus(symbol, botState) {
    this.metrics.bots[symbol] = {
      running: botState.running,
      lastCheck: botState.lastTick,
      capital: botState.capital,
      roi: botState.openPositions ? botState.openPositions.length : 0,
      errors: botState.errors || 0,
      totalTrades: botState.totalTrades || 0,
      winRate: botState.winRate || 0,
    };
  }

  /**
   * Mark database health
   */
  setDatabaseHealth(healthy, latency = 0) {
    this.metrics.database = { healthy, latency };
  }

  /**
   * Mark exchange health
   */
  setExchangeHealth(healthy, latency = 0) {
    this.metrics.exchange = { healthy, latency };
  }

  /**
   * Get full health status
   */
  getStatus() {
    return {
      ok: this.isHealthy(),
      timestamp: new Date().toISOString(),
      uptime: this.metrics.uptime,
      status: this._determineOverallStatus(),
      metrics: this.metrics,
      alerts: this.metrics.alerts,
      isHealthy: this.isHealthy(),
    };
  }

  /**
   * Check if system is overall healthy
   */
  isHealthy() {
    // Healthy if no critical alerts
    return !this.metrics.alerts.some(a => a.level === "critical");
  }

  /**
   * Determine overall status: "healthy", "degraded", "critical"
   */
  _determineOverallStatus() {
    if (this.metrics.alerts.length === 0) return "healthy";
    if (this.metrics.alerts.some(a => a.level === "critical")) return "critical";
    return "degraded";
  }
}

module.exports = HealthChecker;
