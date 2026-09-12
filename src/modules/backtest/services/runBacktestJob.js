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
const { runRealBacktest, runTripleTypeBacktest, runMultiTypeBacktest, formatStrategyFunnel, resolveAblationStrategyKey } = require("./RealStrategyBacktestService");
const { STRATEGY_SUPPORTED_TYPES, validateTypeOrderForStrategy, expandAllTypes } = require("../../../shared/constants/strategySupportedTypes");
const { applyDedicatedBsBrBacktestConfig } = require("../../../config/strategies");
const { normalizeStrategyKey } = require("../../../config/strategyKeyNormalizer");
const {
  normalizeExchangeType,
  resolveFeeSchedule,
} = require("../../../shared/constants/exchangeFeeSchedules");
const {
  applyPairTierToBacktestParams,
  hasExplicitPairTier,
} = require("../../../shared/backtest/applyPairTierToBacktestParams");

const AF_SMC_KEYS = new Set([
  "SMART_MONEY_CONCEPTS", "ADAPTIVE_FUSION",
  "WYCKOFF", "VOLUME_SPREAD_ANALYSIS",
]);

// Trade-type → timeframe ladder (Sprint 14 factory reset).
// Scalping is now a GENUINE low-TF leg (5m/1h), distinct from Intraday (15m/1h).
// Previously Scalping and Intraday were both 15m/4h (100% overlap) — the leg
// labelled "Scalping" was really a 15m intraday leg. Now: 5m → 15m → 1h → 1w.
// NOTE: this table is GLOBAL (shared by every umbrella). Moving Scalping to 5m
// moves the Scalping leg for MD_*/BS_* too — intended (uniform 3-type ladder).
const TYPE_TF = {
  Scalping: { entry: "5m",  trend: "1h" },
  Intraday: { entry: "15m", trend: "1h" },
  Swing:    { entry: "4h",  trend: "1w" },
};

// Sprint 14: every umbrella runs all 3 trade types (Scalping/Intraday/Swing).
// AF_* route via Object.keys(TYPE_TF); TS_*/MD_*/BS_* route via this map. All
// intersected with STRATEGY_SUPPORTED_TYPES, so this stays the superset.
const ALL_THREE_TYPES = ["Scalping", "Intraday", "Swing"];
const MULTI_TYPE_STRATEGY_MAP = {
  TREND_FOLLOWING: ALL_THREE_TYPES,
  MARKET_STRUCTURE: ALL_THREE_TYPES,
  AUCTION_MARKET_THEORY: ALL_THREE_TYPES,
  MEAN_REVERSION: ALL_THREE_TYPES,
  SUPPLY_AND_DEMAND: ALL_THREE_TYPES,
  STATISTICAL_ARBITRAGE: ALL_THREE_TYPES,
  BREAKOUT_RETEST: ALL_THREE_TYPES,
  ICT_STYLE_TRADING: ALL_THREE_TYPES,
  LIQUIDATION_SQUEEZE: ALL_THREE_TYPES,
};

/** Per-run fetch window caps per TF — trims long presets/custom ranges so each job stays fast; cache extends backward across runs. Ops may override 5m/15m via BACKTEST_5M_MAX_DAYS / BACKTEST_15M_MAX_DAYS. */
const TYPE_MAX_PERIOD = {
  "1m":  "30d",
  "5m": "180d",
  "15m": "365d",
  "1h":  "365d",
  "4h": "365d",
  "1w": "365d",
};

function envMaxDaysForTf(timeframe) {
  const tf = String(timeframe).toLowerCase();
  if (tf === "5m") {
    const raw = process.env.BACKTEST_5M_MAX_DAYS;
    const n = raw != null && raw !== "" ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (tf === "15m") {
    const raw = process.env.BACKTEST_15M_MAX_DAYS;
    const n = raw != null && raw !== "" ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

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
  const tf = String(timeframe).toLowerCase();
  const userDays = {
    "3m": 90,
    "6m": 180,
    "12m": 365,
    "max": 3650,
  }[userPeriodId] || null;

  const envCap = envMaxDaysForTf(tf);
  if (envCap != null) {
    if (userDays != null && userDays > envCap) return `${envCap}d`;
    return userPeriodId;
  }

  const maxPeriod = TYPE_MAX_PERIOD[tf];
  if (!maxPeriod || userDays == null) return userPeriodId;

  const maxDays = parseInt(maxPeriod, 10);
  if (userDays > maxDays) return `${maxDays}d`;
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

/** Fetch BTC entry-TF candles aligned to alt SA backtest windows (Gelombang 2 #4). */
async function fetchSaBenchmarkEntryCandles(userId, entryTf, fetchOpts, abortSignal, job) {
  try {
    job?.progress?.({ phase: "fetch", message: `Fetching BTCUSDT benchmark (${entryTf})…`, pct: 0 });
    const effectivePeriod = getEffectivePeriod(fetchOpts.periodId, entryTf);
    const maxBars = TYPE_MAX_BARS[entryTf];
    const res = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
      symbol: "BTCUSDT",
      timeframe: entryTf,
      ...fetchOpts,
      periodId: effectivePeriod,
      allowClamp: true,
      abortSignal,
      ...(maxBars ? { maxBarsOverride: maxBars } : {}),
    });
    return res.candles || [];
  } catch (e) {
    if (e.code === "CANCELLED") throw e;
    console.warn(`SA benchmark fetch failed (${entryTf}):`, e.message);
    return [];
  }
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
    const k = normalizeStrategyKey(String(c || "").toUpperCase());
    if (k === "SMART_MONEY_CONCEPTS" || String(c || "").toUpperCase() === "SMC") {
      out.add("SMART_MONEY_CONCEPTS");
    } else if (k === "WYCKOFF" || k === "WYCKOFF") {
      out.add("WYCKOFF");
    } else if (k === "VOLUME_SPREAD_ANALYSIS" || k === "VSA") {
      out.add("VOLUME_SPREAD_ANALYSIS");
    }
  }
  return [...out];
}

/**
 * True when the job is a Wyckoff-only AF run — either strategyKey is WYCKOFF, or
 * FE collapsed WYCKOFF → SMART_MONEY_CONCEPTS engine with only the Wyckoff racer selected.
 */
function _isWyckoffOnlyJob(strategyKey, parameters) {
  if (strategyKey === "WYCKOFF") return true;
  if (!AF_SMC_KEYS.has(strategyKey)) return false;
  const active = _normalizeAfRacerKeys(
    parameters.afActiveRacers || parameters.afActiveVoters || parameters.selectedComponents,
  );
  return active.length === 1 && active[0] === "WYCKOFF";
}

/** True when only the SMC racer is active under an AF/SMC engine key. */
function _isSmcOnlyJob(strategyKey, parameters) {
  if (!AF_SMC_KEYS.has(strategyKey)) return false;
  const active = _normalizeAfRacerKeys(
    parameters.afActiveRacers || parameters.afActiveVoters || parameters.selectedComponents,
  );
  return active.length === 1 && active[0] === "SMART_MONEY_CONCEPTS";
}

/** Apply per-strategy defaults before a backtest job runs (exported for tests). */
function applyStrategyJobDefaults(strategyKey, parametersIn = {}) {
  const parameters = { ...(parametersIn || {}) };
  if (strategyKey === "WYCKOFF" || strategyKey === "VOLUME_SPREAD_ANALYSIS") {
    if (!parameters.afActiveRacers && !parameters.afActiveVoters) {
      parameters.afActiveRacers = [strategyKey];
      if (!Array.isArray(parameters.selectedComponents) || !parameters.selectedComponents.length) {
        parameters.selectedComponents = [strategyKey];
      }
    }
  }
  // Standalone Wyckoff defaults to balanced (frequency ~50–100/yr + HTF align).
  // moderate / aggressive / conservative remain via explicit override.
  if (_isWyckoffOnlyJob(strategyKey, parameters)
      && parameters.entryModel == null
      && !(parameters.wyckoff && "entryModel" in parameters.wyckoff)) {
    parameters.entryModel = "balanced";
    parameters.wyckoff = { ...(parameters.wyckoff || {}), entryModel: "balanced" };
  }
  // SMC-only AF run — skip Wyckoff/VSA race overhead (still 1:1 for SMC signals).
  if (_isSmcOnlyJob(strategyKey, parameters) && parameters.afCombinationMode == null) {
    parameters.afCombinationMode = "smc_only";
  }

  // Standalone Dow / AMT (incl. FE collapse MARKET_STRUCTURE/AUCTION_MARKET_THEORY → TREND_FOLLOWING) — pin single-racer isolation.
  if (strategyKey === "MARKET_STRUCTURE" || strategyKey === "AUCTION_MARKET_THEORY") {
    if (!parameters.tsActiveRacers
        && (!Array.isArray(parameters.selectedComponents) || !parameters.selectedComponents.length)) {
      parameters.selectedComponents = [strategyKey];
      parameters.tsActiveRacers = [strategyKey];
    }
  }
  // Standalone MD / BS racers (FE collapse SUPPLY_AND_DEMAND/STATISTICAL_ARBITRAGE → MEAN_REVERSION, ICT_STYLE_TRADING/LIQUIDATION_SQUEEZE → BREAKOUT_RETEST).
  if (strategyKey === "SUPPLY_AND_DEMAND" || strategyKey === "STATISTICAL_ARBITRAGE") {
    if (!parameters.mdActiveRacers
        && (!Array.isArray(parameters.selectedComponents) || !parameters.selectedComponents.length)) {
      parameters.selectedComponents = [strategyKey];
      parameters.mdActiveRacers = [strategyKey];
    }
  }
  if (strategyKey === "ICT_STYLE_TRADING" || strategyKey === "LIQUIDATION_SQUEEZE") {
    if (!parameters.bsActiveRacers
        && (!Array.isArray(parameters.selectedComponents) || !parameters.selectedComponents.length)) {
      parameters.selectedComponents = [strategyKey];
      parameters.bsActiveRacers = [strategyKey];
    }
  }
  return applyDedicatedBsBrBacktestConfig(parameters);
}

/**
 * Stamp PairClassifier overrides when the client did not (CLI via-api / bare API).
 * FE Advance already sends pairSlMultiplier via applyPairTierOverrides — skip then.
 * Without this, ablation gets SL×1 while UI Advance gets SL×~1.05 on BTCUSDT LIQUID
 * → different exit paths → different cooldown/consec-loss cascades → trade-count drift
 * (MEAN_REVERSION Scalping 180d: CLI 94 vs UI 90).
 */
async function ensurePairTierOnParameters(parametersIn, { symbol, strategyKey, exchangeType, job } = {}) {
  const parameters = { ...(parametersIn || {}) };
  if (hasExplicitPairTier(parameters) || !symbol) return parameters;

  try {
    const { createExchangeClient } = require("../../../infrastructure/exchange");
    const { getPairTierMetrics } = require("../../research/services/MarketSnapshotService");
    const { pairClassifier } = require("../../../infrastructure/classification/PairClassifier");
    const ex = normalizeExchangeType(exchangeType) || "binance";
    const client = createExchangeClient(ex);
    const metrics = await getPairTierMetrics(client, symbol, { exchange: ex }).catch(() => null);
    const classification = pairClassifier.classify(symbol, metrics);
    const { parameters: next, applied } = applyPairTierToBacktestParams(
      parameters,
      classification,
      strategyKey,
    );
    if (applied?.slMultiplier != null) {
      job?.progress?.({
        phase: "info",
        message:
          `Pair tier ${classification.tier || "?"} · SL×${Number(applied.slMultiplier).toFixed(3)} `
          + `(auto — mirrors UI Advance / live BotEngine)`,
      });
    }
    return next;
  } catch (err) {
    job?.progress?.({
      phase: "warn",
      message: `Pair tier auto-apply skipped: ${err.message || err}`,
    });
    return parameters;
  }
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

  // Advance: public OHLCV from chosen venue + that venue's fee schedule.
  // Basic: omit override → HistoricalKlinesService uses connected exchange; fees follow fetched venue.
  const exchangeTypeOverride = normalizeExchangeType(exchangeTypeIn);
  const klinesExchangeOpts = exchangeTypeOverride ? { exchangeType: exchangeTypeOverride } : {};

  let parameters = applyStrategyJobDefaults(strategyKey, parametersIn);
  parameters = await ensurePairTierOnParameters(parameters, {
    symbol: sym,
    strategyKey,
    exchangeType: exchangeTypeOverride,
    job,
  });

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
          entryTf: tfs.entry,
          htfTf: tfs.trend,
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
        dataInfo[type] = { error: e.message, entryTf: tfs.entry, htfTf: tfs.trend };
      }

      job.progress({ phase: "fetch", type, timeframe: tfs.trend, message: `Fetching ${type} HTF candles (${tfs.trend})…`, pct: 0 });
      try {
        const effectiveHtfPeriod = getEffectivePeriod(fetchOpts.periodId, tfs.trend);
        const trendRes = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
          symbol: sym, timeframe: tfs.trend, ...fetchOpts, periodId: effectiveHtfPeriod, allowClamp: true, abortSignal,
          warmupBars: 60,
        });
        htfCandles[type] = trendRes.candles || [];
        if (dataInfo[type]) dataInfo[type].htfBars = htfCandles[type].length;
      } catch (e) {
        if (e.code === "CANCELLED") throw e;
        htfCandles[type] = [];
        if (dataInfo[type]) dataInfo[type].htfBars = 0;
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

    const btcEntryCandles = {};
    if (normalizeStrategyKey(strategyKey) === "STATISTICAL_ARBITRAGE" && sym.toUpperCase() !== "BTCUSDT") {
      for (const type of typeOrder) {
        const tfs = TYPE_TF[type];
        btcEntryCandles[type] = await fetchSaBenchmarkEntryCandles(
          userId, tfs.entry, fetchOpts, abortSignal, job,
        );
      }
    }

    const feeModel = feeOptsFor(candleExchange);
    const computeOpts = {
      entryCandles,
      htfCandles,
      dailyCandles,
      btcEntryCandles,
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

    // Every strategy owns its OWN indicator funnel. Emit the resolved active
    // racer's funnel for EACH trade type that has strategy/execution ablation data.
    for (const tradeType of typeOrder) {
      const typeStats = result.perTypeStats?.[tradeType];
      const ablKey = typeStats?.ablationKey || resolveAblationStrategyKey(strategyKey, parameters);
      if (!ablKey || !(typeStats?.ablation || typeStats?.execAblation)) continue;
      job.progress({
        phase: "info",
        type: `ABLATION-${tradeType.toUpperCase()}`,
        message: formatStrategyFunnel(ablKey, typeStats.ablation, typeStats.execAblation, `${ablKey} filter funnel (${tradeType}):`),
        ablation: typeStats.ablation,
        execAblation: typeStats.execAblation ?? null,
        ablationKey: ablKey,
        tradeType,
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

  let btcEntryCandles = null;
  if (normalizeStrategyKey(strategyKey) === "STATISTICAL_ARBITRAGE" && sym.toUpperCase() !== "BTCUSDT") {
    btcEntryCandles = await fetchSaBenchmarkEntryCandles(
      userId, entryTf, fetchOpts, abortSignal, job,
    );
  }

  const feeModel = feeOptsFor(entryRes.exchange);
  const result = await runRealBacktest({
    entryCandles,
    htfCandles,
    dailyCandles,
    btcEntryCandles,
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
  ensurePairTierOnParameters,
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
