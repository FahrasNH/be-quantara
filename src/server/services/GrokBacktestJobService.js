/**
 * In-memory async Grok Confirm jobs for backtest — survives client disconnect.
 */

const crypto = require("crypto");
const GrokConfirmBatchProcessor = require("./GrokConfirmBatchProcessor");

const JOB_TTL_MS = 60 * 60 * 1000;
const jobs = new Map();

const cleanupTimer = setInterval(() => {
  GrokBacktestJobService._purgeExpired();
}, 5 * 60 * 1000);
if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

class GrokBacktestJobService {
  static createJob(userId, payload) {
    this._purgeExpired();
    const jobId = crypto.randomUUID();
    const total = Array.isArray(payload.signals) ? payload.signals.length : 0;

    jobs.set(jobId, {
      userId,
      status: "queued",
      progress: { done: 0, total },
      decisions: null,
      stats: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    setImmediate(() => {
      this._runJob(jobId, userId, payload).catch((err) => {
        const job = jobs.get(jobId);
        if (!job) return;
        job.status = "failed";
        job.error = err.message || String(err);
        job.updatedAt = Date.now();
      });
    });

    return jobId;
  }

  static getJob(userId, jobId) {
    this._purgeExpired();
    const job = jobs.get(jobId);
    if (!job || job.userId !== userId) return null;
    return job;
  }

  static toPublicJob(job) {
    return {
      status: job.status,
      progress: job.progress,
      ...(job.status === "done" ? { decisions: job.decisions, stats: job.stats } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  static async _runJob(jobId, userId, payload) {
    const job = jobs.get(jobId);
    if (!job) return;

    job.status = "processing";
    job.updatedAt = Date.now();

    const strategyKey = String(payload.strategy_key || payload.strategyKey || "").toUpperCase();
    const result = await GrokConfirmBatchProcessor.processBatch({
      userId,
      strategyKey,
      symbol: payload.symbol,
      signals: payload.signals,
      tpAdjust: payload.tpAdjust,
      tpBandPct: payload.tpBandPct,
      tpRejectAction: payload.tpRejectAction,
      onProgress: (done, total) => {
        job.progress = { done, total };
        job.updatedAt = Date.now();
      },
    });

    job.decisions = result.decisions;
    job.stats = result.stats;
    job.status = "done";
    job.updatedAt = Date.now();
  }

  static _purgeExpired() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
    }
  }

  /** @internal test helper */
  static _clearAll() {
    jobs.clear();
  }
}

module.exports = GrokBacktestJobService;
