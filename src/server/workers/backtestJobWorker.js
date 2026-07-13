/**
 * Child-process entry for isolated real-engine backtests.
 * Parent: BacktestJobService (fork with --max-old-space-size).
 * IPC: { type: 'start', jobId, userId, opts } | { type: 'cancel' }
 * Out:  { type: 'progress', data } | { type: 'done', resultFile, resultMeta } | { type: 'error', error }
 *
 * Large results are written to a temp JSON file so structured-clone IPC does not
 * block the parent API event loop (BUG-CRITICAL 502 on heavy 12m multi-type runs).
 */

"use strict";

const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const { runBacktestJob } = require("../services/runBacktestJob");

let aborted = false;
let currentJobId = null;
const abortController = new AbortController();

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

const jobAdapter = {
  status: "pending",
  aborted: false,
  abortController,
  progress(data) {
    if (process.connected) process.send({ type: "progress", data });
  },
  done(result) {
    this.status = "done";
    if (!process.connected) return;

    if (currentJobId) {
      const filePath = path.join(os.tmpdir(), `quantara-bt-${currentJobId}.json`);
      fs.writeFile(filePath, JSON.stringify(result))
        .then(() => {
          if (process.connected) {
            process.send({
              type: "done",
              resultFile: filePath,
              resultMeta: resultMetaFromPayload(result),
            });
          }
        })
        .catch((err) => {
          if (process.connected) {
            process.send({ type: "error", error: `Failed to persist result: ${err.message}` });
          }
        });
      return;
    }

    process.send({ type: "done", result });
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

  currentJobId = msg.jobId || null;

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
  }
  // Parent terminates this one-job worker after done/error IPC is received.
  // Do not call process.exit() here: large result payloads must fully flush.
});

process.on("disconnect", () => {
  aborted = true;
  abortController.abort();
  process.exit(0);
});
