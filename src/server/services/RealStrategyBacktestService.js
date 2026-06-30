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

const { calcIndicators, detectHTFTrend, calcEMA, calcATR } = require("../../domain/indicators");
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
// Multi-position backtest (v3.0): each AF component opens independent positions
// Pass opts.debug=true to get a per-bar rejection log (capped at 500 entries).
function _runMultiPositionBacktest(opts, strategy, cfg, feeRate, slip, entryCandles, htfCandles) {
  const strategyKey = opts.strategyKey || "ADAPTIVE_FUSION";
  const startCapital = opts.capital || 1000;

  const indicators = calcIndicators(entryCandles, {
    emaFast: cfg.emaFast ?? 9,
    emaSlow: cfg.emaSlow ?? 21,
    emaTrend: cfg.emaTrend ?? 50,
    rsiPeriod: cfg.rsiPeriod ?? 14,
    atrPeriod: cfg.atrPeriod ?? 14,
  });

  const htfPtr = htfCandles?.length ? buildHtfIndexPointer(entryCandles, htfCandles) : null;
  const htfTrendCache = new Map();

  // Pre-compute HTF EMA fast/slow + ATR arrays for htfTrendStrength (mirrors BotEngine live calc)
  let htfEmaFastArr = null, htfEmaSlowArr = null, htfAtrArr = null;
  if (htfCandles?.length) {
    const htfCloses = htfCandles.map(c => c.close);
    const htfHighs  = htfCandles.map(c => c.high);
    const htfLows   = htfCandles.map(c => c.low);
    htfEmaFastArr = calcEMA(htfCloses, cfg.htfEmaFast ?? 9);
    htfEmaSlowArr = calcEMA(htfCloses, cfg.htfEmaSlow ?? 21);
    htfAtrArr     = calcATR(htfHighs, htfLows, htfCloses, cfg.atrPeriod ?? 14);
  }

  function htfStrengthAt(i) {
    if (!htfPtr || !htfEmaFastArr) return null;
    const j = htfPtr[i];
    if (j < 0) return null;
    const hEmaF = htfEmaFastArr[j];
    const hEmaS = htfEmaSlowArr[j];
    const hAtr  = htfAtrArr[j];
    if (hEmaF == null || hEmaS == null || hAtr == null || hAtr <= 0) return null;
    return Math.min(Math.abs(hEmaF - hEmaS) / hAtr, 1.0);
  }

  function htfTrendAt(i) {
    if (!htfPtr) return null;
    const j = htfPtr[i];
    if (j < 0) return "UNKNOWN";
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

  const trades = [];
  const equity = [{ date: isoOf(entryCandles[0]), value: startCapital }];
  const debugLog = opts.debug ? [] : null; // per-bar rejection log (debug mode only)

  // Multi-position state: Map<componentId, { side, entry, sl, tp, size, openIdx, ... }>
  const positions = new Map();
  const componentCooldown = new Map();
  const componentConsecLoss = new Map();

  let capital = startCapital;
  let dayKey = null;
  let dailyTradeCount = 0;
  let dailyLoss = 0;
  let dailyStartCapital = startCapital;

  const maxConsecLoss = cfg.maxConsecLoss ?? 2;
  const maxTradesPerDay = cfg.maxTradesPerDay ?? 6;
  const maxDailyLossPct = cfg.maxDailyLossPct ?? 0.035;
  const atrMinPct = cfg.atrMinMult ?? 0;
  const atrMaxPct = cfg.atrMaxMult ?? Infinity;
  const cooldownMs = (cfg.cooldownAfterLoss ?? 0) * 60000;
  const riskPerTrade = cfg.riskPerTrade ?? 0.01;

  const warmup = Math.max(cfg.emaSlow ?? 21, cfg.atrPeriod ?? 14, 30) + 2;

  function closePosition(componentId, position, exitPrice, reason, exitIdx) {
    let px = exitPrice;
    if (slip) px = position.side === "LONG" ? px * (1 - slip) : px * (1 + slip);
    const grossPnl = position.side === "LONG"
      ? (px - position.entry) * position.size
      : (position.entry - px) * position.size;
    const fee = feeRate * (position.entry + px) * position.size;
    const pnl = grossPnl - fee;
    capital += pnl;

    if (pnl < 0) {
      const compLoss = (componentConsecLoss.get(componentId) || 0) + 1;
      componentConsecLoss.set(componentId, compLoss);
      dailyLoss += Math.abs(pnl);
      componentCooldown.set(componentId, (entryCandles[exitIdx].timestamp ?? 0) + cooldownMs);
    } else {
      componentConsecLoss.set(componentId, 0);
    }

    const closeTime = isoOf(entryCandles[exitIdx]);
    // Use human-readable trade type label if strategy supports it
    const tradeTypeLabel = typeof strategy.getTradeTypeLabel === "function"
      ? strategy.getTradeTypeLabel(componentId)
      : componentId;

    trades.push({
      date: closeTime,
      openTime: isoOf(entryCandles[position.openIdx]),
      closeTime,
      side: position.side,
      strategy: strategyKey,
      component: tradeTypeLabel,
      tradeType: tradeTypeLabel,
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
      confidence: position.confidence ?? null, // AF-FIX-01: entry conviction (0–100)
      reason,
      result: pnl > 0 ? "win" : "loss",
    });
    positions.delete(componentId);
  }

  // Main loop
  for (let i = warmup; i < entryCandles.length; i++) {
    const c = entryCandles[i];
    const price = c.close;
    const atr = indicators.atr[i];
    if (atr == null || price == null) {
      equity.push({ date: isoOf(c), value: round2(capital) });
      continue;
    }

    const dk = (isoOf(c) || "").slice(0, 10);
    if (dk !== dayKey) {
      dayKey = dk;
      dailyTradeCount = 0;
      dailyLoss = 0;
      dailyStartCapital = capital;
    }

    // Monitor all open positions for SL/TP
    for (const [componentId, pos] of positions.entries()) {
      const hitSL = pos.side === "LONG" ? c.low <= pos.sl : c.high >= pos.sl;
      const hitTP = pos.side === "LONG" ? c.high >= pos.tp : c.low <= pos.tp;
      if (hitSL) {
        closePosition(componentId, pos, pos.sl, "SL", i);
      } else if (hitTP) {
        closePosition(componentId, pos, pos.tp, "TP", i);
      }
    }

    // Check market conditions
    const emaF = indicators.emaFast?.[i];
    const emaS = indicators.emaSlow?.[i];
    const volatility = atr && price ? (atr / price) * 100 : 1.0;
    const emaDelta = emaS > 0 ? Math.abs(emaF - emaS) / emaS : 0;
    const trendStrength = Math.min(emaDelta * 50, 1.0);

    const htfTrend = htfTrendAt(i);
    if (htfTrend === "UNKNOWN") continue; // fail-closed

    // Detect multi-component signals (AF v3.0)
    const multiSignal = strategy.detectSignalMulti(indicators, i, {
      balance: capital,
      volatility,
      trend_strength: trendStrength,
      htfTrend,
      htfTrendStrength: htfStrengthAt(i), // v3.3 fix: was missing → htfTrendStrengthMin gate blocked all
      maxEntryExtensionATR: cfg.maxEntryExtensionATR,
      afRejectOnDissent: cfg.afRejectOnDissent,
      pairTier: cfg.pairTier,
      tierOverrides: cfg.tierOverrides,
      volSmaMultiplier: cfg.volSmaMultiplier,
      marketThresholds: cfg.marketThresholds, // v3.0: TF-aware regime calibration
      afEnabledComponents: cfg.afEnabledComponents, // v3.2: C-only by default
      afMinComponentConfidence: cfg.afMinComponentConfidence, // AF-FIX-02 conviction gate
      afMinAggregateConfidence: cfg.afMinAggregateConfidence, // AF-FIX-03
    });


    const nowMs = c.timestamp ?? 0; // backtest "now" = current candle time (NOT wall-clock)

    // Debug: log rejection reason for each bar (capped at 500 to avoid huge responses)
    if (debugLog != null && debugLog.length < 500) {
      const anyFired = ["Scalping", "Intraday", "Swing"].some(k => multiSignal[k]);
      if (!anyFired) {
        const blockReasons = [];
        const mc = multiSignal.meta?.marketCond;
        if (mc === "DEAD_MARKET")     blockReasons.push("DEAD_MARKET");
        if (mc === "CHOPPY_VOLATILE") blockReasons.push("CHOPPY_VOLATILE");
        if (htfTrend === "UNKNOWN")   blockReasons.push("htfTrend=UNKNOWN");
        const conf = multiSignal.meta?.confidence || {};
        const compSigs = {};
        // Re-run with gate off to see what the raw signal would have been
        const rawMulti = strategy.detectSignalMulti(indicators, i, {
          balance: capital, volatility, trend_strength: trendStrength,
          htfTrend, htfTrendStrength: htfStrengthAt(i),
          maxEntryExtensionATR: cfg.maxEntryExtensionATR,
          afEnabledComponents: cfg.afEnabledComponents,
          // gates OFF for diagnosis:
          afMinComponentConfidence: 0, afMinAggregateConfidence: 0,
        });
        for (const k of ["Scalping", "Intraday", "Swing"]) {
          compSigs[k] = rawMulti[k] ?? "null";
          if (rawMulti[k] && !multiSignal[k]) {
            const c_ = conf[k];
            if (c_ != null && c_ < (cfg.afMinComponentConfidence ?? 60)) {
              blockReasons.push(`${k}: conf=${c_}<${cfg.afMinComponentConfidence ?? 60}`);
            } else {
              blockReasons.push(`${k}: htf/chase/netEdge block`);
            }
          }
        }
        debugLog.push({
          date: isoOf(c), bar: i, marketCond: mc, htfTrend,
          volatility: +volatility.toFixed(3), trendStrength: +trendStrength.toFixed(3),
          rawSignals: compSigs, confidence: conf, blockReasons,
        });
      }
    }

    // Check each trade type for independent entry (type names + legacy letters deduped by position Map)
    const tradeTypeKeys = ["Scalping", "Intraday", "Swing"];
    for (const componentId of tradeTypeKeys) {
      const signal = multiSignal[componentId];
      if (!signal) continue;

      // Skip if component already has open position
      if (positions.has(componentId)) continue;

      // Skip if component in cooldown (use candle time, not Date.now())
      const cooldown = componentCooldown.get(componentId);
      if (cooldown && nowMs < cooldown) continue;

      // Skip if component exceeded max consecutive loss
      const compLoss = componentConsecLoss.get(componentId) || 0;
      if (compLoss >= maxConsecLoss) continue;

      // Check daily limits
      if (dailyTradeCount >= maxTradesPerDay) continue;
      const dailyBase = dailyStartCapital || capital;
      if (dailyBase > 0 && dailyLoss / dailyBase >= maxDailyLossPct) continue;

      // Check ATR gate
      const atrPct = (atr / price) * 100;
      if (atrPct < atrMinPct || atrPct > atrMaxPct) continue;

      // Calculate risk config for this component. Pass the REAL regime so
      // strongTrendTPMult (let winners run in STRONG_TREND) can fire — it was
      // hardcoded "NORMAL", so the ×1.8 TP extension never applied and every
      // winner was capped at the base RR.
      const regime = multiSignal.meta?.marketCond || "NORMAL";
      const riskCfg = strategy.calculateRiskConfig(price, atr, signal, componentId, {
        marketCond: regime,
        strongTrendTPMult: cfg.strongTrendTPMult ?? 1,
      });

      const slDist = riskCfg.slDistance;
      const tpDist = riskCfg.tpDistance;
      const sl = signal === "LONG" ? price - slDist : price + slDist;
      const tp = signal === "LONG" ? price + tpDist : price - tpDist;

      if (!Number.isFinite(sl) || !Number.isFinite(tp)) continue;

      // Calculate position size — risk-based: the loss when SL is hit must equal
      // riskAmt. size = riskAmt / slDist. Dividing by the FULL SL→TP span (as
      // before) shrank every position ~2.8× → effective risk ~0.18% instead of
      // the configured 0.5%, which is why return + drawdown were both tiny.
      const riskAmt = capital * riskPerTrade;
      const size = slDist > 0 ? riskAmt / slDist : 0;

      if (size <= 0) continue;

      // Open position
      positions.set(componentId, {
        side: signal,
        entry: price,
        sl,
        tp,
        size,
        riskAmt,
        openIdx: i,
        component: componentId,
        marketCond: regime,
        plannedRR: riskCfg.riskReward,
        // AF-FIX-01: conviction score that cleared the entry gate (for reporting).
        confidence: multiSignal.meta?.confidence?.[componentId] ?? null,
      });

      dailyTradeCount += 1;
    }

    equity.push({ date: isoOf(c), value: round2(capital) });
  }

  // Compile stats
  const wins = trades.filter(t => t.result === "win");
  const losses = trades.filter(t => t.result === "loss");
  const totalReturn = ((capital - startCapital) / startCapital) * 100;

  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? "Inf" : "0.00");

  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const riskReward = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : "0.00";

  // Max drawdown
  let peak = startCapital, bal = startCapital, mdd = 0;
  for (const t of trades) {
    bal += t.pnl;
    peak = Math.max(peak, bal);
    mdd = Math.max(mdd, peak > 0 ? (peak - bal) / peak : 0);
  }

  // Sharpe
  const rets = trades.map(t => t.pnl);
  const avg = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1
    ? Math.sqrt(rets.reduce((s, r) => s + (r - avg) ** 2, 0) / (rets.length - 1))
    : 0;
  const sharpe = std > 0 ? ((avg / std) * Math.sqrt(252)).toFixed(2) : "0.00";

  return {
    ok: true,
    trades,
    equity,
    debugLog: debugLog ?? undefined, // only present when opts.debug=true
    stats: {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : "0.0",
      totalReturn: totalReturn.toFixed(2),
      finalCapital: capital.toFixed(2),
      profitFactor,
      avgWin: avgWin.toFixed(2),
      avgLoss: avgLoss.toFixed(2),
      riskReward,
      maxDrawdown: (mdd * 100).toFixed(2),
      sharpe,
      totalFees: trades.reduce((s, t) => s + (t.fee || 0), 0).toFixed(2),
    },
    meta: {
      strategyKey,
      entryBars: entryCandles.length,
      htfBars: htfCandles?.length ?? 0,
      higherTf: cfg.higherTf || null,
      feeRate: FEE_RATE_PER_SIDE,
      slippage: slip,
    },
  };
}

/**
 * Run AF_SAC triple-timeframe backtest:
 * Each trade type (Scalping/Intraday/Swing) runs on its own candle set independently.
 * Results are merged and sorted by open time.
 *
 * @param {Object} opts
 * @param {{ Scalping: Array, Intraday: Array, Swing: Array }} opts.entryCandles - candles per type
 * @param {{ Scalping: Array, Intraday: Array, Swing: Array }} opts.htfCandles   - HTF candles per type
 * @param {string}  opts.strategyKey
 * @param {number}  opts.capital
 * @param {Object}  [opts.config]
 * @param {boolean} [opts.enableFees]
 * @param {boolean} [opts.enableSlippage]
 */
function runTripleTypeBacktest(opts = {}) {
  const { strategyKey = "AF_SAC", capital: startCapital = 1000, enableFees = true, enableSlippage = false } = opts;

  const validation = strategyRegistry.validate(strategyKey);
  if (!validation.valid) throw new Error(`Invalid strategy "${strategyKey}": ${validation.error}`);
  const strategy = validation.strategy;

  const base = STRATEGIES[strategyKey] || {};
  const cfg = { ...base, ...(opts.config || {}) };
  const feeRate = enableFees ? FEE_RATE_PER_SIDE : 0;
  const slip    = enableSlippage ? (cfg.slippagePct ?? DEFAULT_SLIPPAGE) : 0;

  const typeOrder = ["Scalping", "Intraday", "Swing"];
  const allTrades = [];
  const perTypeStats = {};

  // Capital is shared across types (concurrent risk)
  // Each type uses its own candle set but all draw from the same capital pool
  // For simplicity in backtest: run each type independently on full capital,
  // but size each position at 1/3 risk so combined max loss = configured riskPerTrade
  const typeConfig = { ...cfg, riskPerTrade: (cfg.riskPerTrade ?? 0.01) / typeOrder.length };

  for (const tradeType of typeOrder) {
    const entryCandles = opts.entryCandles?.[tradeType];
    const htfCandles   = opts.htfCandles?.[tradeType];

    if (!entryCandles?.length || entryCandles.length < 60) {
      perTypeStats[tradeType] = { skipped: true, reason: "Insufficient candles" };
      continue;
    }

    const typeResult = _runMultiPositionBacktest(
      { ...opts, strategyKey, config: typeConfig, debug: false },
      strategy,
      typeConfig,
      feeRate,
      slip,
      entryCandles,
      htfCandles || null,
    );

    // Tag each trade with its type (overwrite component field)
    for (const t of typeResult.trades) {
      allTrades.push({ ...t, component: tradeType, tradeType });
    }
    perTypeStats[tradeType] = {
      trades: typeResult.trades.length,
      wins: typeResult.trades.filter(t => t.result === "win").length,
      entryBars: entryCandles.length,
      htfBars: htfCandles?.length ?? 0,
    };
  }

  // Sort all trades by openTime
  allTrades.sort((a, b) => new Date(a.openTime || a.date) - new Date(b.openTime || b.date));

  // Recalculate equity + stats from merged trades on shared capital
  let capital = startCapital;
  const firstDate = allTrades[0]?.openTime || allTrades[0]?.date;
  const equity = [{ date: firstDate, value: startCapital }];
  for (const t of allTrades) {
    capital += t.pnl;
    equity.push({ date: t.closeTime || t.date, value: round2(capital) });
  }

  const wins   = allTrades.filter(t => t.result === "win");
  const losses = allTrades.filter(t => t.result === "loss");
  const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  let peak = startCapital, mdd = 0, bal = startCapital;
  for (const t of allTrades) {
    bal  += t.pnl;
    peak  = Math.max(peak, bal);
    mdd   = Math.max(mdd, peak > 0 ? (peak - bal) / peak : 0);
  }

  const rets = allTrades.map(t => t.pnl);
  const avg  = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std  = rets.length > 1
    ? Math.sqrt(rets.reduce((s, r) => s + (r - avg) ** 2, 0) / (rets.length - 1))
    : 0;

  return {
    ok: true,
    trades: allTrades,
    equity,
    perTypeStats,
    stats: {
      totalTrades: allTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: allTrades.length > 0 ? (wins.length / allTrades.length * 100).toFixed(1) : "0.0",
      totalReturn: ((capital - startCapital) / startCapital * 100).toFixed(2),
      finalCapital: capital.toFixed(2),
      profitFactor: grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? "Inf" : "0.00"),
      avgWin:  wins.length   ? (grossWin  / wins.length).toFixed(2)   : "0.00",
      avgLoss: losses.length ? (grossLoss / losses.length).toFixed(2) : "0.00",
      riskReward: (losses.length && wins.length)
        ? ((grossWin / wins.length) / (grossLoss / losses.length)).toFixed(2)
        : "0.00",
      maxDrawdown: (mdd * 100).toFixed(2),
      sharpe: std > 0 ? ((avg / std) * Math.sqrt(252)).toFixed(2) : "0.00",
      totalFees: allTrades.reduce((s, t) => s + (t.fee || 0), 0).toFixed(2),
    },
    meta: { strategyKey, mode: "triple-timeframe", perTypeStats },
  };
}

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

  // Multi-position mode (v3.0): ADAPTIVE_FUSION opens up to 3 concurrent positions
  const multiPosMode = opts.useMultiPosition || strategyKey === "ADAPTIVE_FUSION";

  if (multiPosMode) {
    return _runMultiPositionBacktest(opts, strategy, cfg, feeRate, slip, entryCandles, htfCandles);
  }

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

  // Gate funnel — counts WHY candles don't become trades (diagnose 0-trade runs).
  const diag = {
    barsEvaluated: 0, htfUnknownSkip: 0, signalNull: 0, htfDirBlock: 0,
    cooldownBlock: 0, consecLossBlock: 0, maxTradesBlock: 0, dailyLossBlock: 0,
    atrGateBlock: 0, validateBlock: 0, opened: 0,
  };

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
      confidence: position.confidence ?? null, // AF-FIX-01: entry conviction (0–100)
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

    diag.barsEvaluated += 1;

    // ── 2. Market conditions (mirror AdaptiveStrategyEngine._tick step 4) ───
    const emaF = indicators.emaFast?.[i];
    const emaS = indicators.emaSlow?.[i];
    const volatility = atr && price ? (atr / price) * 100 : 1.0;
    const emaDelta = emaS > 0 ? Math.abs(emaF - emaS) / emaS : 0;
    const trendStrength = Math.min(emaDelta * 50, 1.0);

    // ── 3. HTF trend + fail-closed (mirror step 6b/6c) ──────────────────────
    const htfTrend = htfTrendAt(i);
    if (higherTf && htfTrend === "UNKNOWN") {
      diag.htfUnknownSkip += 1;
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
      afMinComponentConfidence: cfg.afMinComponentConfidence, // AF-FIX-02
      afMinAggregateConfidence: cfg.afMinAggregateConfidence, // AF-FIX-03
      pairTier: cfg.pairTier,
      tierOverrides: cfg.tierOverrides,
    });
    if (!signal) { diag.signalNull += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }

    // ── 5. HTF directional block (mirror step 7a) ───────────────────────────
    if (signal === "LONG" && htfTrend === "BEARISH") { diag.htfDirBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    if (signal === "SHORT" && htfTrend === "BULLISH") { diag.htfDirBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }

    // ── 6. Risk gates (mirror BotEngine._checkRiskGates) ────────────────────
    const nowMs = c.timestamp ?? 0;
    if (cooldownUntil && nowMs < cooldownUntil) { diag.cooldownBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    if (consecLoss >= maxConsecLoss) { diag.consecLossBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    if (dailyTradeCount >= maxTradesPerDay) { diag.maxTradesBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    const dailyBase = dailyStartCapital || capital;
    if (dailyBase > 0 && dailyLoss / dailyBase >= maxDailyLossPct) { diag.dailyLossBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    const atrPct = (atr / price) * 100;
    if (atrPct < atrMinPct || atrPct > atrMaxPct) { diag.atrGateBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }

    // ── 7. validateEntry (mirror step 9) ────────────────────────────────────
    if (typeof strategy.validateEntry === "function") {
      try {
        const v = strategy.validateEntry(price, atr, c.volume, indicators.volSMA?.[i] || 0);
        if (v && v.valid === false) { diag.validateBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
      } catch { /* degrade open — same as live */ }
    }

    // ── 8. Component-aware SL/TP (mirror step 11d) ──────────────────────────
    const meta = typeof strategy.getLastSignalMeta === "function" ? strategy.getLastSignalMeta() : null;
    let slDist, tpDist, component = "B", marketCond = null, plannedRR = null, confidence = null;
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
      // AF-FIX-01/03: conviction behind this entry (component or aggregate score).
      confidence = meta.componentConfidence ?? meta.aggregateConfidence ?? null;
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
      confidence,
    };
    dailyTradeCount += 1;
    diag.opened += 1;

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
      diagnostics: diag,
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

module.exports = { runRealBacktest, runTripleTypeBacktest };
