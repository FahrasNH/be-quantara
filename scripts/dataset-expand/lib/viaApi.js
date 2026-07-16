"use strict";

/**
 * Run dataset-expand via the same server API the UI uses:
 *   POST /api/v1/backtest/run-real → poll job-status → GET job-result
 *
 * This is the 1:1 path when the laptop cannot reach exchange APIs or local Postgres.
 * Candle fetch + engine run on the staging/production BE (same as UI Advance).
 */

const { TYPE_TF } = require("../../../src/modules/backtest/services/runBacktestJob");

function daysToPeriodId(days) {
  if (days === 90) return "3m";
  if (days === 180) return "6m";
  if (days === 365) return "12m";
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The Scalping ablation funnel is streamed by the server as a progress message;
// we suppress it here and print it once locally (avoids duplicate output).
function isFunnelMessage(msg) {
  return typeof msg === "string" && /filter funnel|Raw setups \(FVG/i.test(msg);
}

async function apiFetch(baseUrl, token, path, { method = "GET", body } = {}) {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (body != null) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data.error || data.message || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * @param {object} args
 * @param {string} args.apiBase - e.g. https://api.example.com
 * @param {string} args.token - JWT
 * @param {string} args.symbol
 * @param {string} args.strategyKey
 * @param {string} args.tradeType - Scalping|Intraday|Swing
 * @param {number} args.days
 * @param {string} [args.start]
 * @param {string} [args.end]
 * @param {number} args.capital
 * @param {string} args.exchange
 * @param {object} [args.parameters] - extra strategy parameters
 * @param {(msg: string) => void} [args.log]
 */
async function runViaApi({
  apiBase,
  token,
  symbol,
  strategyKey,
  tradeType,
  days,
  start,
  end,
  capital,
  exchange,
  parameters = {},
  log = console.log,
}) {
  if (!apiBase) {
    throw new Error(
      "Missing API base. Set DATASET_EXPAND_API_URL (or --api https://your-be) — same host the FE uses.",
    );
  }
  if (!token) {
    throw new Error(
      "Missing JWT. Set DATASET_EXPAND_TOKEN (or --token <jwt>) — login via FE/API and paste the access token.",
    );
  }

  const tfs = TYPE_TF[tradeType];
  const useCustom = Boolean(start && end);
  const periodId = useCustom ? "custom" : (daysToPeriodId(days) || `${days}d`);

  const body = {
    symbol,
    strategy_key: strategyKey,
    period_id: periodId,
    custom_start: useCustom ? start : undefined,
    custom_end: useCustom ? end : undefined,
    capital,
    enable_fees: true,
    enable_slippage: true,
    exchange_type: exchange,
    parameters: {
      ...parameters,
      activeTypes: [tradeType],
    },
    debug: true,
  };

  log(`[via-api] POST /api/v1/backtest/run-real · ${symbol} · ${strategyKey} · ${tradeType} (${tfs.entry}/${tfs.trend}) · ${periodId} · ${exchange}`);

  const startResp = await apiFetch(apiBase, token, "/api/v1/backtest/run-real", {
    method: "POST",
    body,
  });

  // Sync legacy response (full result inline)
  if (startResp?.stats || startResp?.trades) {
    log("[via-api] sync result (legacy BE)");
    return normalizeResult(startResp, tradeType);
  }

  const jobId = startResp?.jobId;
  if (!jobId) {
    throw new Error(`run-real did not return jobId: ${JSON.stringify(startResp)}`);
  }
  log(`[via-api] job ${jobId} — polling (same path as UI)…`);

  let since = 0;
  const started = Date.now();
  const MAX_MS = 45 * 60 * 1000;

  while (Date.now() - started < MAX_MS) {
    const status = await apiFetch(
      apiBase,
      token,
      `/api/v1/backtest/job-status/${encodeURIComponent(jobId)}?since=${since}`,
    );

    const progress = status.progress || status.progressLog || [];
    if (Array.isArray(progress) && progress.length) {
      since += progress.length;
      const last = progress[progress.length - 1];
      // Skip the server's funnel dump — printed once locally with richer formatting.
      if ((last?.message || last?.phase) && !isFunnelMessage(last.message)) {
        log(`[via-api] ${last.phase || "progress"}: ${last.message || `${last.pct ?? ""}%`}`);
      }
    } else if ((status.message || status.phase) && !isFunnelMessage(status.message)) {
      log(`[via-api] ${status.phase || "status"}: ${status.message || status.status}`);
    }

    if (status.status === "error") {
      throw new Error(status.error || "Backtest job failed");
    }
    if (status.status === "cancelled") {
      throw new Error("Backtest job cancelled");
    }
    if (status.status === "done") {
      const result = await apiFetch(
        apiBase,
        token,
        `/api/v1/backtest/job-result/${encodeURIComponent(jobId)}`,
      );
      log("[via-api] job done — fetching result");
      return normalizeResult(result, tradeType);
    }

    await sleep(2000);
  }

  throw new Error(`Backtest job timed out after ${MAX_MS / 60000} minutes (jobId=${jobId})`);
}

/**
 * Exchange email + password for a JWT access token via the same endpoint the FE uses.
 * Lets users authenticate from .env (DATASET_EXPAND_EMAIL / DATASET_EXPAND_PASSWORD)
 * instead of copy-pasting a short-lived Bearer token.
 *
 * @param {object} args
 * @param {string} args.apiBase
 * @param {string} args.email
 * @param {string} args.password
 * @param {(msg: string) => void} [args.log]
 * @returns {Promise<string>} accessToken
 */
async function loginForToken({ apiBase, email, password, log = console.log }) {
  if (!apiBase) {
    throw new Error(
      "Missing API base. Set DATASET_EXPAND_API_URL (or --api https://your-be).",
    );
  }
  if (!email || !password) {
    throw new Error(
      "Missing credentials. Set DATASET_EXPAND_EMAIL + DATASET_EXPAND_PASSWORD (or --email/--password).",
    );
  }
  log(`[via-api] login ${email} → POST /api/v1/auth/login`);
  const url = `${apiBase.replace(/\/$/, "")}/api/v1/auth/login`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok || !data.ok) {
    const msg = data.message || data.error || text || `HTTP ${res.status}`;
    throw new Error(`Login failed (${res.status}): ${msg}`);
  }
  const token = data.accessToken || data.token || data.access_token;
  if (!token) {
    throw new Error(`Login OK but no accessToken in response: ${JSON.stringify(data)}`);
  }
  log("[via-api] login OK — access token acquired");
  return token;
}

function normalizeResult(payload, tradeType) {
  const trades = (payload.trades || []).filter(
    (t) => (t.tradeType || t.component) === tradeType || !t.tradeType,
  );
  // If filter emptied but payload only had one type, keep all
  const finalTrades = trades.length || !(payload.trades?.length)
    ? (trades.length ? trades : payload.trades || [])
    : payload.trades;

  return {
    trades: finalTrades,
    stats: payload.stats || null,
    perTypeStats: payload.engineMeta?.perTypeStats || payload.perTypeStats || null,
    engineMeta: payload.engineMeta || null,
    dataInfo: payload.engineMeta?.dataInfo || payload.dataInfo || null,
    source: "via-api",
  };
}

module.exports = {
  runViaApi,
  loginForToken,
  daysToPeriodId,
};
