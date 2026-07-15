/**
 * BacktestJobService — in-memory async jobs for POST /backtest/run-real.
 *
 * Tradeoff (BUG-CRITICAL 502 on >12m): BullMQ/pg-boss not in deps this sprint.
 * We isolate heavy work in a child_process.fork with a dedicated heap cap so an
 * OOM/unhandled crash in the backtest worker cannot kill the main API / live
 * tick loop. Candle/memory hard caps live in runBacktestJob.js.
 *
 * Fallback: BACKTEST_ISOLATE=0 runs in-process (tests / emergency) via setImmediate.
 */

"use strict";

const { EventEmitter } = require("events");
const { fork } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const { runBacktestJob } = require("./runBacktestJob");

/** Terminal jobs (done/error/cancelled) — retained for FE poll grace period. */
const JOB_TTL_MS = Number(process.env.BACKTEST_JOB_TTL_MS) || 30 * 60_000;
/** Running/queued jobs — Wyckoff/VSA 12m All Types can exceed 30 min post-fix. */
const JOB_TTL_RUNNING_MS = Number(process.env.BACKTEST_JOB_TTL_RUNNING_MS) || 90 * 60_000;
const MAX_CONCURRENT = Number(process.env.BACKTEST_MAX_CONCURRENT) || 1;
const WORKER_HEAP_MB = Number(process.env.BACKTEST_WORKER_HEAP_MB) || 768;
const ISOLATE = process.env.BACKTEST_ISOLATE !== "0";
const WORKER_PATH = process.env.BACKTEST_WORKER_PATH
  || path.join(__dirname, "../workers/backtestJobWorker.js");

class BacktestJob extends EventEmitter {
  constructor(id) {
    super();
    this.setMaxListeners(20);
    this.id = id;
    this.status = "pending"; // pending | queued | running | done | error | cancelled
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.result = null;
    this.error = null;
    this.aborted = false;
    this.progressLog = [];
    this.abortController = new AbortController();
    this._worker = null;
    /** Set when parent receives done/error IPC — prevents exit(0) race false-fail. */
    this._ipcSettled = false;
  }

  progress(data) {
    this.lastActivityAt = Date.now();
    const ev = { ...data, ts: Date.now() };
    this.progressLog.push(ev);
    if (this.progressLog.length > 300) this.progressLog.shift();
    this.emit("progress", ev);
  }

  done(result) {
    this.status = "done";
    this.result = result;
    this.emit("result", result);
  }

  fail(errMsg) {
    this.status = "error";
    this.error = errMsg;
    this.emit("jobError", errMsg);
  }

  cancel() {
    if (this.aborted) return;
    this.aborted = true;
    this.status = "cancelled";
    this.abortController.abort();
    if (this._worker && !this._worker.killed) {
      try { this._worker.send({ type: "cancel" }); } catch { /* ignore */ }
      try { this._worker.kill("SIGTERM"); } catch { /* ignore */ }
    }
    this.emit("cancelled");
  }
}

const jobStore = new Map();
/** @type {string[]} */
const waitQueue = [];
let activeCount = 0;

function ttlForJob(job) {
  return (job.status === "running" || job.status === "queued")
    ? JOB_TTL_RUNNING_MS
    : JOB_TTL_MS;
}

function purgeExpiredJobs(now = Date.now()) {
  for (const [id, job] of jobStore) {
    const ttl = ttlForJob(job);
    const anchor = job.lastActivityAt || job.createdAt;
    if (anchor >= now - ttl) continue;

    if (job.status === "running" || job.status === "queued") {
      if (job.status !== "cancelled") {
        const mins = Math.round(ttl / 60_000);
        job.fail(
          `Backtest timed out after ${mins} minutes without completing. ` +
          "Retry 3–6 months or fewer trade types."
        );
      }
      if (job._worker && !job._worker.killed) {
        try { job._worker.kill("SIGTERM"); } catch { /* ignore */ }
      }
    }
    if (job.resultFile) {
      fs.unlink(job.resultFile).catch(() => {});
    }
    jobStore.delete(id);
  }
}

const cleanupTimer = setInterval(() => purgeExpiredJobs(), 5 * 60_000);
if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

function resultMetaFromPayload(result) {
  if (!result || typeof result !== "object") return null;
  return {
    ok: result.ok,
    engine: result.engine,
    strategyKey: result.strategyKey,
    symbol: result.symbol,
    tradeCount: Array.isArray(result.trades) ? result.trades.length : 0,
    computeTimeMs: result.computeTimeMs,
  };
}

function toPublicStatus(job, opts = {}) {
  const progressSince = Math.max(0, Number(opts.progressSince) || 0);
  const includeResult = opts.includeResult === true;
  const payload = {
    ok: true,
    status: job.status,
    progress: job.progressLog.slice(progressSince),
    progressLen: job.progressLog.length,
    error: job.error || null,
    resultLoading: !!job.resultLoading,
  };
  if (includeResult && job.status === "done" && job.result) {
    payload.result = job.result;
  } else if (job.status === "done") {
    payload.hasResult = !!(job.result || job.resultFile);
    payload.resultMeta = job.resultMeta || resultMetaFromPayload(job.result);
  }
  return payload;
}

async function loadResultFromFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  await fs.unlink(filePath).catch(() => {});
  return JSON.parse(raw);
}

class BacktestJobService {
  static createJob(userId, opts) {
    const jobId = crypto.randomUUID();
    const job = new BacktestJob(jobId);
    job.userId = userId;
    job.opts = opts;
    jobStore.set(jobId, job);

    if (activeCount >= MAX_CONCURRENT) {
      job.status = "queued";
      job.progress({ phase: "info", message: `Queued — ${activeCount} backtest(s) already running (max ${MAX_CONCURRENT})` });
      waitQueue.push(jobId);
    } else {
      this._dispatch(jobId);
    }

    return jobId;
  }

  static getJob(jobId) {
    return jobStore.get(jobId) || null;
  }

  static cancelJob(jobId) {
    const job = jobStore.get(jobId);
    if (!job) return false;
    const qi = waitQueue.indexOf(jobId);
    if (qi >= 0) waitQueue.splice(qi, 1);
    job.cancel();
    return true;
  }

  static toPublicStatus(job, opts) {
    return toPublicStatus(job, opts);
  }

  /** Full payload — fetched once after job-status reports done (avoids huge poll bodies). */
  static async getJobResult(jobId) {
    const job = jobStore.get(jobId);
    if (!job) return null;
    if (job.status === "error") {
      return { ok: false, status: "error", error: job.error || "Backtest failed" };
    }
    if (job.status === "cancelled") {
      return { ok: false, status: "cancelled", error: "Backtest cancelled" };
    }
    if (job.status !== "done") {
      return { ok: true, status: job.status, resultLoading: !!job.resultLoading };
    }
    if (job.result) {
      return { ok: true, status: "done", ...job.result };
    }
    if (job.resultFile) {
      job.resultLoading = true;
      try {
        const result = await loadResultFromFile(job.resultFile);
        job.result = result;
        job.resultFile = null;
        job.resultMeta = resultMetaFromPayload(result);
        job.emit("result", result);
        return { ok: true, status: "done", ...result };
      } catch (err) {
        job.fail(`Failed to load backtest result: ${err.message}`);
        return { ok: false, status: "error", error: job.error };
      } finally {
        job.resultLoading = false;
      }
    }
    return { ok: false, status: "error", error: "Backtest finished without a result payload" };
  }

  /** @internal health / admin */
  static queueStats() {
    return { activeCount, queued: waitQueue.length, jobs: jobStore.size, isolate: ISOLATE };
  }

  static _dispatch(jobId) {
    const job = jobStore.get(jobId);
    if (!job || job.aborted || job.status === "cancelled") return;

    activeCount += 1;
    const release = () => {
      activeCount = Math.max(0, activeCount - 1);
      job._worker = null;
      while (waitQueue.length && activeCount < MAX_CONCURRENT) {
        const nextId = waitQueue.shift();
        const next = jobStore.get(nextId);
        if (next && !next.aborted && next.status === "queued") {
          this._dispatch(nextId);
          break;
        }
      }
    };

    const onSettle = () => {
      release();
    };

    if (!ISOLATE) {
      setImmediate(() => {
        runBacktestJob(job, job.userId, job.opts)
          .catch((err) => {
            if (job.status !== "cancelled") job.fail(err.message || "Backtest failed");
          })
          .finally(onSettle);
      });
      return;
    }

    let settled = false;
    const settleOnce = () => {
      if (settled) return;
      settled = true;
      onSettle();
    };

    let worker;
    try {
      worker = fork(WORKER_PATH, [], {
        execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`],
        env: { ...process.env, BACKTEST_WORKER: "1" },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
    } catch (err) {
      job.fail(`Failed to start backtest worker: ${err.message}`);
      settleOnce();
      return;
    }

    job._worker = worker;
    job._ipcSettled = false;
    job.status = "running";
    job.progress({
      phase: "info",
      message: `Running in isolated worker (heap cap ${WORKER_HEAP_MB}MB) — live API stays responsive`,
    });

    worker.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "progress") job.progress(msg.data || {});
      else if (msg.type === "done") {
        job._ipcSettled = true;
        job.lastActivityAt = Date.now();
        if (msg.resultFile) {
          job.status = "done";
          job.resultFile = msg.resultFile;
          job.resultMeta = msg.resultMeta || null;
          job.resultLoading = true;
          setImmediate(() => {
            loadResultFromFile(msg.resultFile)
              .then((result) => {
                job.result = result;
                job.resultFile = null;
                job.resultMeta = resultMetaFromPayload(result);
                job.resultLoading = false;
                job.emit("result", result);
              })
              .catch((err) => {
                job.resultLoading = false;
                if (job.status !== "cancelled") {
                  job.fail(`Failed to load backtest result: ${err.message}`);
                }
              });
          });
        } else {
          job.done(msg.result);
        }
        settleOnce();
        try { worker.kill("SIGTERM"); } catch { /* ignore */ }
      } else if (msg.type === "error") {
        job._ipcSettled = true;
        job.lastActivityAt = Date.now();
        if (job.status !== "cancelled") job.fail(msg.error || "Backtest failed");
        settleOnce();
        try { worker.kill("SIGTERM"); } catch { /* ignore */ }
      }
    });

    worker.stderr?.on("data", (buf) => {
      const line = String(buf).trim();
      if (line) console.error(`[backtest-worker ${jobId.slice(0, 8)}] ${line}`);
    });

    worker.on("error", (err) => {
      if (job.status !== "cancelled" && job.status !== "done") {
        job.fail(`Backtest worker error: ${err.message}`);
      }
      settleOnce();
      try { worker.kill("SIGTERM"); } catch { /* ignore */ }
    });

    worker.on("exit", (code, signal) => {
      if (!job._ipcSettled
          && (job.status === "running" || job.status === "pending" || job.status === "queued")) {
        const reason = signal
          ? `Backtest worker killed (${signal}) — often out-of-memory. Retry with 3–6 months or fewer strategies.`
          : `Backtest worker exited (code ${code}) before delivering a result. Retry with a shorter period if this persists.`;
        job.fail(reason);
      }
      settleOnce();
    });

    job.once("cancelled", settleOnce);

    try {
      worker.send({ type: "start", jobId, userId: job.userId, opts: job.opts });
    } catch (err) {
      job.fail(`Failed to send job to worker: ${err.message}`);
      settleOnce();
      try { worker.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }

  /** @internal test helper */
  static _clearAll() {
    for (const job of jobStore.values()) {
      if (job._worker && !job._worker.killed) {
        try { job._worker.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }
    jobStore.clear();
    waitQueue.length = 0;
    activeCount = 0;
  }

  /** @internal */
  static _stats() {
    return { activeCount, queued: waitQueue.length, jobs: jobStore.size, isolate: ISOLATE };
  }

  /** @internal test helper */
  static _purgeExpired(now) {
    purgeExpiredJobs(now);
  }
}

module.exports = BacktestJobService;
module.exports.BacktestJob = BacktestJob;
module.exports._purgeExpiredJobs = purgeExpiredJobs;
module.exports._ttlForJob = ttlForJob;
