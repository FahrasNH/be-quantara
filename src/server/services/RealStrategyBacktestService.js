/**
 * RealStrategyBacktestService.js — Server-side 1:1 backtest engine.
 *
 * Replays historical candles through the REAL strategy classes
 * (AdaptiveFusionStrategy.detectSignal / calculateRiskConfig) + the REAL HTF
 * trend filter (detectHTFTrend) + the REAL risk gates, mirroring the decision
 * path of AdaptiveStrategyEngine._tick() / BotEngine._checkRiskGates().
 *
 * WHY: the legacy backtest ran a SIMPLIFIED re-implementation in the browser
 * (fe/src/engine/strategyBacktest.js) that drifted from live — different voting
 * logic, only an HTF *strength* gate (no directional block), flat SL/TP (not
 * component-aware), an EMA-reversal "Signal" exit that live does NOT have, and
 * single-timeframe (no 15m-entry + 1h-HTF layering). This engine removes that
 * drift by calling the same code live uses.
 *
 * Intentionally EXCLUDED (live-execution concerns, not strategy decisions —
 * they don't change which trades the strategy takes):
 *   - live ticker price / stale-signal guard (backtest fills at candle close)
 *   - signal idempotency cache (only matters for the 15-min live tick cache)
 *   - group coordinator / cross-bot account gates
 *   - exchange min-lot / margin-budget feasibility
 *
 * Exit model mirrors live AF: SL or TP only (intrabar high/low, SL checked
 * first = conservative). No opposite-signal exit.
 */

const { calcIndicators, detectHTFTrend } = require("../../domain/indicators");
const { strategyRegistry } = require("../../domain/strategy");
const { STRATEGIES } = require("../../domain/legacyStrategies");

const FEE_RATE_PER_SIDE = 0.0006; // Bitget USDT-M taker ~0.06%/side
const DEFAULT_SLIPPAGE = 0.0005;

/** Map an entry-bar timestamp → index of last CLOSED htf candle at/just before it. */
function buildHtfIndexPointer(entryCandles, htfCandles) {
  const out = new Array(entryCandles.length).fill(-1);
  let j = 0;
  for (let i = 0; i < entryCandles.length; i++) {
    const t = entryCandles[i].timestamp;
    while (j < htfCandles.length && htfCandles[j].timestamp <= t) j++;
    out[i] = j - 1; // last htf candle whose open-time <= entry bar time
  }
  return out;
}

function isoOf(c) {
  if (c.date) return c.date;
  const ts = c.timestamp ?? c.openTime ?? c.time;
  return ts != null ? new Date(ts).toISOString() : null;
}

/**
 * Run a faithful server-side backtest.
 *
 * @param {Object}   opts
 * @param {Array}    opts.entryCandles  - entry-TF candles {timestamp,open,high,low,close,volume}
 * @param {Array}    opts.htfCandles    - HTF candles (null = no HTF filter)
 * @param {string}   opts.strategyKey   - e.g. "ADAPTIVE_FUSION"
 * @param {number}   opts.capital       - starting capital
 * @param {Object}   [opts.config]      - override of the canonical strategy config
 * @param {boolean}  [opts.enableFees=true]
 * @param {boolean}  [opts.enableSlippage=false]
 * @returns {{trades:Array, equity:Array, stats:Object, meta:Object}}
 */
function runRealBacktest(opts = {}) {
  const {
    entryCandles = [],
    htfCandles = null,
    strategyKey = "ADAPTIVE_FUSION",
    capital: startCapital = 1000,
    enableFees = true,
    enableSlippage = false,
  } = opts;

  const validation = strategyRegistry.validate(strategyKey);
  if (!validation.valid) {
    throw new Error(`Invalid strategy "${strategyKey}": ${validation.error}`);
  }
  const strategy = validation.strategy;

  // Canonical live config (legacyStrategies) merged with caller overrides.
  const base = STRATEGIES[strategyKey] || {};
  const cfg = { ...base, ...(opts.config || {}) };

  const feeRate = enableFees ? FEE_RATE_PER_SIDE : 0;
  const slip = enableSlippage ? (cfg.slippagePct ?? DEFAULT_SLIPPAGE) : 0;

  const indicators = calcIndicators(entryCandles, {
    emaFast: cfg.emaFast ?? 9,
    emaSlow: cfg.emaSlow ?? 21,
    emaTrend: cfg.emaTrend ?? 50,
    rsiPeriod: cfg.rsiPeriod ?? 14,
    atrPeriod: cfg.atrPeriod ?? 14,
  });

  const htfPtr = htfCandles?.length
    ? buildHtfIndexPointer(entryCandles, htfCandles)
    : null;
  const htfTrendCache = new Map(); // htfIdx → trend string (recompute only on advance)

  function htfTrendAt(i) {
    if (!htfPtr) return null;
    const j = htfPtr[i];
    if (j < 0) return "UNKNOWN"; // no closed HTF candle yet → fail-closed (live parity)
    if (htfTrendCache.has(j)) return htfTrendCache.get(j);
    const window = htfCandles.slice(0, j + 1);
    const trend = detectHTFTrend(window, {
      htfEmaFast: cfg.htfEmaFast ?? 9,
      htfEmaSlow: cfg.htfEmaSlow ?? 21,
      sidewaysThresholdPct: cfg.sidewaysThresholdPct ?? 0.2,
    });
    htfTrendCache.set(j, trend);
    return trend;
  }

  // ── Replay state (mirror BotEngine state used by _checkRiskGates) ──────────
  let capital = startCapital;
  const trades = [];
  const equity = [{ date: isoOf(entryCandles[0]), value: capital }];

  let position = null; // { side, entry, sl, tp, slDist, size, openIdx, component, marketCond }
  let cooldownUntil = 0; // ms epoch
  let consecLoss = 0;
  let dayKey = null;
  let dailyTradeCount = 0;
  let dailyLoss = 0;
  let dailyStartCapital = capital;

  const maxConsecLoss = cfg.maxConsecLoss ?? 2;
  const maxTradesPerDay = cfg.maxTradesPerDay ?? 6;
  const maxDailyLossPct = cfg.maxDailyLossPct ?? 0.035;
  const atrMinPct = cfg.atrMinMult ?? 0;
  const atrMaxPct = cfg.atrMaxMult ?? Infinity;
  const cooldownMs = (cfg.cooldownAfterLoss ?? 0) * 60000;
  const riskPerTrade = cfg.riskPerTrade ?? 0.01;
  const higherTf = cfg.higherTf ?? null;

  const warmup = Math.max(cfg.emaSlow ?? 21, cfg.atrPeriod ?? 14, 30) + 2;

  function closePosition(exitPrice, reason, exitIdx) {
    let px = exitPrice;
    if (slip) px = position.side === "LONG" ? px * (1 - slip) : px * (1 + slip);
    const grossPnl = position.side === "LONG"
      ? (px - position.entry) * position.size
      : (position.entry - px) * position.size;
    const fee = feeRate * (position.entry + px) * position.size;
    const pnl = grossPnl - fee;
    capital += pnl;

    if (pnl < 0) {
      consecLoss += 1;
      dailyLoss += Math.abs(pnl);
      cooldownUntil = (entryCandles[exitIdx].timestamp ?? 0) + cooldownMs;
    } else {
      consecLoss = 0;
    }

    const closeTime = isoOf(entryCandles[exitIdx]);
    trades.push({
      date: closeTime, // display field (FE trade table reads t.date) — close-bar date
      openTime: isoOf(entryCandles[position.openIdx]),
      closeTime,
      side: position.side,
      strategy: strategyKey,
      component: position.component,
      marketCond: position.marketCond,
      entry: position.entry,
      exit: px,
      sl: position.sl,
      tp: position.tp,
      size: position.size,
      grossPnl,
      fee,
      pnl,
      pnlPct: (pnl / (position.entry * position.size)) * 100,
      plannedRR: position.plannedRR,
      reason,
      result: pnl > 0 ? "win" : "loss",
    });
    position = null;
  }

  for (let i = warmup; i < entryCandles.length; i++) {
    const c = entryCandles[i];
    const price = c.close;
    const atr = indicators.atr[i];
    if (atr == null || price == null) {
      equity.push({ date: isoOf(c), value: round2(capital) });
      continue;
    }

    // Daily counters reset (UTC day) — mirror BotEngine daily roll.
    const dk = (isoOf(c) || "").slice(0, 10);
    if (dk !== dayKey) {
      dayKey = dk;
      dailyTradeCount = 0;
      dailyLoss = 0;
      dailyStartCapital = capital;
    }

    // ── 1. Manage open position FIRST (intrabar SL/TP, SL checked first) ─────
    if (position) {
      const hitSL = position.side === "LONG" ? c.low <= position.sl : c.high >= position.sl;
      const hitTP = position.side === "LONG" ? c.high >= position.tp : c.low <= position.tp;
      if (hitSL) closePosition(position.sl, "SL", i);
      else if (hitTP) closePosition(position.tp, "TP", i);
    }

    if (position) { // still open → no new entry
      equity.push({ date: isoOf(c), value: round2(capital) });
      continue;
    }

    // ── 2. Market conditions (mirror AdaptiveStrategyEngine._tick step 4) ───
    const emaF = indicators.emaFast?.[i];
    const emaS = indicators.emaSlow?.[i];
    const volatility = atr && price ? (atr / price) * 100 : 1.0;
    const emaDelta = emaS > 0 ? Math.abs(emaF - emaS) / emaS : 0;
    const trendStrength = Math.min(emaDelta * 50, 1.0);

    // ── 3. HTF trend + fail-closed (mirror step 6b/6c) ──────────────────────
    const htfTrend = htfTrendAt(i);
    if (higherTf && htfTrend === "UNKNOWN") {
      equity.push({ date: isoOf(c), value: round2(capital) });
      continue;
    }

    // ── 4. REAL signal detection (same call signature live uses) ────────────
    const signal = strategy.detectSignal(indicators, i, {
      balance: capital,
      volatility,
      trend_strength: trendStrength,
      htfTrend,
      maxEntryExtensionATR: cfg.maxEntryExtensionATR,
      afRejectOnDissent: cfg.afRejectOnDissent,
      afMinVotes: cfg.afMinVotes,
      pairTier: cfg.pairTier,
      tierOverrides: cfg.tierOverrides,
    });
    if (!signal) { equity.push({ date: isoOf(c), value: round2(capital) }); continue; }

    // ── 5. HTF directional block (mirror step 7a) ───────────────────────────
    if (signal === "LONG" && htfTrend === "BEARISH") { equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    if (signal === "SHORT" && htfTrend === "BULLISH") { equity.push({ date: isoOf(c), value: round2(capital) }); continue; }

    // ── 6. Risk gates (mirror BotEngine._checkRiskGates) ────────────────────
    const nowMs = c.timestamp ?? 0;
    if (cooldownUntil && nowMs < cooldownUntil) { equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    if (consecLoss >= maxConsecLoss) { equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    if (dailyTradeCount >= maxTradesPerDay) { equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    const dailyBase = dailyStartCapital || capital;
    if (dailyBase > 0 && dailyLoss / dailyBase >= maxDailyLossPct) { equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    const atrPct = (atr / price) * 100;
    if (atrPct < atrMinPct || atrPct > atrMaxPct) { equity.push({ date: isoOf(c), value: round2(capital) }); continue; }

    // ── 7. validateEntry (mirror step 9) ────────────────────────────────────
    if (typeof strategy.validateEntry === "function") {
      try {
        const v = strategy.validateEntry(price, atr, c.volume, indicators.volSMA?.[i] || 0);
        if (v && v.valid === false) { equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
      } catch { /* degrade open — same as live */ }
    }

    // ── 8. Component-aware SL/TP (mirror step 11d) ──────────────────────────
    const meta = typeof strategy.getLastSignalMeta === "function" ? strategy.getLastSignalMeta() : null;
    let slDist, tpDist, component = "B", marketCond = null, plannedRR = null;
    if (meta && typeof strategy.calculateRiskConfig === "function") {
      const rc = strategy.calculateRiskConfig(price, atr, signal, meta.component, {
        marketCond: meta.marketCond,
        strongTrendTPMult: cfg.strongTrendTPMult ?? 1,
      });
      slDist = rc.slDistance;
      tpDist = rc.tpDistance;
      component = meta.component;
      marketCond = meta.marketCond;
      plannedRR = rc.riskReward;
    } else {
      slDist = atr * (cfg.atrMultiplier ?? 1.4);
      tpDist = slDist * (cfg.riskReward ?? 2);
      plannedRR = (cfg.riskReward ?? 2);
    }
    if (!(slDist > 0)) { equity.push({ date: isoOf(c), value: round2(capital) }); continue; }

    // ── 9. Open position (risk-based sizing; leverage irrelevant to PnL) ─────
    const entry = price;
    const size = (capital * riskPerTrade) / slDist;
    position = {
      side: signal,
      entry,
      sl: signal === "LONG" ? entry - slDist : entry + slDist,
      tp: signal === "LONG" ? entry + tpDist : entry - tpDist,
      slDist,
      size,
      openIdx: i,
      component,
      marketCond,
      plannedRR,
    };
    dailyTradeCount += 1;

    equity.push({ date: isoOf(c), value: round2(capital) });
  }

  return {
    trades,
    equity,
    stats: buildStats(trades, startCapital, capital),
    meta: {
      strategyKey,
      entryBars: entryCandles.length,
      htfBars: htfCandles?.length ?? 0,
      higherTf,
      feeRate,
      slippage: slip,
    },
  };
}

function round2(v) { return Math.round(v * 100) / 100; }

function buildStats(trades, startCapital, endCapital) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalFees = trades.reduce((s, t) => s + (t.fee || 0), 0);
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  // Max drawdown from realized equity curve
  let peak = startCapital, bal = startCapital, mdd = 0;
  for (const t of trades) {
    bal += t.pnl;
    peak = Math.max(peak, bal);
    mdd = Math.max(mdd, peak > 0 ? (peak - bal) / peak : 0);
  }

  // Sharpe on per-trade returns (annualized, matches FE convention sqrt(252))
  const rets = trades.map(t => t.pnl);
  const avg = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1
    ? Math.sqrt(rets.reduce((s, r) => s + (r - avg) ** 2, 0) / (rets.length - 1))
    : 0;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length * 100).toFixed(1) : "0.0",
    totalReturn: ((endCapital - startCapital) / startCapital * 100).toFixed(2),
    finalCapital: endCapital.toFixed(2),
    profitFactor: grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? "Inf" : "0.00"),
    avgWin: avgWin.toFixed(2),
    avgLoss: avgLoss.toFixed(2),
    riskReward: avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : "0.00",
    maxDrawdown: (mdd * 100).toFixed(2),
    sharpe: std > 0 ? ((avg / std) * Math.sqrt(252)).toFixed(2) : "0.00",
    totalFees: totalFees.toFixed(2),
  };
}

module.exports = { runRealBacktest };
