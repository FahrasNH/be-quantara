/**
 * Shared real-engine backtest job body (fetch + compute).
 * Used by the API process (in-process fallback) and by backtestJobWorker (child).
 *
 * Hard caps here are the primary OOM guard for >12m multi-type runs; process
 * isolation (child_process) is the secondary guard so a runaway job cannot
 * take down live bots on the main API.
 */

"use strict";

const HistoricalKlinesService = require("./HistoricalKlinesService");
const { runRealBacktest, runTripleTypeBacktest, runMultiTypeBacktest } = require("./RealStrategyBacktestService");
const { STRATEGY_SUPPORTED_TYPES, validateTypeOrderForStrategy, expandAllTypes } = require("../../constants/strategySupportedTypes");
const { applyDedicatedBsBrBacktestConfig } = require("../../config/strategies");
const {
  normalizeExchangeType,
  resolveFeeSchedule,
} = require("../../constants/exchangeFeeSchedules");

const AF_SMC_KEYS = new Set([
  "AF_SMC", "ADAPTIVE_FUSION", "SMART_MONEY_CONCEPTS",
  "AF_WYCKOFF", "AF_VSA",
]);

const TYPE_TF = {
  Scalping: { entry: "15m", trend: "4h" },
  Intraday: { entry: "15m", trend: "4h" },
  Swing:    { entry: "4h",  trend: "1w" },
};

const MULTI_TYPE_STRATEGY_MAP = {
  TS_TF: ["Intraday", "Swing"],
  TREND_FOLLOWING: ["Intraday", "Swing"],
  TS_MS: ["Intraday", "Swing"],
  TS_VP: ["Intraday", "Swing"],
  MD_MR: ["Scalping", "Intraday"],
  MEAN_REVERSION: ["Scalping", "Intraday"],
  MD_SD: ["Scalping", "Intraday"],
  MD_SA: ["Scalping", "Intraday"],
};

const TYPE_MAX_PERIOD = {
  "1m":  "30d",
  "5m": "180d",
  "15m": "365d",
  "1h":  "730d",
  "4h": "1460d",
  "1w": "3650d",
};

const TYPE_MAX_BARS = {
  "1m":  90_000,
  "5m": 120_000,
  "15m": 60_000,
};

/** Sum of entry bars across all trade types — primary memory guard for multi-TF. */
const MAX_TOTAL_ENTRY_BARS = Number(process.env.BACKTEST_MAX_TOTAL_ENTRY_BARS) || 90_000;
/** Reject starting a job if the process heap is already this high (MB). */
const MAX_HEAP_USED_MB = Number(process.env.BACKTEST_MAX_HEAP_USED_MB) || 1024;

function getEffectivePeriod(userPeriodId, timeframe) {
  const maxPeriod = TYPE_MAX_PERIOD[timeframe];
  if (!maxPeriod) return userPeriodId;

  const userDays = {
    "3m": 90,
    "6m": 180,
    "12m": 365,
    "max": 3650,
  }[userPeriodId] || null;

  if (!userDays) return userPeriodId;

  const maxDays = parseInt(maxPeriod, 10);
  if (userDays > maxDays) {
    return `${maxDays}d`;
  }
  return userPeriodId;
}

function heapUsedMb() {
  return Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
}

function assertHeapHeadroom(job) {
  const used = heapUsedMb();
  if (used >= MAX_HEAP_USED_MB) {
    const err = new Error(
      `Server memory too high (${used}MB used) to start a heavy backtest. ` +
      `Wait for other jobs to finish, or retry with a shorter period (3–6 months).`
    );
    err.code = "BACKTEST_HEAP_GUARD";
    throw err;
  }
  job.progress?.({
    phase: "info",
    message: `Memory guard OK (${used}MB heap used, cap ${MAX_HEAP_USED_MB}MB)`,
  });
}

/**
 * Clamp total entry bars across types so multi-TF 12m+ AF cannot balloon RAM.
 * Keeps the most recent bars per type; stamps dataInfo.clamped.
 */
function enforceTotalEntryBarCap(entryCandles, dataInfo, job) {
  const types = Object.keys(entryCandles);
  let total = 0;
  for (const t of types) total += (entryCandles[t] || []).length;
  if (total <= MAX_TOTAL_ENTRY_BARS) return total;

  const ratio = MAX_TOTAL_ENTRY_BARS / total;
  for (const t of types) {
    const arr = entryCandles[t] || [];
    if (!arr.length) continue;
    const keep = Math.max(60, Math.floor(arr.length * ratio));
    if (keep < arr.length) {
      entryCandles[t] = arr.slice(arr.length - keep);
      if (dataInfo[t] && !dataInfo[t].error) {
        dataInfo[t].entryBars = entryCandles[t].length;
        dataInfo[t].clamped = true;
        dataInfo[t].startDate = entryCandles[t][0]?.date || dataInfo[t].startDate;
      }
    }
  }
  const after = types.reduce((s, t) => s + (entryCandles[t] || []).length, 0);
  job.progress?.({
    phase: "warn",
    message:
      `⚠ Memory guard: trimmed entry candles ${total.toLocaleString()} → ${after.toLocaleString()} ` +
      `(cap ${MAX_TOTAL_ENTRY_BARS.toLocaleString()}). Prefer 3–6 months for full resolution.`,
  });
  return after;
}

/**
 * @param {object} job - { progress, done, fail, abortController, status, aborted }
 * @param {string} userId
 * @param {object} opts
 */
/** Normalize FE/BE AF component aliases to canonical racer keys. */
function _normalizeAfRacerKeys(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const out = new Set();
  for (const c of raw) {
    const k = String(c || "").toUpperCase();
    if (k === "AF_SMC" || k === "SMART_MONEY_CONCEPTS" || k === "ADAPTIVE_FUSION" || k === "SMC") {
      out.add("AF_SMC");
    } else if (k === "AF_WYCKOFF" || k === "WYCKOFF") {
      out.add("AF_WYCKOFF");
    } else if (k === "AF_VSA" || k === "VSA") {
      out.add("AF_VSA");
    }
  }
  return [...out];
}

/**
 * True when the job is a Wyckoff-only AF run — either strategyKey is AF_WYCKOFF, or
 * FE collapsed AF_WYCKOFF → AF_SMC engine with only the Wyckoff racer selected.
 */
function _isWyckoffOnlyJob(strategyKey, parameters) {
  if (strategyKey === "AF_WYCKOFF") return true;
  if (!AF_SMC_KEYS.has(strategyKey)) return false;
  const active = _normalizeAfRacerKeys(
    parameters.afActiveRacers || parameters.afActiveVoters || parameters.selectedComponents,
  );
  return active.length === 1 && active[0] === "AF_WYCKOFF";
}

/** Apply per-strategy defaults before a backtest job runs (exported for tests). */
function applyStrategyJobDefaults(strategyKey, parametersIn = {}) {
  const parameters = { ...(parametersIn || {}) };
  if (strategyKey === "AF_WYCKOFF" || strategyKey === "AF_VSA") {
    if (!parameters.afActiveRacers && !parameters.afActiveVoters) {
      parameters.afActiveRacers = [strategyKey];
      if (!Array.isArray(parameters.selectedComponents) || !parameters.selectedComponents.length) {
        parameters.selectedComponents = [strategyKey];
      }
    }
  }
  // Standalone Wyckoff (incl. FE Advanced collapse AF_WYCKOFF → AF_SMC + afActiveVoters)
  // must use aggressive entryModel. Moderate Syarat checklist remains via explicit override.
  if (_isWyckoffOnlyJob(strategyKey, parameters)
      && parameters.entryModel == null
      && !(parameters.wyckoff && "entryModel" in parameters.wyckoff)) {
    parameters.entryModel = "aggressive";
    parameters.wyckoff = { ...(parameters.wyckoff || {}), entryModel: "aggressive" };
  }

  // Standalone Dow / AMT (incl. FE collapse TS_MS/TS_VP → TS_TF) — pin single-racer isolation.
  if (strategyKey === "TS_MS" || strategyKey === "TS_VP") {
    if (!parameters.tsActiveRacers
        && (!Array.isArray(parameters.selectedComponents) || !parameters.selectedComponents.length)) {
      parameters.selectedComponents = [strategyKey];
      parameters.tsActiveRacers = [strategyKey];
    }
  }
  // Standalone MD / BS racers (FE collapse MD_SD/MD_SA → MD_MR, BS_ICT/BS_LS → BS_BR).
  if (strategyKey === "MD_SD" || strategyKey === "MD_SA") {
    if (!parameters.mdActiveRacers
        && (!Array.isArray(parameters.selectedComponents) || !parameters.selectedComponents.length)) {
      parameters.selectedComponents = [strategyKey];
      parameters.mdActiveRacers = [strategyKey];
    }
  }
  if (strategyKey === "BS_ICT" || strategyKey === "BS_LS") {
    if (!parameters.bsActiveRacers
        && (!Array.isArray(parameters.selectedComponents) || !parameters.selectedComponents.length)) {
      parameters.selectedComponents = [strategyKey];
      parameters.bsActiveRacers = [strategyKey];
    }
  }
  return applyDedicatedBsBrBacktestConfig(parameters);
}

async function runBacktestJob(job, userId, opts) {
  const {
    sym, strategyKey, strategyCfg,
    periodId, customStart, customEnd,
    capital, enableFees, enableSlippage,
    parameters: parametersIn = {},
    entryTfOverride, htfTfOverride, debugMode, grokGate, ragGate,
    exchangeType: exchangeTypeIn,
  } = opts;

  const parameters = applyStrategyJobDefaults(strategyKey, parametersIn);

  // Advance: public OHLCV from chosen venue + that venue's fee schedule.
  // Basic: omit override → HistoricalKlinesService uses connected exchange; fees follow fetched venue.
  const exchangeTypeOverride = normalizeExchangeType(exchangeTypeIn);
  const klinesExchangeOpts = exchangeTypeOverride ? { exchangeType: exchangeTypeOverride } : {};

  job.status = "running";
  assertHeapHeadroom(job);

  const startMs = Date.now();
  const fetchOpts = { periodId, customStart, customEnd, ...klinesExchangeOpts };
  const abortSignal = job.abortController.signal;

  /** Resolve fee model once we know which venue supplied OHLCV. */
  function feeOptsFor(exchangeUsed) {
    const ex = normalizeExchangeType(exchangeUsed) || exchangeTypeOverride || "bitget";
    const schedule = resolveFeeSchedule(ex);
    return {
      exchangeType: schedule.exchange,
      feeSchedule: schedule,
    };
  }

  const isAF = AF_SMC_KEYS.has(strategyKey);
  const multiTypeOrder = MULTI_TYPE_STRATEGY_MAP[strategyKey] || null;

  const VALID_TYPES = new Set(["Scalping", "Intraday", "Swing"]);
  const activeTypes = Array.isArray(parameters?.activeTypes)
    ? parameters.activeTypes.filter((t) => VALID_TYPES.has(t))
    : null;
  if (parameters && "activeTypes" in parameters) delete parameters.activeTypes;
  const applyTypeFilter = (order) => {
    if (!activeTypes?.length) return order;
    const filtered = order.filter((t) => activeTypes.includes(t));
    return filtered.length ? filtered : order;
  };

  if ((isAF || multiTypeOrder) && !entryTfOverride) {
    const entryCandles = {};
    const htfCandles = {};
    const dataInfo = {};
    let candleExchange = null;

    let typeOrder = isAF ? Object.keys(TYPE_TF) : multiTypeOrder;
    const supportedForStrategy = STRATEGY_SUPPORTED_TYPES[strategyKey] || [];
    typeOrder = typeOrder.filter((t) => supportedForStrategy.includes(t));
    typeOrder = expandAllTypes(strategyKey, typeOrder);
    typeOrder = applyTypeFilter(typeOrder);

    const validation = validateTypeOrderForStrategy(strategyKey, typeOrder);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    for (const type of typeOrder) {
      const tfs = TYPE_TF[type];
      if (abortSignal.aborted) throw new Error("Cancelled");

      job.progress({ phase: "fetch", type, timeframe: tfs.entry, message: `Fetching ${type} candles (${tfs.entry})…`, pct: 0 });

      try {
        const effectivePeriod = getEffectivePeriod(fetchOpts.periodId, tfs.entry);
        const typeMaxBars = TYPE_MAX_BARS[tfs.entry];
        const entryRes = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
          symbol: sym, timeframe: tfs.entry, ...fetchOpts, periodId: effectivePeriod, allowClamp: true, abortSignal,
          ...(typeMaxBars ? { maxBarsOverride: typeMaxBars } : {}),
          onProgress: (loaded, total) => {
            const pct = total > 0 ? Math.min(99, Math.round(loaded / total * 100)) : 0;
            job.progress({ phase: "fetch", type, timeframe: tfs.entry, message: `${type} (${tfs.entry}): ${loaded.toLocaleString()} / ${total.toLocaleString()} bars`, pct });
          },
        });
        entryCandles[type] = entryRes.candles || [];
        dataInfo[type] = {
          entryBars: entryCandles[type].length,
          realBars: entryRes.realBars,
          coverage: entryRes.coverage,
          startDate: entryRes.startDate,
          endDate: entryRes.endDate,
          clamped: entryRes.clamped || false,
          exchange: entryRes.exchange,
          exchangeLabel: entryRes.exchangeLabel,
        };
        if (!candleExchange) candleExchange = entryRes.exchange;
      } catch (e) {
        if (e.code === "CANCELLED") throw e;
        entryCandles[type] = [];
        dataInfo[type] = { error: e.message };
      }

      job.progress({ phase: "fetch", type, timeframe: tfs.trend, message: `Fetching ${type} HTF candles (${tfs.trend})…`, pct: 0 });
      try {
        const effectiveHtfPeriod = getEffectivePeriod(fetchOpts.periodId, tfs.trend);
        const trendRes = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
          symbol: sym, timeframe: tfs.trend, ...fetchOpts, periodId: effectiveHtfPeriod, allowClamp: true, abortSignal,
          warmupBars: 60,
        });
        htfCandles[type] = trendRes.candles || [];
      } catch (e) {
        if (e.code === "CANCELLED") throw e;
        htfCandles[type] = [];
      }
    }

    if (abortSignal.aborted) throw new Error("Cancelled");
    enforceTotalEntryBarCap(entryCandles, dataInfo, job);
    assertHeapHeadroom(job);

    job.progress({ phase: "compute", message: isAF ? "Running triple-TF simulation…" : "Running multi-TF simulation…", pct: 0 });

    const typeTotal = typeOrder.length;
    let typesDone = 0;

    let dailyCandles = [];
    try {
      job.progress({ phase: "fetch", message: "Fetching daily candles for regime gate…", pct: 0 });
      const dailyRes = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
        symbol: sym, timeframe: "1d", ...fetchOpts, allowClamp: true, abortSignal,
      });
      dailyCandles = dailyRes.candles || [];
    } catch (e) {
      if (e.code === "CANCELLED") throw e;
      console.warn("Failed to fetch daily candles for regime gate:", e.message);
      dailyCandles = [];
    }

    const feeModel = feeOptsFor(candleExchange);
    const computeOpts = {
      entryCandles,
      htfCandles,
      dailyCandles,
      naturalTypeOrder: STRATEGY_SUPPORTED_TYPES[strategyKey]
        || (isAF ? ["Scalping", "Swing"] : multiTypeOrder),
      strategyKey,
      capital: Number(capital) || 1000,
      enableFees: enableFees !== false,
      enableSlippage: !!enableSlippage,
      exchangeType: feeModel.exchangeType,
      feeSchedule: feeModel.feeSchedule,
      config: parameters,
      abortSignal,
      grokGate: !!grokGate,
      ragGate: !!ragGate,
      userId,
      symbol: sym,
      onGrokProgress: (done, total) => {
        job.progress({ phase: "grok", done, total, message: `Grok Confirm Gate: ${done}/${total} entri…`, pct: total > 0 ? Math.round(done / total * 100) : 0 });
      },
      onRagProgress: (done, total) => {
        job.progress({ phase: "rag", done, total, message: `RAG Gate (ML): ${done}/${total} entri…`, pct: total > 0 ? Math.round(done / total * 100) : 0 });
      },
      onProgress: (pct, _bar, _total, type) => {
        const basePct = Math.round(typesDone / typeTotal * 100);
        const typePct = Math.round(pct / typeTotal);
        job.progress({ phase: "compute", type, message: `Computing ${type} signals… ${pct}%`, pct: basePct + typePct });
        if (pct >= 100) typesDone++;
      },
    };

    const result = isAF
      ? await runTripleTypeBacktest({ ...computeOpts, typeOrder })
      : await runMultiTypeBacktest(computeOpts, typeOrder);

    const scalping = result.perTypeStats?.Scalping;
    if (scalping?.ablation) {
      const a = scalping.ablation;
      const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) : "0.0");
      job.progress({
        phase: "info",
        type: "AF-SCALP-13-ABLATION",
        message: `[AF-SCALP-13] Scalping filter funnel:\n` +
          `  1. Raw setups (FVG+mitigation) : ${a.seqCandidate}\n` +
          `  2. - Rejection-wick gate       : -${a.rejByRejection} (${pct(a.rejByRejection, a.seqCandidate)}%)\n` +
          `     -> signals after rejection   : ${a.seqSignal}\n` +
          `  3. - Regime hard-block          : -${a.rejByRegime} (${pct(a.rejByRegime, a.seqSignal)}%)\n` +
          `  4. - 5m CHoCH validation        : -${a.rejByChoch}\n` +
          `  5. - Confidence floor           : -${a.rejByConf}\n` +
          `  = PASSED (tradeable signals)    : ${a.passed}`,
        ablation: a,
      });
    }

    const typeWarnings = [];
    for (const t of typeOrder) {
      const di = dataInfo[t] || {};
      if (di.error) {
        typeWarnings.push(`${t}: SKIPPED — data fetch failed (${di.error})`);
      } else if (!di.entryBars || di.entryBars < 60) {
        typeWarnings.push(`${t}: SKIPPED — insufficient candles (${di.entryBars ?? 0} bars)`);
      } else if (di.clamped) {
        typeWarnings.push(`${t}: data clamped to last ${di.entryBars.toLocaleString()} bars (${di.startDate ?? "?"} → ${di.endDate ?? "?"}) — shorter than requested period`);
      }
    }
    if (typeWarnings.length) {
      job.progress({ phase: "warn", message: `⚠ Type coverage:\n  ${typeWarnings.join("\n  ")}` });
    }

    const modeLabel = typeOrder.map((t) => {
      const di = dataInfo[t] || {};
      const skipped = di.error || !di.entryBars || di.entryBars < 60;
      return `${t} (${TYPE_TF[t].entry}/${TYPE_TF[t].trend})${skipped ? " — SKIPPED, no data" : ""}`;
    }).join(" + ");

    job.done({
      ok: true,
      engine: isAF ? "real-1to1-triple-tf" : "real-1to1-multi-tf",
      strategyKey,
      symbol: sym,
      mode: isAF ? `SMC Sequence — ${modeLabel}` : `Multi-TF — ${modeLabel}`,
      dataInfo,
      typeWarnings,
      computeTimeMs: Date.now() - startMs,
      ...result,
      exchange: feeModel.exchangeType,
      exchangeLabel: feeModel.feeSchedule.label,
      feeSchedule: {
        takerFeeRate: feeModel.feeSchedule.takerFeeRate,
        makerFeeRate: feeModel.feeSchedule.makerFeeRate,
        fundingRate8h: feeModel.feeSchedule.fundingRate8h,
      },
    });
    return;
  }

  // Single-TF mode
  const entryTf = entryTfOverride || strategyCfg?.interval || "15m";
  const htfTf = htfTfOverride !== undefined ? htfTfOverride : (strategyCfg?.higherTf || null);
  const entryEffectivePeriod = getEffectivePeriod(fetchOpts.periodId, entryTf);
  const entryMaxBars = TYPE_MAX_BARS[entryTf];

  job.progress({ phase: "fetch", timeframe: entryTf, message: `Fetching ${entryTf} candles…`, pct: 0 });

  const stratLabel = strategyCfg?.label || strategyKey;
  let entryRes;
  try {
    entryRes = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
      symbol: sym, timeframe: entryTf, ...fetchOpts, periodId: entryEffectivePeriod, allowClamp: true, abortSignal,
      ...(entryMaxBars ? { maxBarsOverride: entryMaxBars } : {}),
      onProgress: (loaded, total) => {
        const pct = total > 0 ? Math.min(99, Math.round(loaded / total * 100)) : 0;
        job.progress({ phase: "fetch", timeframe: entryTf, message: `Loading ${entryTf} candles: ${loaded.toLocaleString()} / ${total.toLocaleString()}`, pct });
      },
    });
  } catch (e) {
    if (e.code === "CANCELLED") throw e;
    const err = new Error(
      `${stratLabel}: gagal memuat candle ${entryTf} — ${e.message} ` +
      `Exchange mungkin tak menyediakan data ${entryTf} sejauh periode itu. ` +
      `Coba periode lebih pendek/terbaru, timeframe lebih tinggi, atau exchange lain (mis. Binance).`
    );
    err.code = e.code || "ENTRY_FETCH_FAILED";
    err.strategyKey = strategyKey;
    throw err;
  }
  let entryCandles = entryRes.candles || [];
  if (entryCandles.length < 60) {
    const err = new Error(
      `${stratLabel}: data ${entryTf} tidak cukup (${entryCandles.length} bar) untuk backtest. ` +
      `Coba periode lebih panjang, timeframe lebih tinggi, atau exchange lain.`
    );
    err.code = "INSUFFICIENT_DATA";
    err.strategyKey = strategyKey;
    throw err;
  }

  if (entryCandles.length > MAX_TOTAL_ENTRY_BARS) {
    const keep = MAX_TOTAL_ENTRY_BARS;
    entryCandles = entryCandles.slice(entryCandles.length - keep);
    job.progress({
      phase: "warn",
      message: `⚠ Memory guard: trimmed ${entryTf} to last ${keep.toLocaleString()} bars`,
    });
  }

  let htfCandles = null;
  if (htfTf) {
    job.progress({ phase: "fetch", timeframe: htfTf, message: `Fetching HTF candles (${htfTf})…`, pct: 0 });
    try {
      const htfRes = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
        symbol: sym, timeframe: htfTf, ...fetchOpts, periodId: getEffectivePeriod(fetchOpts.periodId, htfTf), allowClamp: true, abortSignal,
        warmupBars: 60,
      });
      htfCandles = htfRes.candles || null;
    } catch { htfCandles = null; }
  }

  let dailyCandles = [];
  try {
    job.progress({ phase: "fetch", message: "Fetching daily candles for regime gate…", pct: 0 });
    const dailyRes = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
      symbol: sym, timeframe: "1d", ...fetchOpts, allowClamp: true, abortSignal,
    });
    dailyCandles = dailyRes.candles || [];
  } catch (e) {
    if (e.code === "CANCELLED") throw e;
    console.warn("Failed to fetch daily candles for regime gate:", e.message);
    dailyCandles = [];
  }

  assertHeapHeadroom(job);
  job.progress({ phase: "compute", message: "Running backtest simulation…", pct: 0 });

  const feeModel = feeOptsFor(entryRes.exchange);
  const result = await runRealBacktest({
    entryCandles,
    htfCandles,
    dailyCandles,
    strategyKey,
    capital: Number(capital) || 1000,
    enableFees: enableFees !== false,
    enableSlippage: !!enableSlippage,
    exchangeType: feeModel.exchangeType,
    feeSchedule: feeModel.feeSchedule,
    config: parameters,
    debug: !!debugMode,
    abortSignal,
    onProgress: (pct) => job.progress({ phase: "compute", message: `Simulating… ${pct}%`, pct }),
  });

  job.done({
    ok: true,
    engine: "real-1to1",
    strategyKey,
    symbol: sym,
    entryTimeframe: entryTf,
    htfTimeframe: htfTf,
    entryBars: entryCandles.length,
    htfBars: htfCandles?.length ?? 0,
    dataStart: entryRes.startDate,
    dataEnd: entryRes.endDate,
    source: entryRes.source,
    computeTimeMs: Date.now() - startMs,
    ...result,
    exchange: feeModel.exchangeType,
    exchangeLabel: feeModel.feeSchedule.label,
    feeSchedule: {
      takerFeeRate: feeModel.feeSchedule.takerFeeRate,
      makerFeeRate: feeModel.feeSchedule.makerFeeRate,
      fundingRate8h: feeModel.feeSchedule.fundingRate8h,
    },
  });
}

module.exports = {
  runBacktestJob,
  applyStrategyJobDefaults,
  getEffectivePeriod,
  enforceTotalEntryBarCap,
  assertHeapHeadroom,
  heapUsedMb,
  TYPE_TF,
  TYPE_MAX_PERIOD,
  TYPE_MAX_BARS,
  MULTI_TYPE_STRATEGY_MAP,
  AF_SMC_KEYS,
  MAX_TOTAL_ENTRY_BARS,
  MAX_HEAP_USED_MB,
};
