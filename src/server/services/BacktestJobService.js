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

/** Terminal jobs (done/error/cancelled) — retained for FE poll grace period. */
const JOB_TTL_MS = Number(process.env.BACKTEST_JOB_TTL_MS) || 30 * 60_000;
/** Running/queued jobs — Wyckoff/VSA 12m All Types can exceed 30 min post-fix. */
const JOB_TTL_RUNNING_MS = Number(process.env.BACKTEST_JOB_TTL_RUNNING_MS) || 90 * 60_000;
const MAX_CONCURRENT = Number(process.env.BACKTEST_MAX_CONCURRENT) || 1;
const WORKER_HEAP_MB = Number(process.env.BACKTEST_WORKER_HEAP_MB) || 768;
const ISOLATE = process.env.BACKTEST_ISOLATE !== "0";
const WORKER_PATH = path.join(__dirname, "../workers/backtestJobWorker.js");
/** Reuse forked worker across sequential compare/tier jobs so in-process candle pool stays warm. */
const WORKER_WARM_MAX_JOBS = Number(process.env.BACKTEST_WORKER_WARM_MAX_JOBS) || 12;
const WORKER_WARM_TTL_MS = Number(process.env.BACKTEST_WORKER_WARM_TTL_MS) || 30 * 60_000;

/** @type {{ worker: import('child_process').ChildProcess, jobs: number, lastUsed: number, busy: boolean, currentJob: BacktestJob | null, currentSettle: (() => void) | null, handlersBound: boolean } | null} */
let warmWorkerState = null;
let warmWorkerRetireTimer = null;

function scheduleWarmWorkerRetire() {
  if (warmWorkerRetireTimer) clearTimeout(warmWorkerRetireTimer);
  warmWorkerRetireTimer = setTimeout(() => {
    warmWorkerRetireTimer = null;
    if (!warmWorkerState || warmWorkerState.busy) return;
    try { warmWorkerState.worker.kill("SIGTERM"); } catch { /* ignore */ }
    warmWorkerState = null;
  }, WORKER_WARM_TTL_MS);
  if (typeof warmWorkerRetireTimer.unref === "function") warmWorkerRetireTimer.unref();
}

function canReuseWarmWorker() {
  return warmWorkerState
    && !warmWorkerState.busy
    && !warmWorkerState.worker.killed
    && warmWorkerState.worker.connected
    && warmWorkerState.jobs < WORKER_WARM_MAX_JOBS
    && Date.now() - warmWorkerState.lastUsed < WORKER_WARM_TTL_MS;
}

function retireWarmWorker() {
  if (warmWorkerRetireTimer) {
    clearTimeout(warmWorkerRetireTimer);
    warmWorkerRetireTimer = null;
  }
  if (warmWorkerState?.worker && !warmWorkerState.worker.killed) {
    try { warmWorkerState.worker.kill("SIGTERM"); } catch { /* ignore */ }
  }
  warmWorkerState = null;
}

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
      retireWarmWorker();
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
    jobStore.delete(id);
  }
}

const cleanupTimer = setInterval(() => purgeExpiredJobs(), 5 * 60_000);
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

function bindWorkerHandlersOnce(worker) {
  if (warmWorkerState?.handlersBound && warmWorkerState.worker === worker) return;

  worker.on("message", (msg) => {
    const state = warmWorkerState;
    const job = state?.currentJob;
    const settleOnce = state?.currentSettle;
    if (!job || !msg || typeof msg !== "object") return;

    if (msg.type === "progress") job.progress(msg.data || {});
    else if (msg.type === "done") {
      job._ipcSettled = true;
      job.lastActivityAt = Date.now();
      job.done(msg.result);
      if (state && state.worker === worker) {
        state.busy = false;
        state.jobs += 1;
        state.lastUsed = Date.now();
        state.currentJob = null;
        state.currentSettle = null;
        scheduleWarmWorkerRetire();
      }
      settleOnce?.();
    } else if (msg.type === "error") {
      job._ipcSettled = true;
      job.lastActivityAt = Date.now();
      if (job.status !== "cancelled") job.fail(msg.error || "Backtest failed");
      retireWarmWorker();
      settleOnce?.();
    }
  });

  worker.stderr?.on("data", (buf) => {
    const line = String(buf).trim();
    const jobId = warmWorkerState?.currentJob?.id || "worker";
    if (line) console.error(`[backtest-worker ${String(jobId).slice(0, 8)}] ${line}`);
  });

  worker.on("error", (err) => {
    const job = warmWorkerState?.currentJob;
    if (job && job.status !== "cancelled" && job.status !== "done") {
      job.fail(`Backtest worker error: ${err.message}`);
    }
    const settleOnce = warmWorkerState?.currentSettle;
    retireWarmWorker();
    settleOnce?.();
  });

  worker.on("exit", (code, signal) => {
    const job = warmWorkerState?.currentJob;
    const settleOnce = warmWorkerState?.currentSettle;
    if (warmWorkerState && warmWorkerState.worker === worker) {
      warmWorkerState = null;
    }
    if (job && !job._ipcSettled
        && (job.status === "running" || job.status === "pending" || job.status === "queued")) {
      const reason = signal
        ? `Backtest worker killed (${signal}) — often out-of-memory. Retry with 3–6 months or fewer strategies.`
        : `Backtest worker exited (code ${code}) before delivering a result. Retry with a shorter period if this persists.`;
      job.fail(reason);
    }
    settleOnce?.();
  });

  if (warmWorkerState) warmWorkerState.handlersBound = true;
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

  static _startWorkerJob(job, worker, jobId, settleOnce, { reuse = false } = {}) {
    job._worker = worker;
    job._ipcSettled = false;
    job.status = "running";
    if (warmWorkerState) {
      warmWorkerState.currentJob = job;
      warmWorkerState.currentSettle = settleOnce;
      warmWorkerState.busy = true;
      if (warmWorkerRetireTimer) {
        clearTimeout(warmWorkerRetireTimer);
        warmWorkerRetireTimer = null;
      }
    }

    job.progress({
      phase: "info",
      message: reuse
        ? "Reusing warm backtest worker — candle cache stays hot for compare/tier runs"
        : `Running in isolated worker (heap cap ${WORKER_HEAP_MB}MB) — live API stays responsive`,
    });
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

    if (canReuseWarmWorker()) {
      const worker = warmWorkerState.worker;
      this._startWorkerJob(job, worker, jobId, settleOnce, { reuse: true });
      try {
        worker.send({ type: "start", userId: job.userId, opts: job.opts });
      } catch (err) {
        retireWarmWorker();
        job.fail(`Failed to send job to warm worker: ${err.message}`);
        settleOnce();
      }
      return;
    }

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

    warmWorkerState = {
      worker,
      jobs: 0,
      lastUsed: Date.now(),
      busy: true,
      currentJob: null,
      currentSettle: null,
      handlersBound: false,
    };
    bindWorkerHandlersOnce(worker);
    this._startWorkerJob(job, worker, jobId, settleOnce);

    try {
      worker.send({ type: "start", userId: job.userId, opts: job.opts });
    } catch (err) {
      retireWarmWorker();
      job.fail(`Failed to send job to worker: ${err.message}`);
      settleOnce();
    }
  }

  /** @internal test helper */
  static _clearAll() {
    retireWarmWorker();
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
    return {
      activeCount,
      queued: waitQueue.length,
      jobs: jobStore.size,
      isolate: ISOLATE,
      warmWorker: warmWorkerState
        ? { jobs: warmWorkerState.jobs, busy: warmWorkerState.busy, connected: warmWorkerState.worker?.connected }
        : null,
    };
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
