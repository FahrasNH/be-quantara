/**
 * BacktestCanonicalService — Opsi B shared archive
 * Satu row per canonical_key; update in-place; filter subset tanpa INSERT baru.
 */

const crypto = require("crypto");

/** Bump saat strategyBacktest.js / logika metrik berubah material. */
const ENGINE_VERSION = "fe-1.0.0";

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

module.exports = {
  ENGINE_VERSION,
  buildCanonicalKey,
  filterSubset,
  resolveAction,
  recalcMetrics,
  filterTradesByRange,
};
