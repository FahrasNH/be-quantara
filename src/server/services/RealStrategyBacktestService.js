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

const { calcIndicators, detectHTFTrend, calcEMA, calcATR, calcRSI, calcSMA } = require("../../domain/indicators");
const { strategyRegistry } = require("../../domain/strategy");
const { STRATEGIES } = require("../../domain/legacyStrategies");
const { meanReversionRegimeFilter } = require("../../domain/htfRegimeFilter");
const { riskShareForType } = require("../../domain/typeRiskLadder");
const { computeDailyTrendStrength, getRegimeForDate, applyRegimeGate } = require("../../domain/dailyRegimeGate");

// Strategy-key checks MUST accept BOTH v2.0 component keys and legacy long names —
// the FE sends v2.0 keys (MD_MR/BS_BR) for tier legs. `includes("MEAN_REVERSION")`
// silently failed for "MD_MR", making the MR gate exemption + regime filter dead
// code (same key-vocab lesson as the Grok gate 400 bug, c9f9d38).
const MR_KEYS = new Set(["MD_MR", "MEAN_REVERSION"]);
const BR_KEYS = new Set(["BS_BR", "BREAKOUT_RETEST", "BREAKOUT_TRADING"]);
const isMRKey = (k) => MR_KEYS.has(String(k || "").toUpperCase());
const isBRKey = (k) => BR_KEYS.has(String(k || "").toUpperCase());

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

// AF-SCALP-02: rolling mean of ATR — per-leg baseline for the relative ATR gate.
// cfg.atrMinMult/atrMaxMult are ABSOLUTE price-% bounds calibrated for a ~1h
// chart (SMC: 0.8-5%). Applied TF-agnostically they starve low-TF legs: 5m BTC
// ATR is 0.05-0.15%, so the 0.8% floor only passes during flash crashes
// (Scalping = 3 trades / 12 months, all in extreme candles, worst-possible
// fee+slippage conditions). The relative gate compares each bar's ATR to the
// leg's OWN recent baseline instead — "market not dead / not panicking" means
// the same thing on every timeframe.
function buildAtrBaseline(atrArr, window = 100) {
  if (!Array.isArray(atrArr) || !atrArr.length) return null;
  const out = new Array(atrArr.length).fill(null);
  const q = [];
  let sum = 0;
  for (let k = 0; k < atrArr.length; k++) {
    const v = atrArr[k];
    if (v != null && Number.isFinite(v)) {
      q.push(v); sum += v;
      if (q.length > window) sum -= q.shift();
    }
    out[k] = q.length ? sum / q.length : null;
  }
  return out;
}

async function _runMultiPositionBacktest(opts, strategy, cfg, feeRate, slip, entryCandles, htfCandles) {
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

  // Pre-compute daily trend strength for regime gate
  let dailyTrendCache = null;
  if (opts.dailyCandles?.length) {
    const dailyCloses = opts.dailyCandles.map(c => c.close);
    const dailyHighs = opts.dailyCandles.map(c => c.high);
    const dailyLows = opts.dailyCandles.map(c => c.low);
    const dailyTrend = computeDailyTrendStrength({
      close: dailyCloses,
      high: dailyHighs,
      low: dailyLows,
    });

    // Build dateMap for quick lookup
    const dailyDateMap = new Map();
    for (let i = 0; i < opts.dailyCandles.length; i++) {
      const dateStr = new Date(opts.dailyCandles[i].timestamp).toISOString().split("T")[0];
      dailyDateMap.set(dateStr, i);
    }

    dailyTrendCache = { dailyTrend, dateMap: dailyDateMap };
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
  // AF-SCALP-02: relative ATR gate (see buildAtrBaseline). Flag-gated for A/B —
  // live configs don't set atrGateRelative, so live gating is unchanged.
  const atrBaseline = cfg.atrGateRelative === true ? buildAtrBaseline(indicators.atr) : null;
  const atrRelMin = cfg.atrRelMin ?? 0.6;
  const atrRelMax = cfg.atrRelMax ?? 3.0;
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
      // GROK-FIX: entry-context snapshot forwarded for post-hoc Grok Confirm Gate.
      atr: position.atr ?? null,
      entryRsi: position.entryRsi ?? null,
      htfTrend: position.htfTrend ?? null,
      reason,
      result: pnl > 0 ? "win" : "loss",
    });
    positions.delete(componentId);
  }

  const totalBars = entryCandles.length;
  const progressEvery = Math.max(500, Math.floor(totalBars / 100));

  // Main loop
  for (let i = warmup; i < entryCandles.length; i++) {
    // Abort check + progress emit
    if (opts.abortSignal?.aborted) break;
    if (i % progressEvery === 0 && opts.onProgress) {
      opts.onProgress(Math.round(i / totalBars * 100), i, totalBars);
    }
    // BT-FIX: yield the event loop every 2000 bars so concurrent job-status polls
    // get served during heavy compute. Without this, large ranges ("max") block
    // Node's single thread → poll requests hang → FE aborts at 10s → "Request timed out".
    if (i % 2000 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
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
      // Daily reset: consecutive loss counters reset each day (mirrors live bot daily restart).
      // Prevents one bad day from permanently blocking a component across months of backtest.
      componentConsecLoss.clear();
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
      // BT-FIX: spread full strategy config so SAC knobs (sacMinConfidenceA/B/C,
      // sacEnabledComponents, sacSweepVolMult, sacOBDispMult, …) actually reach
      // the detector. Previously only af* keys were forwarded, so detectSignalMulti
      // used its internal `?? 60` defaults and ignored our tuned gates → Scalping 0.
      ...cfg,
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
          ...cfg,
          balance: capital, volatility, trend_strength: trendStrength,
          htfTrend, htfTrendStrength: htfStrengthAt(i),
          maxEntryExtensionATR: cfg.maxEntryExtensionATR,
          afEnabledComponents: cfg.afEnabledComponents,
          // gates OFF for diagnosis:
          sacMinConfidenceA: 0, sacMinConfidenceB: 0, sacMinConfidenceC: 0,
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

    // Check each trade type for independent entry (type names + legacy letters deduped by position Map).
    // opts.activeComponents restricts which components can open (used by triple-TF backtest so each
    // trade-type run only opens its own component on the correct TF data).
    const tradeTypeKeys = opts.activeComponents ?? ["Scalping", "Intraday", "Swing"];
    for (const componentId of tradeTypeKeys) {
      const signal = multiSignal[componentId];
      if (!signal) continue;

      // Apply daily regime gate — block momentum strategies during chop, reduce size for structure
      const entryDate = new Date(c.timestamp).toISOString().split("T")[0];
      const dailyRegime = dailyTrendCache ? getRegimeForDate(entryDate, dailyTrendCache) : "UNKNOWN";
      const regimeResult = applyRegimeGate({
        signal,
        strategyKey,
        regime: dailyRegime,
        riskPerTrade,
      });
      if (!regimeResult.allow) continue;
      const adjustedRiskPerTrade = regimeResult.riskPerTrade;

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

      // Check ATR gate — relative to the leg's own baseline when enabled
      const atrPct = (atr / price) * 100;
      if (atrBaseline) {
        const base = atrBaseline[i];
        const rel = base > 0 ? atr / base : 1;
        if (rel < atrRelMin || rel > atrRelMax) continue;
      } else if (atrPct < atrMinPct || atrPct > atrMaxPct) continue;

      // Calculate risk config for this component. Pass the REAL regime so
      // strongTrendTPMult (let winners run in STRONG_TREND) can fire — it was
      // hardcoded "NORMAL", so the ×1.8 TP extension never applied and every
      // winner was capped at the base RR.
      const regime = multiSignal.meta?.marketCond || "NORMAL";
      const riskCfg = strategy.calculateRiskConfig(price, atr, signal, componentId, {
        marketCond: regime,
        strongTrendTPMult: cfg.strongTrendTPMult ?? 1,
        // AF-SCALP-06: per-leg SL/TP ATR-multiple overrides (typeOverrides →
        // typeConfig → cfg). Undefined = strategy's SUB_STRATEGIES defaults,
        // so live and non-overridden legs are unchanged.
        slMultiplier: cfg.slAtrMult,
        tpMultiplier: cfg.tpAtrMult,
      });

      // Apply pair-tier SL/TP adjustments for STABLE/VOLATILE classification
      // (live parity: BotEngine.js:2601-2602). cfg.pairSlMultiplier set by
      // PairClassifier.paramOverrides.slMultiplier (e.g. 1.1× STABLE, 1.3× VOLATILE).
      // Backtest must match live so tier backtest results align with live trade behavior.
      const pairSlMult = cfg.pairSlMultiplier || 1;
      const slDist = riskCfg.slDistance * pairSlMult;
      const tpDist = riskCfg.tpDistance * pairSlMult;
      const sl = signal === "LONG" ? price - slDist : price + slDist;
      const tp = signal === "LONG" ? price + tpDist : price - tpDist;

      if (!Number.isFinite(sl) || !Number.isFinite(tp)) continue;

      // Calculate position size — risk-based: the loss when SL is hit must equal
      // riskAmt. size = riskAmt / slDist. Dividing by the FULL SL→TP span (as
      // before) shrank every position ~2.8× → effective risk ~0.18% instead of
      // the configured 0.5%, which is why return + drawdown were both tiny.
      const riskAmt = capital * adjustedRiskPerTrade;
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
        // GROK-FIX: entry-context snapshot so the trade can be Grok-confirmed post-hoc.
        atr,
        entryRsi: indicators.rsi?.[i] ?? null,
        htfTrend,
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
 * Compute equity curve + summary stats purely from a (chronological) trades array.
 * Extracted so the Grok Confirm Gate can filter trades and recompute stats identically.
 */
function _computeTripleStats(trades, startCapital) {
  let capital = startCapital;
  const firstDate = trades[0]?.openTime || trades[0]?.date;
  const equity = [{ date: firstDate, value: startCapital }];
  for (const t of trades) {
    capital += t.pnl;
    equity.push({ date: t.closeTime || t.date, value: round2(capital) });
  }

  const wins   = trades.filter(t => t.result === "win");
  const losses = trades.filter(t => t.result === "loss");
  const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  let peak = startCapital, mdd = 0, bal = startCapital;
  for (const t of trades) {
    bal  += t.pnl;
    peak  = Math.max(peak, bal);
    mdd   = Math.max(mdd, peak > 0 ? (peak - bal) / peak : 0);
  }

  const rets = trades.map(t => t.pnl);
  const avg  = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std  = rets.length > 1
    ? Math.sqrt(rets.reduce((s, r) => s + (r - avg) ** 2, 0) / (rets.length - 1))
    : 0;

  return {
    equity,
    stats: {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : "0.0",
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
      totalFees: trades.reduce((s, t) => s + (t.fee || 0), 0).toFixed(2),
    },
  };
}

// AF_SMC/SMART_MONEY_CONCEPTS are aliases; Grok prompt/validation only knows ADAPTIVE_FUSION.
const GROK_KEY_ALIAS = {
  AF_SMC: "ADAPTIVE_FUSION",
  SMART_MONEY_CONCEPTS: "ADAPTIVE_FUSION",
};

/**
 * Post-hoc Grok Confirm Gate for the real (triple-TF) engine.
 * Each produced trade's ENTRY is sent to Grok; rejected entries are dropped, then
 * stats are recomputed over the survivors. Fail-open: any Grok error keeps the trade
 * (a backtest must never break because the AI is slow/unavailable).
 *
 * @param {Array}  trades          chronological trades from the engine
 * @param {Object} ctx
 * @param {string} ctx.strategyKey
 * @param {string} [ctx.symbol]
 * @param {string} [ctx.userId]
 * @param {Function} [ctx.grokConfirmFn] injectable `(signals) => Promise<{decisions,stats}>` (for tests)
 * @param {Function} [ctx.onGrokProgress]
 * @returns {Promise<{trades:Array, rejected:number, logs:Array, stats:Object}>}
 */
async function _applyGrokGate(trades, ctx = {}) {
  const grokKey = GROK_KEY_ALIAS[ctx.strategyKey] || ctx.strategyKey;

  // Map each trade → the signal shape the Grok batch processor expects.
  const signals = trades.map((t, idx) => ({
    id: idx,
    side: t.side,
    price: t.entry,
    entry: t.entry,
    atr: t.atr,
    sl: t.sl,
    tp: t.tp,
    rsi: t.entryRsi ?? undefined,
    htfTrend: t.htfTrend ?? undefined,
    confidence: t.confidence ?? undefined,
    signalReason: `${t.tradeType || t.component} real-engine entry`,
  }));

  const confirmFn = ctx.grokConfirmFn || (async (sigs) => {
    // Lazy require avoids a load-time cycle (batch → GrokConfirmService → config).
    const GrokConfirmBatchProcessor = require("./GrokConfirmBatchProcessor");
    return GrokConfirmBatchProcessor.processBatch({
      userId: ctx.userId,
      strategyKey: grokKey,
      symbol: ctx.symbol || "BACKTEST",
      signals: sigs,
      onProgress: ctx.onGrokProgress,
    });
  });

  let decisions = {};
  try {
    const res = await confirmFn(signals);
    decisions = res?.decisions || {};
  } catch (err) {
    // Fail-open: keep every trade, surface the reason in a single log entry.
    return {
      trades,
      rejected: 0,
      logs: [{ error: true, message: `Grok gate failed (fail-open): ${err.message}` }],
      stats: { total: trades.length, approved: trades.length, rejected: 0, apiCalls: 0, failOpen: true },
    };
  }

  const kept = [];
  const logs = [];
  let approved = 0, rejected = 0;
  trades.forEach((t, idx) => {
    const d = decisions[String(idx)];
    // No decision (e.g. seeded/skipped) → fail-open keep.
    const isApproved = d ? Boolean(d.approved) : true;
    logs.push({
      time: new Date(t.openTime || t.date).getTime() || idx,
      symbol: ctx.symbol || "BACKTEST",
      side: t.side,
      tradeType: t.tradeType || t.component,
      approved: isApproved,
      confidence: d?.confidence ?? t.confidence ?? null,
      reason: d?.reason ?? (d ? null : "no-decision (kept)"),
    });
    if (isApproved) { kept.push(t); approved += 1; }
    else rejected += 1;
  });

  return {
    trades: kept,
    rejected,
    logs,
    stats: { total: trades.length, approved, rejected, apiCalls: approved + rejected },
  };
}

/**
 * Run AF_SMC triple-timeframe backtest:
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
 * @param {boolean} [opts.grokGate]     - post-hoc Grok Confirm Gate over produced trades
 * @param {string}  [opts.userId]
 * @param {string}  [opts.symbol]
 * @param {Function}[opts.grokConfirmFn]- injectable confirm fn (tests)
 * @param {Function}[opts.onGrokProgress]
 */
async function runTripleTypeBacktest(opts = {}) {
  const { strategyKey = "AF_SMC", capital: startCapital = 1000, enableFees = true, enableSlippage = false } = opts;

  const validation = strategyRegistry.validate(strategyKey);
  if (!validation.valid) throw new Error(`Invalid strategy "${strategyKey}": ${validation.error}`);
  const strategy = validation.strategy;

  const base = STRATEGIES[strategyKey] || {};
  const cfg = { ...base, ...(opts.config || {}) };
  const feeRate = enableFees ? FEE_RATE_PER_SIDE : 0;
  const slip    = enableSlippage ? (cfg.slippagePct ?? DEFAULT_SLIPPAGE) : 0;

  // opts.typeOrder: Advance-config subset (e.g. ["Swing"]); risk weights normalize
  // over the ACTIVE types only, so a single active type gets the full combined cap.
  const typeOrder = Array.isArray(opts.typeOrder) && opts.typeOrder.length
    ? opts.typeOrder
    : ["Scalping", "Intraday", "Swing"];
  const allTrades = [];
  const perTypeStats = {};

  // Capital is shared across types (concurrent risk).
  // riskPerTrade = COMBINED cap across all concurrent components; v2.8 splits it
  // by TYPE_RISK_WEIGHTS (Scalping 0.5 : Intraday 1 : Swing 2) instead of equally,
  // so Swing runners get full size and Scalping chop gets the least. Live parity:
  // BotEngine._handleMultiPositionSignal uses the SAME riskShareForType helper.
  // cooldownAfterLoss=0: in backtest candle time, cooldown in real minutes is meaningless.
  // maxConsecLoss raised: daily reset already handles this in _runMultiPositionBacktest;
  // the higher cap prevents intra-day blocking during heavy drawdown periods.
  const baseTypeConfig = {
    ...cfg,
    cooldownAfterLoss: 0,
    maxConsecLoss:    Math.max(cfg.maxConsecLoss ?? 2, 5),
  };

  // AF-SCALP-03: ladder shares are ABSOLUTE caps per type (0.5%/1%/2% of the
  // combined cap), normalized over the strategy's natural type set — running a
  // SUBSET (Advance type filter) must not inflate the remaining legs' risk.
  const riskTypeOrder = Array.isArray(opts.naturalTypeOrder) && opts.naturalTypeOrder.length
    ? opts.naturalTypeOrder
    : ["Scalping", "Intraday", "Swing"];
  for (const tradeType of typeOrder) {
    const typeConfig = {
      ...baseTypeConfig,
      // AF-SCALP-05: per-leg config overrides (cfg.typeOverrides.Swing = {...}).
      // Lets the FE A/B new entry-engine flags on Scalping/Intraday while the
      // proven Swing leg keeps EXACT baseline behaviour. Ladder risk stays
      // authoritative (applied after the spread).
      ...(cfg.typeOverrides?.[tradeType] ?? {}),
      riskPerTrade: riskShareForType(tradeType, riskTypeOrder, cfg.riskPerTrade ?? 0.01),
    };
    const entryCandles = opts.entryCandles?.[tradeType];
    const htfCandles   = opts.htfCandles?.[tradeType];

    if (!entryCandles?.length || entryCandles.length < 60) {
      perTypeStats[tradeType] = { skipped: true, reason: "Insufficient candles" };
      continue;
    }

    const typeResult = await _runMultiPositionBacktest(
      {
        ...opts,
        strategyKey,
        config: typeConfig,
        debug: false,
        activeComponents: [tradeType],
        abortSignal: opts.abortSignal,
        onProgress: opts.onProgress
          ? (pct, bar, total) => opts.onProgress(pct, bar, total, tradeType)
          : undefined,
      },
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

  // ── GROK CONFIRM GATE (post-hoc, AF real engine) ──────────────────────────
  // Send each produced entry to Grok; drop rejected trades, then recompute stats
  // over the survivors. This is what makes the "Grok Confirm Gate (AI)" toggle
  // actually affect Adaptive Fusion (previously bypassed).
  let grokResult = null;
  if (opts.grokGate) {
    grokResult = await _applyGrokGate(allTrades, {
      strategyKey,
      symbol: opts.symbol,
      userId: opts.userId,
      grokConfirmFn: opts.grokConfirmFn,
      onGrokProgress: opts.onGrokProgress,
    });
  }
  const finalTrades = grokResult ? grokResult.trades : allTrades;

  const { equity, stats } = _computeTripleStats(finalTrades, startCapital);

  return {
    ok: true,
    trades: finalTrades,
    equity,
    perTypeStats,
    stats,
    grokGate: !!opts.grokGate,
    grokStats: grokResult?.stats ?? null,
    grokLogs: grokResult?.logs ?? null,
    meta: { strategyKey, mode: "triple-timeframe", perTypeStats, grokGate: !!opts.grokGate },
  };
}

async function runRealBacktest(opts = {}) {
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
    return await _runMultiPositionBacktest(opts, strategy, cfg, feeRate, slip, entryCandles, htfCandles);
  }

  return await _runSinglePositionBacktest(opts, strategy, cfg, feeRate, slip, entryCandles, htfCandles);
}

/**
 * Single-position engine (strategy.detectSignal contract — SL/TP only, no fusion
 * voting). Used by runRealBacktest's non-AF single-TF path, and by
 * runMultiTypeBacktest below (TS_TF/MD_MR running as a subset of AF's own
 * Scalping/Intraday/Swing "types" — one call per type — so a failing type
 * degrades to 0 trades instead of killing the whole backtest, mirroring AF's
 * triple-TF resilience without AF's detectSignalMulti fusion logic).
 */
async function _runSinglePositionBacktest(opts, strategy, cfg, feeRate, slip, entryCandles, htfCandles) {
  const strategyKey = opts.strategyKey || "ADAPTIVE_FUSION";
  const startCapital = opts.capital || 1000;

  const indicators = calcIndicators(entryCandles, {
    emaFast: cfg.emaFast ?? 9,
    emaSlow: cfg.emaSlow ?? 21,
    emaTrend: cfg.emaTrend ?? 50,
    rsiPeriod: cfg.rsiPeriod ?? 14,
    atrPeriod: cfg.atrPeriod ?? 14,
  });

  // MR regime filter (FIX-MR-01): precompute HTF indicators once for regime checks
  // per-bar (O(1) lookup). Live BotEngine computes these fresh per tick, but
  // backtest can cache since HTF data is static.
  const isMeanReversion = isMRKey(strategyKey);
  let htfIndicators = null;
  if (isMeanReversion && htfCandles?.length >= 30) {
    const htfCloses = htfCandles.map(c => c.close);
    const htfHighs  = htfCandles.map(c => c.high);
    const htfLows   = htfCandles.map(c => c.low);
    const htfAtrArr = calcATR(htfHighs, htfLows, htfCloses, 14);
    const htfAtrSma = calcSMA(htfAtrArr.filter(v => v != null), 20);
    htfIndicators = {
      emaFast: calcEMA(htfCloses, 9),
      emaSlow: calcEMA(htfCloses, 21),
      rsi: calcRSI(htfCloses, 14),
      atr: htfAtrArr,
      atrSma: htfAtrSma, // rolling SMA of ATR for ratio check
      close: htfCloses,
    };
  }

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

  // Pre-compute daily trend strength for regime gate (single-position engine)
  let dailyTrendCache = null;
  if (opts.dailyCandles?.length) {
    const dTrend = computeDailyTrendStrength({
      close: opts.dailyCandles.map(c => c.close),
      high: opts.dailyCandles.map(c => c.high),
      low: opts.dailyCandles.map(c => c.low),
    });
    const dMap = new Map();
    for (let di = 0; di < opts.dailyCandles.length; di++) {
      dMap.set(new Date(opts.dailyCandles[di].timestamp).toISOString().split("T")[0], di);
    }
    dailyTrendCache = { dailyTrend: dTrend, dateMap: dMap };
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
  // AF-SCALP-02: relative ATR gate (see buildAtrBaseline). Flag-gated for A/B —
  // live configs don't set atrGateRelative, so live gating is unchanged.
  const atrBaseline = cfg.atrGateRelative === true ? buildAtrBaseline(indicators.atr) : null;
  const atrRelMin = cfg.atrRelMin ?? 0.6;
  const atrRelMax = cfg.atrRelMax ?? 3.0;
  const cooldownMs = (cfg.cooldownAfterLoss ?? 0) * 60000;
  const riskPerTrade = cfg.riskPerTrade ?? 0.01;
  const higherTf = cfg.higherTf ?? null;

  const warmup = Math.max(cfg.emaSlow ?? 21, cfg.atrPeriod ?? 14, 30) + 2;
  const totalBars = entryCandles.length;
  const progressEvery = Math.max(500, Math.floor(totalBars / 100));

  // Gate funnel — counts WHY candles don't become trades (diagnose 0-trade runs).
  const diag = {
    barsEvaluated: 0, htfUnknownSkip: 0, signalNull: 0, htfDirBlock: 0,
    cooldownBlock: 0, consecLossBlock: 0, maxTradesBlock: 0, dailyLossBlock: 0,
    atrGateBlock: 0, validateBlock: 0, opened: 0,
  };

  // ── SL+ Trailing Partial Take Profit (mirrors BotEngine._checkSLPlusMilestones) ──
  // Backtest previously had NO partial-TP implementation at all — every trade closed
  // 100% at SL/TP regardless of tpMode, so "Partial + Trailing" mode was silently a
  // no-op in backtest (not 1:1 with live, where this is the actual live behavior when
  // tpMode="partial"). Uses candle high/low (favorable-side extreme) to detect
  // milestone touches within the bar, same intrabar-check pattern as the SL/TP hit
  // logic below.
  const tpModeCfg = cfg.tpMode ?? "full";
  const slPlusEnabled = tpModeCfg === "partial" && (cfg.slPlusEnabled ?? true);
  const slPlusPartial1Pct = cfg.slPlusPartial1Pct ?? 0.40;
  const slPlusPartial2Pct = cfg.slPlusPartial2Pct ?? 0.275;

  function checkPartialMilestones(c, exitIdx) {
    if (!slPlusEnabled || !position || position.remainingSize <= 0) return;
    const R = position.R;
    if (!Number.isFinite(R) || R <= 0) return;

    const favorableExtreme = position.side === "LONG" ? c.high : c.low;
    const gain = position.side === "LONG" ? favorableExtreme - position.entry : position.entry - favorableExtreme;
    const rMult = gain / R;

    const partialAt = (price, size, reason, newSL) => {
      let px = price;
      if (slip) px = position.side === "LONG" ? px * (1 - slip) : px * (1 + slip);
      const grossPnl = position.side === "LONG" ? (px - position.entry) * size : (position.entry - px) * size;
      const fee = feeRate * (position.entry + px) * size;
      const pnl = grossPnl - fee;
      capital += pnl;
      position.remainingSize -= size;
      position.slCurrent = newSL;
      trades.push({
        date: isoOf(c),
        openTime: isoOf(entryCandles[position.openIdx]),
        closeTime: isoOf(c),
        side: position.side,
        strategy: strategyKey,
        component: position.component,
        marketCond: position.marketCond,
        entry: position.entry,
        exit: px,
        sl: position.sl,
        tp: position.tp,
        size,
        grossPnl,
        fee,
        pnl,
        pnlPct: (pnl / (position.entry * size)) * 100,
        plannedRR: position.plannedRR,
        confidence: position.confidence ?? null,
        reason,
        result: pnl > 0 ? "win" : "loss",
        isPartial: true,
      });
    };

    // Milestone 1: +1R → partial 40%, SL → +0.3R (NOT pure BEP).
    // 4yr VAULT backtest showed runners parked at exact BEP died on the first
    // shallow pullback: TF 4/5 and MR 3/3 partial-triggered trades exited via
    // SL_TRAIL at ~breakeven and never reached +2R/full TP. +0.3R keeps a small
    // locked profit while giving the runner breathing room below +1R.
    if (!position.m1 && rMult >= 1.0) {
      position.m1 = true;
      const partial = position.originalSize * slPlusPartial1Pct;
      const newSL = position.side === "LONG"
        ? position.entry + 0.3 * R
        : position.entry - 0.3 * R; // +0.3R buffer
      if (partial > 0 && partial < position.remainingSize) {
        partialAt(position.entry + (position.side === "LONG" ? R : -R), partial, "Partial_1R", newSL);
      } else {
        position.slCurrent = newSL;
      }
    }

    // Milestone 2: +2R → partial 27.5% of ORIGINAL (capped to 90% of remaining), SL → +1R
    if (position.m1 && !position.m2 && rMult >= 2.0) {
      position.m2 = true;
      const fromOriginal = position.originalSize * slPlusPartial2Pct;
      const partial = Math.min(fromOriginal, position.remainingSize * 0.90);
      const newSL = position.side === "LONG" ? position.entry + R : position.entry - R; // +1R
      if (partial > 0 && partial < position.remainingSize) {
        partialAt(position.entry + (position.side === "LONG" ? 2 * R : -2 * R), partial, "Partial_2R", newSL);
      } else {
        position.slCurrent = newSL;
      }
    }

    // Milestone 3: +3R → log-only marker, no partial (mirrors live)
    if (position.m1 && position.m2 && !position.m3 && rMult >= 3.0) {
      position.m3 = true;
    }
  }

  function closePosition(exitPrice, reason, exitIdx) {
    let px = exitPrice;
    if (slip) px = position.side === "LONG" ? px * (1 - slip) : px * (1 + slip);
    const closeSize = position.remainingSize;
    const grossPnl = position.side === "LONG"
      ? (px - position.entry) * closeSize
      : (position.entry - px) * closeSize;
    const fee = feeRate * (position.entry + px) * closeSize;
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
      size: closeSize,
      grossPnl,
      fee,
      pnl,
      pnlPct: closeSize > 0 ? (pnl / (position.entry * closeSize)) * 100 : 0,
      plannedRR: position.plannedRR,
      confidence: position.confidence ?? null, // AF-FIX-01: entry conviction (0–100)
      reason,
      result: pnl > 0 ? "win" : "loss",
      isPartial: false,
    });
    position = null;
  }

  for (let i = warmup; i < entryCandles.length; i++) {
    // Abort + progress + event-loop yield (BT-FIX parity with the multi-position
    // path). Without these, a large 5m/15m dataset (TF/MR) runs the whole loop
    // SYNCHRONOUSLY → blocks Node's single thread → job-status polls hang → the
    // FE aborts at ~10s → "Request timed out".
    if (opts.abortSignal?.aborted) break;
    if (i % progressEvery === 0 && opts.onProgress) {
      opts.onProgress(Math.round(i / totalBars * 100), i, totalBars);
    }
    if (i % 2000 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

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
      // Daily reset: live BotEngine's maxConsecLoss means "stop trading HARI INI"
      // (state resets each day). Without this reset the single-position engine
      // blocked a strategy FOREVER after one bad streak — e.g. BS_BR stopped
      // trading after 3 straight SLs in week 1 of a 12-month run.
      consecLoss = 0;
    }

    // ── 1. Manage open position FIRST (intrabar SL/TP, SL checked first) ─────
    if (position) {
      checkPartialMilestones(c, i);
    }
    if (position) {
      const stopLevel = position.slCurrent;
      const hitSL = position.side === "LONG" ? c.low <= stopLevel : c.high >= stopLevel;
      const hitTP = position.side === "LONG" ? c.high >= position.tp : c.low <= position.tp;
      if (hitSL) closePosition(stopLevel, position.m1 ? "SL_TRAIL" : "SL", i);
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

    // Apply daily regime gate — block momentum strategies during chop, reduce size for structure
    const entryDate = new Date(c.timestamp).toISOString().split("T")[0];
    const dailyRegime = dailyTrendCache ? getRegimeForDate(entryDate, dailyTrendCache) : "UNKNOWN";
    const regimeResult = applyRegimeGate({
      signal,
      strategyKey,
      regime: dailyRegime,
      riskPerTrade: cfg.riskPerTrade ?? 0.01,
    });
    if (!regimeResult.allow) { equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    const adjustedRiskPerTrade = regimeResult.riskPerTrade;

    // ── 5. HTF directional block (mirror step 7a) ───────────────────────────
    // MEAN_REVERSION (counter-trend) is exempt from directional block — has its own
    // regime filter (step 2c in live BotEngine). BREAKOUT_RETEST exempt (consolidation
    // reversal valid). Other trend-following strategies require HTF alignment.
    const isMR = isMRKey(strategyKey);
    const isBR = isBRKey(strategyKey);
    if (!isMR && !isBR) {
      if (signal === "LONG" && htfTrend === "BEARISH") { diag.htfDirBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
      if (signal === "SHORT" && htfTrend === "BULLISH") { diag.htfDirBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    }

    // ── 5b. MEAN_REVERSION regime gate (mirror step 2c in live BotEngine) ──
    // MR counter-trend entries need regime check: block SHORT in strong bull,
    // LONG in strong bear, and all entries during ATR spike (wide spreads).
    if (isMR && htfIndicators && htfPtr) {
      const j = htfPtr[i];
      if (j >= 0 && j < htfIndicators.emaFast.length) {
        // Assemble HTF data at bar j (aligned to entry bar i via htfPtr)
        const lastNonNull = (arr) => { for (let k = arr.length - 1; k >= 0; k--) if (arr[k] != null) return arr[k]; return null; };
        const htfDataAtJ = {
          emaFast: htfIndicators.emaFast[j],
          emaSlow: htfIndicators.emaSlow[j],
          rsi: htfIndicators.rsi[j],
          close: htfIndicators.close[j],
          atr: htfIndicators.atr[j],
          atrBaseline: htfIndicators.atrSma ?? lastNonNull(htfIndicators.atr.slice(0, j)),
        };
        const mrCheck = meanReversionRegimeFilter({ direction: signal, htfData: htfDataAtJ });
        if (!mrCheck.allowed) {
          diag.htfDirBlock += 1;
          equity.push({ date: isoOf(c), value: round2(capital) });
          continue;
        }
      }
    }

    // ── 6. Risk gates (mirror BotEngine._checkRiskGates) ────────────────────
    const nowMs = c.timestamp ?? 0;
    if (cooldownUntil && nowMs < cooldownUntil) { diag.cooldownBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    if (consecLoss >= maxConsecLoss) { diag.consecLossBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    if (dailyTradeCount >= maxTradesPerDay) { diag.maxTradesBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    const dailyBase = dailyStartCapital || capital;
    if (dailyBase > 0 && dailyLoss / dailyBase >= maxDailyLossPct) { diag.dailyLossBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    const atrPct = (atr / price) * 100;
    if (atrBaseline) {
      const base = atrBaseline[i];
      const rel = base > 0 ? atr / base : 1;
      if (rel < atrRelMin || rel > atrRelMax) { diag.atrGateBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }
    } else if (atrPct < atrMinPct || atrPct > atrMaxPct) { diag.atrGateBlock += 1; equity.push({ date: isoOf(c), value: round2(capital) }); continue; }

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
    const pairSlMult = cfg.pairSlMultiplier || 1; // STABLE/VOLATILE tier adjustment
    if (meta && typeof strategy.calculateRiskConfig === "function") {
      const rc = strategy.calculateRiskConfig(price, atr, signal, meta.component, {
        marketCond: meta.marketCond,
        strongTrendTPMult: cfg.strongTrendTPMult ?? 1,
      });
      slDist = rc.slDistance * pairSlMult;
      tpDist = rc.tpDistance * pairSlMult;
      component = meta.component;
      marketCond = meta.marketCond;
      plannedRR = rc.riskReward;
      // AF-FIX-01/03: conviction behind this entry (component or aggregate score).
      confidence = meta.componentConfidence ?? meta.aggregateConfidence ?? null;
    } else {
      slDist = atr * (cfg.atrMultiplier ?? 1.4) * pairSlMult;
      tpDist = slDist * (cfg.riskReward ?? 2);
      plannedRR = (cfg.riskReward ?? 2);
    }
    if (!(slDist > 0)) { equity.push({ date: isoOf(c), value: round2(capital) }); continue; }

    // ── 9. Open position (risk-based sizing; leverage irrelevant to PnL) ─────
    const entry = price;
    const size = (capital * adjustedRiskPerTrade) / slDist;
    const openSl = signal === "LONG" ? entry - slDist : entry + slDist;
    position = {
      side: signal,
      entry,
      sl: openSl,
      tp: signal === "LONG" ? entry + tpDist : entry - tpDist,
      slDist,
      size,
      openIdx: i,
      component,
      marketCond,
      plannedRR,
      confidence,
      // SL+ partial-TP state (see checkPartialMilestones) — R is the risk distance,
      // slCurrent is the live stop (moves to BEP/+1R after milestones fire),
      // remainingSize shrinks as partials execute; originalSize stays fixed for
      // milestone % calc (mirrors BotEngine pos.size vs pos.remainingSize).
      R: slDist,
      slCurrent: openSl,
      remainingSize: size,
      originalSize: size,
      m1: false,
      m2: false,
      m3: false,
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

/**
 * Run a single-signal strategy (TS_TF, MD_MR) across a SUBSET of AF_SMC's own
 * Scalping/Intraday/Swing timeframe definitions — same TF pairs (5m/1h, 15m/4h,
 * 4h/1w), same candle-fetch resilience, but using the single-position engine
 * (strategy.detectSignal contract) instead of AF's detectSignalMulti fusion.
 *
 * WHY: TS_TF's canonical single-TF entry is 5m, and on exchanges with shallow
 * 5m history (e.g. Bitget) that ONE fetch failing killed the whole backtest —
 * unlike AF, whose triple-TF split lets a failing Scalping(5m) leg degrade to
 * 0 trades while Intraday/Swing still run. Routing TS_TF through Intraday(15m)+
 * Swing(4h) — never touching 5m — and MD_MR through Scalping(5m)+Intraday(15m)
 * gives them the same per-type resilience, and TS_TF sidesteps the fragile TF
 * entirely. Each type is independent: a failing/empty fetch for one type just
 * skips it (0 trades), the other type's result still renders.
 *
 * @param {Object}   opts        - same shape as runTripleTypeBacktest
 * @param {string[]} typeOrder   - subset of ["Scalping","Intraday","Swing"]
 */
async function runMultiTypeBacktest(opts = {}, typeOrder) {
  const { strategyKey, capital: startCapital = 1000, enableFees = true, enableSlippage = false } = opts;

  const validation = strategyRegistry.validate(strategyKey);
  if (!validation.valid) throw new Error(`Invalid strategy "${strategyKey}": ${validation.error}`);
  const strategy = validation.strategy;

  const base = STRATEGIES[strategyKey] || {};
  const cfg = { ...base, ...(opts.config || {}) };
  const feeRate = enableFees ? FEE_RATE_PER_SIDE : 0;
  const slip    = enableSlippage ? (cfg.slippagePct ?? DEFAULT_SLIPPAGE) : 0;

  const allTrades = [];
  const perTypeStats = {};

  // Capital is shared across types (concurrent risk), mirroring runTripleTypeBacktest's
  // documented model: riskPerTrade is the COMBINED cap across all concurrent types.
  // v2.8: split by TYPE_RISK_WEIGHTS (Scalping 0.5 : Intraday 1 : Swing 2) instead of
  // equally — TS_TF combined 0.03 → 1%/2%, MD_MR combined 0.015 → 0.5%/1%.
  // AF-SCALP-03: normalize ladder over the natural type set (see runTripleTypeBacktest).
  const riskTypeOrder = Array.isArray(opts.naturalTypeOrder) && opts.naturalTypeOrder.length
    ? opts.naturalTypeOrder
    : typeOrder;
  for (const tradeType of typeOrder) {
    const typeConfig = {
      ...cfg,
      // AF-SCALP-05: per-leg overrides — see runTripleTypeBacktest.
      ...(cfg.typeOverrides?.[tradeType] ?? {}),
      riskPerTrade: riskShareForType(tradeType, riskTypeOrder, cfg.riskPerTrade ?? 0.01),
    };
    const entryCandles = opts.entryCandles?.[tradeType];
    const htfCandles   = opts.htfCandles?.[tradeType];

    if (!entryCandles?.length || entryCandles.length < 60) {
      perTypeStats[tradeType] = { skipped: true, reason: "Insufficient candles" };
      continue;
    }

    const typeResult = await _runSinglePositionBacktest(
      {
        ...opts,
        strategyKey,
        capital: startCapital,
        config: typeConfig,
        abortSignal: opts.abortSignal,
        onProgress: opts.onProgress
          ? (pct, bar, total) => opts.onProgress(pct, bar, total, tradeType)
          : undefined,
      },
      strategy,
      typeConfig,
      feeRate,
      slip,
      entryCandles,
      htfCandles || null,
    );

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

  allTrades.sort((a, b) => new Date(a.openTime || a.date) - new Date(b.openTime || b.date));

  let grokResult = null;
  if (opts.grokGate) {
    grokResult = await _applyGrokGate(allTrades, {
      strategyKey,
      symbol: opts.symbol,
      userId: opts.userId,
      grokConfirmFn: opts.grokConfirmFn,
      onGrokProgress: opts.onGrokProgress,
    });
  }
  const finalTrades = grokResult ? grokResult.trades : allTrades;

  const { equity, stats } = _computeTripleStats(finalTrades, startCapital);

  return {
    ok: true,
    trades: finalTrades,
    equity,
    perTypeStats,
    stats,
    grokGate: !!opts.grokGate,
    grokStats: grokResult?.stats ?? null,
    grokLogs: grokResult?.logs ?? null,
    meta: { strategyKey, mode: `multi-tf (${typeOrder.join("+")})`, perTypeStats, grokGate: !!opts.grokGate },
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

module.exports = { runRealBacktest, runTripleTypeBacktest, runMultiTypeBacktest, _computeTripleStats, _applyGrokGate };
