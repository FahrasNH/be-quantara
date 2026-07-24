/**
 * BacktestCanonicalService — Opsi B shared archive
 * Satu row per canonical_key; update in-place; filter subset tanpa INSERT baru.
 */

const crypto = require("crypto");

/** Bump saat RealStrategyBacktestService / rubric SMC / gate SSOT berubah material. */
const ENGINE_VERSION = "be-real-2.0.2-vsa-sprint23b";

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function buildCanonicalKey({
  symbol,
  strategyKey,
  timeframe,
  parameters = {},
  enableFees = true,
  enableSlippage = false,
  exchange = "sim",
  dataSource = "sim",
  periodLabel = "500",
}) {
  const payload = {
    v: ENGINE_VERSION,
    symbol: String(symbol || "").toUpperCase(),
    strategyKey: String(strategyKey || "").toUpperCase(),
    timeframe: String(timeframe || "1d"),
    parameters,
    enableFees: !!enableFees,
    enableSlippage: !!enableSlippage,
    exchange: exchange || "sim",
    dataSource: dataSource || "sim",
    periodLabel: String(periodLabel || "500"),
  };
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function parseTradeTs(trade) {
  const raw = trade?.date ?? trade?.timestamp ?? trade?.entryTime ?? trade?.openTime;
  if (raw == null) return NaN;
  if (typeof raw === "number") return raw;
  return Date.parse(raw);
}

function filterTradesByRange(trades, startMs, endMs) {
  if (!Array.isArray(trades) || !trades.length) return [];
  return trades.filter(t => {
    const ts = parseTradeTs(t);
    return Number.isFinite(ts) && ts >= startMs && ts <= endMs;
  });
}

function filterEquityByRange(equity, startMs, endMs) {
  if (!Array.isArray(equity) || !equity.length) return [];
  return equity.filter(p => {
    const ts = parseTradeTs(p);
    return Number.isFinite(ts) && ts >= startMs && ts <= endMs;
  });
}

function recalcMetrics(trades, initialCapital = 500) {
  if (!trades?.length) {
    return {
      totalReturn: "0.00",
      winRate: "0.0",
      maxDrawdown: "0.00",
      profitFactor: "0.00",
      sharpe: "0.00",
      totalTrades: 0,
      finalCapital: initialCapital,
      wins: 0,
      losses: 0,
      roi_pct: 0,
      win_rate_pct: 0,
      max_drawdown_pct: 0,
      profit_factor: 0,
    };
  }

  let capital = initialCapital;
  let peak = capital;
  let maxDd = 0;
  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let grossLoss = 0;

  for (const t of trades) {
    const pnl = Number(t.pnl ?? t.netPnL ?? 0);
    capital += pnl;
    if (pnl > 0) { wins++; grossWin += pnl; }
    else if (pnl < 0) { losses++; grossLoss += Math.abs(pnl); }
    if (capital > peak) peak = capital;
    const dd = peak > 0 ? ((peak - capital) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }

  const totalReturn = ((capital - initialCapital) / initialCapital) * 100;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;

  return {
    totalReturn: totalReturn.toFixed(2),
    winRate: winRate.toFixed(1),
    maxDrawdown: maxDd.toFixed(2),
    profitFactor: profitFactor.toFixed(2),
    sharpe: "0.00",
    totalTrades: trades.length,
    finalCapital: Math.round(capital * 100) / 100,
    wins,
    losses,
    roi_pct: Number(totalReturn.toFixed(2)),
    win_rate_pct: Number(winRate.toFixed(1)),
    max_drawdown_pct: Number(maxDd.toFixed(2)),
    profit_factor: Number(profitFactor.toFixed(2)),
  };
}

function filterSubset(record, startMs, endMs) {
  const trades = filterTradesByRange(record.trades_data || record.trades || [], startMs, endMs);
  const equity = filterEquityByRange(record.equity_curve || [], startMs, endMs);
  const initialCapital = record.config?.parameters?.capital ?? 500;
  const metrics = recalcMetrics(trades, Number(initialCapital) || 500);
  return { metrics, trades, equity };
}

function resolveAction(record, requestedStartMs, requestedEndMs) {
  if (!record || !record.canonical_key) return "miss";
  if (record.engine_version && record.engine_version !== ENGINE_VERSION) return "miss";

  const storedStart = record.data_start ? Date.parse(record.data_start) : NaN;
  const storedEnd = record.data_end ? Date.parse(record.data_end) : NaN;
  if (!Number.isFinite(storedStart) || !Number.isFinite(storedEnd)) return "miss";

  const reqStart = Number(requestedStartMs);
  const reqEnd = Number(requestedEndMs);
  if (!Number.isFinite(reqStart) || !Number.isFinite(reqEnd)) return "miss";

  if (reqEnd > storedEnd + 86400000) return "extend";
  if (reqStart < storedStart - 86400000) return "extend";

  const sameRange =
    Math.abs(reqStart - storedStart) <= 3600000 &&
    Math.abs(reqEnd - storedEnd) <= 3600000;
  if (sameRange) return "reused";

  if (reqStart >= storedStart && reqEnd <= storedEnd) return "subset";

  return "extend";
}

/**
 * Guard for canonical extend/update writes.
 * equity_curve must be present (array, may be empty) whenever we overwrite metrics
 * so we never leave a stale curve beside fresh stats (COALESCE partial-write bug).
 */
function assertAtomicCanonicalExtendPayload({ equityCurve, tradesData } = {}) {
  if (!Array.isArray(equityCurve)) {
    const err = new Error(
      "equity_curve array required for canonical archive extend/update (prevents metrics/equity desync)",
    );
    err.statusCode = 400;
    err.code = "EQUITY_CURVE_REQUIRED";
    throw err;
  }
  if (tradesData != null && !Array.isArray(tradesData)) {
    const err = new Error(
      "trades_data must be an array when provided for canonical archive extend/update",
    );
    err.statusCode = 400;
    err.code = "TRADES_DATA_INVALID";
    throw err;
  }
}

/**
 * Detect metrics/trades vs equity mismatch (COALESCE partial-write leftover).
 * True when there are no trades but equity moves materially (e.g. 0 trades + -70% curve).
 */
function isEquityTradesDesync(metrics, trades, equityCurve, movePctThreshold = 1) {
  const tradeCount = Array.isArray(trades) ? trades.length : 0;
  const metricTrades = Number(metrics?.totalTrades);
  const noTrades = tradeCount === 0 || (Number.isFinite(metricTrades) && metricTrades === 0);
  if (!noTrades) return false;

  const equity = Array.isArray(equityCurve) ? equityCurve : [];
  if (equity.length < 2) return false;

  let first = null;
  let last = null;
  let peak = null;
  let maxDd = 0;
  for (const pt of equity) {
    const v = Number(pt?.value);
    if (!Number.isFinite(v)) continue;
    if (first == null) first = v;
    last = v;
    if (peak == null || v > peak) peak = v;
    if (peak > 0) {
      const dd = ((peak - v) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  if (first == null || last == null || !(Math.abs(first) > 0)) return false;
  const movePct = (Math.abs(last - first) / Math.abs(first)) * 100;
  return movePct >= movePctThreshold || maxDd >= movePctThreshold;
}

function buildEquityFromTrades(trades, initialCapital = 1000) {
  if (!trades?.length) return [];
  let capital = Number(initialCapital) || 1000;
  const firstDate = trades[0]?.openTime || trades[0]?.date;
  const curve = firstDate ? [{ date: firstDate, value: capital }] : [];
  for (const t of trades) {
    capital += Number(t.pnl ?? t.netPnL ?? 0);
    curve.push({
      date: t.closeTime || t.date,
      value: Math.round(capital * 100) / 100,
    });
  }
  return curve;
}

/**
 * Heal archive payload on read so corrupted COALESCE rows never reach the UI.
 * Prefer trades as source of truth; clear moving equity when trades are empty.
 * @returns {{ metrics, trades, equity_curve, healed: boolean, healReason: string|null }}
 */
function healArchivePayload({ metrics, trades, equity_curve, capital = 1000 } = {}) {
  const tradesArr = Array.isArray(trades) ? trades : [];
  const equity = Array.isArray(equity_curve) ? equity_curve : [];
  const cap = Number(capital) || 1000;
  let nextMetrics = metrics || {};
  let nextEquity = equity;
  let healed = false;
  let healReason = null;

  if (tradesArr.length > 0) {
    const rebuilt = recalcMetrics(tradesArr, cap);
    const metricTrades = Number(nextMetrics?.totalTrades);
    if (!Number.isFinite(metricTrades) || metricTrades !== tradesArr.length) {
      nextMetrics = { ...nextMetrics, ...rebuilt };
      healed = true;
      healReason = "rebuild_metrics_from_trades";
    }
    if (isEquityTradesDesync(nextMetrics, tradesArr, nextEquity) || !nextEquity.length) {
      nextEquity = buildEquityFromTrades(tradesArr, cap);
      healed = true;
      healReason = healReason || "rebuild_equity_from_trades";
    }
  } else if (isEquityTradesDesync(nextMetrics, tradesArr, nextEquity)) {
    nextEquity = [];
    nextMetrics = { ...nextMetrics, ...recalcMetrics([], cap) };
    healed = true;
    healReason = "clear_equity_empty_trades";
  }

  return {
    metrics: nextMetrics,
    trades: tradesArr,
    equity_curve: nextEquity,
    healed,
    healReason,
  };
}

module.exports = {
  ENGINE_VERSION,
  buildCanonicalKey,
  filterSubset,
  resolveAction,
  recalcMetrics,
  filterTradesByRange,
  assertAtomicCanonicalExtendPayload,
  isEquityTradesDesync,
  healArchivePayload,
  buildEquityFromTrades,
};
