/**
 * Child-process entry for isolated real-engine backtests.
 * Parent: BacktestJobService (fork with --max-old-space-size).
 * IPC: { type: 'start', userId, opts } | { type: 'cancel' }
 * Out:  { type: 'progress', data } | { type: 'done', result } | { type: 'error', error }
 */

"use strict";

const { runBacktestJob } = require("../services/runBacktestJob");

let aborted = false;
const abortController = new AbortController();

const jobAdapter = {
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

process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "cancel") {
    aborted = true;
    jobAdapter.aborted = true;
    abortController.abort();
    return;
  }

  if (msg.type !== "start") return;

  try {
    await runBacktestJob(jobAdapter, msg.userId, msg.opts || {});
    if (jobAdapter.status !== "done" && jobAdapter.status !== "error") {
      // runBacktestJob calls job.done(); if it returned without that, treat as error
      if (!aborted) jobAdapter.fail("Backtest finished without result");
    }
  } catch (err) {
    if (aborted || abortController.signal.aborted) {
      // Parent marks cancelled; still notify so it can settle
      if (process.connected) process.send({ type: "error", error: "Cancelled" });
    } else {
      jobAdapter.fail(err.message || String(err));
    }
  }
  // Parent kills this process after done/error IPC is received. Do NOT call
  // process.exit(0) here — a 50ms timer raced large Wyckoff/VSA result payloads
  // and caused "worker exited (code 0)" false failures before IPC flushed.
});

process.on("disconnect", () => {
  aborted = true;
  abortController.abort();
  process.exit(0);
});
