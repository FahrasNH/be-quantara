/**
 * In-memory async Grok Confirm jobs for backtest — survives client disconnect.
 * Checkpoint partial decisions agar resume setelah overload/restart PM2 tidak dari 0.
 */

const crypto = require("crypto");
const GrokConfirmBatchProcessor = require("./GrokConfirmBatchProcessor");

const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_JOB_LOGS = 200;
const jobs = new Map();
/** Dedup job aktif per user+strategi+simbol — cegah double POST saat overload */
const activeJobIndex = new Map();

const cleanupTimer = setInterval(() => {
  GrokBacktestJobService._purgeExpired();
}, 5 * 60 * 1000);
if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

function jobIndexKey(userId, strategyKey, symbol) {
  return `${userId}:${String(strategyKey || "").toUpperCase()}:${symbol || ""}`;
}

function computeStats(decisions, total) {
  let approved = 0;
  let rejected = 0;
  for (const d of Object.values(decisions || {})) {
    if (d?.approved) approved += 1;
    else rejected += 1;
  }
  return {
    total: total ?? Object.keys(decisions || {}).length,
    approved,
    rejected,
    apiCalls: approved + rejected,
  };
}

class GrokBacktestJobService {
  static createJob(userId, payload) {
    this._purgeExpired();

    const strategyKey = String(payload.strategy_key || payload.strategyKey || "").toUpperCase();
    const symbol = payload.symbol || "";
    const indexKey = jobIndexKey(userId, strategyKey, symbol);
    const existingId = activeJobIndex.get(indexKey);
    if (existingId) {
      const existing = jobs.get(existingId);
      if (existing && existing.userId === userId && ["queued", "processing"].includes(existing.status)) {
        return existingId;
      }
      activeJobIndex.delete(indexKey);
    }

    const jobId = crypto.randomUUID();
    const signals = Array.isArray(payload.signals) ? payload.signals : [];
    const seedDecisions = payload.existingDecisions && typeof payload.existingDecisions === "object"
      ? payload.existingDecisions
      : {};
    const doneSeed = Object.keys(seedDecisions).length;

    jobs.set(jobId, {
      userId,
      strategyKey,
      symbol,
      status: "queued",
      progress: { done: doneSeed, total: signals.length },
      decisions: { ...seedDecisions },
      logs: [],
      stats: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    activeJobIndex.set(indexKey, jobId);

    setImmediate(() => {
      this._runJob(jobId, userId, { ...payload, strategyKey, symbol, signals }).catch((err) => {
        const job = jobs.get(jobId);
        if (!job) return;
        job.status = "failed";
        job.error = err.message || String(err);
        job.updatedAt = Date.now();
        activeJobIndex.delete(indexKey);
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
    const partialStats = job.stats || computeStats(job.decisions, job.progress?.total);
    return {
      status: job.status,
      progress: job.progress,
      ...(Object.keys(job.decisions || {}).length ? { decisions: job.decisions } : {}),
      ...(Array.isArray(job.logs) && job.logs.length ? { logs: job.logs } : {}),
      ...(job.status === "done" ? { stats: partialStats } : { statsPartial: partialStats }),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  static async _runJob(jobId, userId, payload) {
    const job = jobs.get(jobId);
    if (!job) return;

    job.status = "processing";
    job.updatedAt = Date.now();

    const strategyKey = String(payload.strategyKey || "").toUpperCase();
    const signals = Array.isArray(payload.signals) ? payload.signals : [];
    const seedDecisions = job.decisions || {};

    const result = await GrokConfirmBatchProcessor.processBatch({
      userId,
      strategyKey,
      symbol: payload.symbol,
      signals,
      tpAdjust: payload.tpAdjust,
      tpBandPct: payload.tpBandPct,
      tpRejectAction: payload.tpRejectAction,
      seedDecisions,
      onProgress: (done, total, decisions, logEntry) => {
        job.progress = { done, total };
        if (decisions) job.decisions = decisions;
        if (logEntry) {
          job.logs = [...(job.logs || []), logEntry].slice(-MAX_JOB_LOGS);
        }
        job.updatedAt = Date.now();
      },
    });

    job.decisions = result.decisions;
    job.stats = result.stats;
    job.status = "done";
    job.updatedAt = Date.now();
    activeJobIndex.delete(jobIndexKey(userId, strategyKey, payload.symbol));
  }

  static _purgeExpired() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (now - job.createdAt > JOB_TTL_MS) {
        jobs.delete(id);
        for (const [k, v] of activeJobIndex) {
          if (v === id) activeJobIndex.delete(k);
        }
      }
    }
  }

  /** @internal test helper */
  static _clearAll() {
    jobs.clear();
    activeJobIndex.clear();
  }
}

module.exports = GrokBacktestJobService;
