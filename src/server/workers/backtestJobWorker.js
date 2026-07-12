/**
 * Child-process entry for isolated real-engine backtests.
 * Parent: BacktestJobService (fork with --max-old-space-size).
 * IPC: { type: 'start', userId, opts } | { type: 'cancel' }
 * Out:  { type: 'progress', data } | { type: 'done', result } | { type: 'error', error }
 *
 * Warm-worker reuse: parent may send multiple start messages on the same process
 * so BacktestCandleCache stays hot across compare/tier strategy runs.
 */

"use strict";

const { runBacktestJob } = require("../services/runBacktestJob");

let running = false;
let aborted = false;
let abortController = new AbortController();

function makeJobAdapter() {
  return {
    status: "pending",
    aborted: false,
    abortController,
    progress(data) {
      if (process.connected) process.send({ type: "progress", data });
    },
    done(result) {
      this.status = "done";
      if (process.connected) process.send({ type: "done", result });
    },
    fail(errMsg) {
      this.status = "error";
      if (process.connected) process.send({ type: "error", error: errMsg });
    },
  };
}

async function handleStart(msg) {
  if (running) {
    if (process.connected) {
      process.send({ type: "error", error: "Worker busy — cannot start overlapping backtest" });
    }
    return;
  }

  running = true;
  aborted = false;
  abortController = new AbortController();
  const jobAdapter = makeJobAdapter();

  try {
    await runBacktestJob(jobAdapter, msg.userId, msg.opts || {});
    if (jobAdapter.status !== "done" && jobAdapter.status !== "error") {
      if (!aborted) jobAdapter.fail("Backtest finished without result");
    }
  } catch (err) {
    if (aborted || abortController.signal.aborted) {
      if (process.connected) process.send({ type: "error", error: "Cancelled" });
    } else {
      jobAdapter.fail(err.message || String(err));
    }
  } finally {
    running = false;
  }
}

process.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "cancel") {
    aborted = true;
    abortController.abort();
    return;
  }

  if (msg.type === "start") {
    void handleStart(msg);
  }
});

process.on("disconnect", () => {
  aborted = true;
  abortController.abort();
  process.exit(0);
});
