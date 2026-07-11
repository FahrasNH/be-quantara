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
const path = require("path");
const crypto = require("crypto");
const { runBacktestJob } = require("./runBacktestJob");

const JOB_TTL_MS = 30 * 60_000;
const MAX_CONCURRENT = Number(process.env.BACKTEST_MAX_CONCURRENT) || 1;
const WORKER_HEAP_MB = Number(process.env.BACKTEST_WORKER_HEAP_MB) || 768;
const ISOLATE = process.env.BACKTEST_ISOLATE !== "0";
const WORKER_PATH = path.join(__dirname, "../workers/backtestJobWorker.js");

class BacktestJob extends EventEmitter {
  constructor(id) {
    super();
    this.setMaxListeners(20);
    this.id = id;
    this.status = "pending"; // pending | queued | running | done | error | cancelled
    this.createdAt = Date.now();
    this.result = null;
    this.error = null;
    this.aborted = false;
    this.progressLog = [];
    this.abortController = new AbortController();
    this._worker = null;
  }

  progress(data) {
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

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobStore) {
    if (job.createdAt < cutoff) {
      if (job._worker && !job._worker.killed) {
        try { job._worker.kill("SIGTERM"); } catch { /* ignore */ }
      }
      jobStore.delete(id);
    }
  }
}, 5 * 60_000);
if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

function toPublicStatus(job) {
  return {
    ok: true,
    status: job.status,
    progress: job.progressLog,
    result: job.result || null,
    error: job.error || null,
  };
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

  static toPublicStatus(job) {
    return toPublicStatus(job);
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
    job.status = "running";
    job.progress({
      phase: "info",
      message: `Running in isolated worker (heap cap ${WORKER_HEAP_MB}MB) — live API stays responsive`,
    });

    worker.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "progress") job.progress(msg.data || {});
      else if (msg.type === "done") {
        job.done(msg.result);
        settleOnce();
        try { worker.kill("SIGTERM"); } catch { /* ignore */ }
      } else if (msg.type === "error") {
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
    });

    worker.on("exit", (code, signal) => {
      if (job.status === "running" || job.status === "pending" || job.status === "queued") {
        const reason = signal
          ? `Backtest worker killed (${signal}) — often out-of-memory. Retry with 3–6 months or fewer strategies.`
          : `Backtest worker exited (code ${code}). Retry with a shorter period if this persists.`;
        job.fail(reason);
      }
      settleOnce();
    });

    try {
      worker.send({ type: "start", userId: job.userId, opts: job.opts });
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
}

module.exports = BacktestJobService;
module.exports.BacktestJob = BacktestJob;
