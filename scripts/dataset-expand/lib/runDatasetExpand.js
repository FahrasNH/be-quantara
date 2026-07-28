#!/usr/bin/env node
/**
 * Shared batch dataset-expand runner — 1:1 with production backtest TYPE_TF ladder.
 *
 * Scalping 5m/1h · Intraday 15m/4h · Swing 4h/1w (runBacktestJob.TYPE_TF SSOT).
 * Applies applyStrategyJobDefaults for component isolation (Wyckoff-only, etc.).
 */

"use strict";

// First bytes to stdout — user sees feedback before heavy require() chain finishes.
process.stdout.write("[dataset-expand] loading backtest engine...\n");

const fs = require("fs");
const path = require("path");

/** be-bot-trading/ — stable regardless of shell cwd */
const REPO_ROOT = path.resolve(__dirname, "../../..");
require("dotenv").config({ path: path.join(REPO_ROOT, ".env") });
const { runTripleTypeBacktest, runMultiTypeBacktest, formatStrategyFunnel, resolveAblationStrategyKey } = require("../../../src/server/services/RealStrategyBacktestService");
const { toCsv, TRADE_EXPORT_COLUMNS } = require("#shared/csv/tradeExportCsv.js");
const { SMC_ML_CSV_COLUMNS } = require("../../../src/core/strategy-engine/af/smcEntry");
const {
  applyStrategyJobDefaults,
  TYPE_TF,
  TYPE_MAX_PERIOD,
  TYPE_MAX_BARS,
  AF_SMC_KEYS,
  getEffectivePeriod,
} = require("../../../src/modules/backtest/services/runBacktestJob");
const { resolveFeeSchedule } = require("../../../src/shared/constants/exchangeFeeSchedules");
const { isAfStrategy, naturalTypeOrder, SLUG_BY_KEY } = require("./strategyRegistry");
const { runViaApi, loginForToken } = require("./viaApi");

const CORE_CSV_KEYS = [
  "id", "symbol", "side", "strategy", "component", "entryPrice", "exitPrice",
  "pnl", "fee", "pnlNet", "result", "atr", "entryReasons", "openTime", "closeTime",
];

const TF_MIN = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
  "1w": 10080,
};

function parseArgs(argv = process.argv.slice(2)) {
  const get = (flag, def) => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
  };
  const quick = argv.includes("--quick");
  const sourceArg = String(get("--source", "real")).toLowerCase();
  const mock = argv.includes("--mock") || sourceArg === "mock";
  const cacheOnly = argv.includes("--cache-only");
  // Default ON for real runs — laptop often cannot reach exchange APIs / local DB.
  // Opt out with --local (direct HistoricalKlinesService on this machine).
  const viaApi = !mock
    && (argv.includes("--via-api")
      || (!argv.includes("--local") && !cacheOnly && sourceArg !== "local"));
  return {
    symbols: (quick ? "BTCUSDT" : get("--symbols", "BTCUSDT"))
      .split(",").map((s) => s.trim()).filter(Boolean),
    days: quick ? 30 : parseInt(get("--days", ""), 10),
    source: mock ? "mock" : "real",
    exchange: get("--exchange", "binance").toLowerCase(),
    capital: parseFloat(get("--capital", "1000")),
    out: get("--out", null),
    relax: argv.includes("--relax"),
    quick,
    cacheOnly,
    viaApi,
    api: get("--api", process.env.DATASET_EXPAND_API_URL || process.env.BACKTEST_API_URL || null),
    token: get("--token", process.env.DATASET_EXPAND_TOKEN || process.env.BACKTEST_TOKEN || null),
    email: get("--email", process.env.DATASET_EXPAND_EMAIL || null),
    password: get("--password", process.env.DATASET_EXPAND_PASSWORD || null),
    user: get("--user", process.env.DATASET_EXPAND_USER_ID || null),
    start: get("--start", null),
    end: get("--end", null),
  };
}

function logPhase(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

let lastProgressPct = -1;
function makeProgressLogger(label) {
  return (pct) => {
    const rounded = Math.floor(pct / 10) * 10;
    if (rounded > lastProgressPct && rounded < 100) {
      lastProgressPct = rounded;
      logPhase(`${label} ${rounded}%…`);
    }
    if (pct >= 100) lastProgressPct = -1;
  };
}

function defaultDaysForType(tradeType) {
  const entryTf = TYPE_TF[tradeType]?.entry;
  const cap = TYPE_MAX_PERIOD[entryTf];
  return cap ? parseInt(cap, 10) : 365;
}

function mlDatasetColumns(strategyKey) {
  const core = TRADE_EXPORT_COLUMNS.filter(([k]) => CORE_CSV_KEYS.includes(k));
  if (isAfStrategy(strategyKey)) {
    return [...core, ...SMC_ML_CSV_COLUMNS];
  }
  return core;
}

function genMock(symbol, days, intervalMin, label = "mock") {
  const bars = Math.floor((days * 24 * 60) / intervalMin);
  if (bars > 5000) logPhase(`generating ${label} ${bars.toLocaleString()} bars…`);
  const seed = symbol.startsWith("BTC") ? 65000
    : symbol.startsWith("ETH") ? 3500
      : symbol.startsWith("SOL") ? 140
        : 600;
  let price = seed;
  let time = Date.UTC(2025, 6, 13);
  const candles = [];
  let s = symbol.split("").reduce((a, c) => a + c.charCodeAt(0), 1234567);
  const rnd = () => { s = (1103515245 * s + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const REGIMES = ["STRONG_UP", "NORMAL", "VOLATILE_CHOP", "STRONG_DOWN", "NORMAL"];
  const regimeLen = Math.max(1, Math.floor((24 * 60) / intervalMin));
  const isSwingTf = intervalMin >= 240;
  for (let i = 0; i < bars; i++) {
    const regime = REGIMES[Math.floor(i / regimeLen) % REGIMES.length];
    let drift;
    let noiseAmp;
    switch (regime) {
      case "STRONG_UP":
        drift = price * (isSwingTf ? 0.002 : 0.0012);
        noiseAmp = isSwingTf ? 0.008 : 0.004;
        break;
      case "STRONG_DOWN":
        drift = -price * (isSwingTf ? 0.002 : 0.0012);
        noiseAmp = isSwingTf ? 0.008 : 0.004;
        break;
      case "VOLATILE_CHOP":
        drift = (rnd() - 0.5) * price * (isSwingTf ? 0.006 : 0.003);
        noiseAmp = isSwingTf ? 0.02 : 0.012;
        break;
      default:
        drift = (rnd() - 0.45) * price * (isSwingTf ? 0.0015 : 0.0008);
        noiseAmp = isSwingTf ? 0.01 : 0.005;
    }
    const noise = (rnd() - 0.5) * price * noiseAmp * 2;
    const open = price;
    const close = Math.max(price + drift + noise, 1);
    const high = Math.max(open, close) * (1 + rnd() * noiseAmp);
    const low = Math.min(open, close) * (1 - rnd() * noiseAmp);
    candles.push({
      timestamp: time,
      date: new Date(time).toISOString(),
      open, high, low, close,
      volume: 1000 + rnd() * 2000,
    });
    price = close;
    time += intervalMin * 60 * 1000;
    if (bars > 5000 && i > 0 && i % 10000 === 0) {
      logPhase(`  ${label} ${Math.round((i / bars) * 100)}% (${i.toLocaleString()}/${bars.toLocaleString()} bars)`);
    }
  }
  return candles;
}

function daysToPeriodId(days) {
  if (days === 90) return "3m";
  if (days === 180) return "6m";
  if (days === 365) return "12m";
  return `${days}d`;
}

function validateOpts(opts) {
  if (opts.source === "mock") {
    logPhase(
      "WARN: mock candles — ablation/trades NOT comparable to UI. "
      + "Omit --mock for real Binance OHLCV (default).",
    );
    return;
  }
  if (opts.viaApi) {
    const hasAuth = opts.token || (opts.email && opts.password);
    if (!opts.api || !hasAuth) {
      throw new Error(
        [
          "1:1 UI parity needs the staging/production BE (laptop cannot reach Binance/Bitget).",
          "",
          "Set once in be-bot-trading/.env:",
          "  DATASET_EXPAND_API_URL=https://dev.quantara.software   # same baseURL as FE",
          "  DATASET_EXPAND_EMAIL=you@example.com                  # your dashboard login",
          "  DATASET_EXPAND_PASSWORD=••••••••                      # auto-logs in for a JWT",
          "  # (alternatively paste a token: DATASET_EXPAND_TOKEN=<jwt>)",
          "",
          "Then:",
          "  node smart-money-concepts/scalping.js --symbols BTCUSDT --days 90",
          "",
          "Or one-shot:",
          "  node smart-money-concepts/scalping.js --api https://dev.quantara.software --email you@x.com --password '***' --days 90",
          "",
          "Advanced (this machine has network + DB): add --local",
        ].join("\n"),
      );
    }
    return;
  }
  if (!opts.exchange && !opts.user) {
    throw new Error(
      "Real mode needs --exchange binance (default) or --user <id> with a connected exchange.",
    );
  }
}

function formatFetchError(err, opts) {
  if (err?.code === "NO_EXCHANGE_CONNECTED") {
    return [
      "No exchange connected for --user.",
      "Public OHLCV does NOT need Settings exchange — use: --exchange binance",
      "(or --exchange bitget / okx). No API key required.",
    ].join(" ");
  }
  if (err?.code === "KLINES_CACHE_MISS") {
    return err.message;
  }
  if (err?.code === "EXCHANGE_NETWORK_ERROR") {
    return [
      err.message,
      "Quick fixes:",
      "  1) VPN / proxy / run on staging server",
      "  2) UI backtest once on server → then local: --cache-only (needs DATABASE_URL)",
      "  3) Offline dev: --mock --quick",
    ].join("\n");
  }
  if (err?.name === "NetworkError" || /fetch failed/i.test(String(err?.message))) {
    return [
      `Cannot reach ${opts.exchange} API (${err.message}).`,
      "Network block — not a missing Settings exchange.",
      "Try: VPN · run on server · --cache-only (after UI backtest fills DB) · --mock",
    ].join(" ");
  }
  return err?.message || String(err);
}

async function fetchRealCandles(symbol, timeframe, opts, extra = {}) {
  const HistoricalKlinesService = require("../../../src/modules/backtest/services/HistoricalKlinesService");
  const useCustom = Boolean(opts.start && opts.end);
  const periodId = useCustom
    ? "custom"
    : getEffectivePeriod(daysToPeriodId(opts.days), timeframe);
  try {
    return await HistoricalKlinesService.fetchHistoricalKlines(opts.user || null, {
      symbol,
      timeframe,
      periodId,
      customStart: opts.start,
      customEnd: opts.end,
      allowClamp: true,
      exchangeType: opts.exchange,
      cacheOnly: opts.cacheOnly === true,
      ...(extra.maxBars ? { maxBarsOverride: extra.maxBars } : {}),
      ...(extra.warmupBars ? { warmupBars: extra.warmupBars } : {}),
    });
  } catch (err) {
    const wrapped = new Error(formatFetchError(err, opts));
    wrapped.cause = err;
    throw wrapped;
  }
}

async function loadCandles(symbol, tf, opts, role) {
  if (opts.source === "mock") {
    return {
      candles: genMock(symbol, opts.days, TF_MIN[tf] || 15, `${symbol} ${tf}`),
      meta: { source: "mock", exchange: null, exchangeLabel: "mock" },
    };
  }
  logPhase(`fetching ${symbol} ${tf} (${opts.exchange})…`);
  const res = await fetchRealCandles(symbol, tf, opts, {
    maxBars: role === "entry" ? TYPE_MAX_BARS[tf] : undefined,
    warmupBars: role === "htf" ? 60 : 0,
  });
  const n = res.candles?.length ?? 0;
  logPhase(
    `  ${tf}: ${n.toLocaleString()} bars · ${res.exchangeLabel || opts.exchange}`
    + (res.coverage != null ? ` · coverage ${res.coverage}%` : ""),
  );
  return { candles: res.candles || [], meta: res };
}

function applyRelaxOverrides(legOverride, tradeType) {
  // Research-only denser samples — NOT for live promotion.
  if (tradeType === "Scalping") {
    legOverride.smcMinConfidenceALong = 70;
    legOverride.smcMinConfidenceAShort = 65;
    legOverride.smcSessionFilter = false;
  } else if (tradeType === "Intraday") {
    legOverride.smcMinConfidenceB = 55;
  } else if (tradeType === "Swing") {
    legOverride.smcMinConfidenceC = 55;
    legOverride.smcFundingGuard = false;
  }
}

/**
 * Pin dataset-expand jobs to the folder's component — not the full umbrella race.
 *
 * AdaptiveFusionUmbrella / TrendSurge / … treat empty afActiveRacers as
 * "all racers" (FOUNDRY/FORGE default). applyStrategyJobDefaults already
 * isolates secondary keys (WYCKOFF, VSA, MARKET_STRUCTURE, …) but primary
 * engine keys (SMART_MONEY_CONCEPTS, TREND_FOLLOWING, …) were left open —
 * so `smart-money-concepts/scalping.js` silently raced VSA+Wyckoff and
 * produced ~116 trades (mostly VSA) while UI SMC-only showed ~25.
 *
 * FE Advance parity: selecting only "Smart Money Concepts" sends
 * selectedComponents: ["SMART_MONEY_CONCEPTS"] (+ afActiveVoters).
 * Secondary keys are also pinned here so buildConfig is self-contained
 * even if applyStrategyJobDefaults changes.
 */
function ensureDatasetComponentIsolation(strategyKey, paramsIn = {}) {
  const params = { ...paramsIn };
  const hasAf = params.afActiveRacers || params.afActiveVoters
    || (Array.isArray(params.selectedComponents) && params.selectedComponents.length);
  const hasTs = params.tsActiveRacers;
  const hasMd = params.mdActiveRacers;
  const hasBs = params.bsActiveRacers;

  if (strategyKey === "SMART_MONEY_CONCEPTS" && !hasAf) {
    params.afActiveRacers = ["SMART_MONEY_CONCEPTS"];
    params.afActiveVoters = ["SMART_MONEY_CONCEPTS"];
    params.selectedComponents = ["SMART_MONEY_CONCEPTS"];
  } else if (strategyKey === "WYCKOFF" && !hasAf) {
    params.afActiveRacers = ["WYCKOFF"];
    params.afActiveVoters = ["WYCKOFF"];
    params.selectedComponents = ["WYCKOFF"];
  } else if (strategyKey === "VOLUME_SPREAD_ANALYSIS" && !hasAf) {
    params.afActiveRacers = ["VOLUME_SPREAD_ANALYSIS"];
    params.afActiveVoters = ["VOLUME_SPREAD_ANALYSIS"];
    params.selectedComponents = ["VOLUME_SPREAD_ANALYSIS"];
  } else if (strategyKey === "TREND_FOLLOWING" && !hasTs && !hasAf) {
    params.tsActiveRacers = ["TREND_FOLLOWING"];
    params.selectedComponents = ["TREND_FOLLOWING"];
  } else if (strategyKey === "MARKET_STRUCTURE" && !hasTs && !hasAf) {
    params.tsActiveRacers = ["MARKET_STRUCTURE"];
    params.selectedComponents = ["MARKET_STRUCTURE"];
  } else if (strategyKey === "AUCTION_MARKET_THEORY" && !hasTs && !hasAf) {
    params.tsActiveRacers = ["AUCTION_MARKET_THEORY"];
    params.selectedComponents = ["AUCTION_MARKET_THEORY"];
  } else if (strategyKey === "MEAN_REVERSION" && !hasMd && !hasAf) {
    params.mdActiveRacers = ["MEAN_REVERSION"];
    params.selectedComponents = ["MEAN_REVERSION"];
  } else if (strategyKey === "SUPPLY_AND_DEMAND" && !hasMd && !hasAf) {
    params.mdActiveRacers = ["SUPPLY_AND_DEMAND"];
    params.selectedComponents = ["SUPPLY_AND_DEMAND"];
  } else if (strategyKey === "STATISTICAL_ARBITRAGE" && !hasMd && !hasAf) {
    params.mdActiveRacers = ["STATISTICAL_ARBITRAGE"];
    params.selectedComponents = ["STATISTICAL_ARBITRAGE"];
  } else if (strategyKey === "BREAKOUT_RETEST" && !hasBs && !hasAf) {
    params.bsActiveRacers = ["BREAKOUT_RETEST"];
    params.selectedComponents = ["BREAKOUT_RETEST"];
  } else if (strategyKey === "ICT_STYLE_TRADING" && !hasBs && !hasAf) {
    params.bsActiveRacers = ["ICT_STYLE_TRADING"];
    params.selectedComponents = ["ICT_STYLE_TRADING"];
  } else if (strategyKey === "LIQUIDATION_SQUEEZE" && !hasBs && !hasAf) {
    params.bsActiveRacers = ["LIQUIDATION_SQUEEZE"];
    params.selectedComponents = ["LIQUIDATION_SQUEEZE"];
  }
  return params;
}

/**
 * Parity policy (2026-07-16): BE `strategyDefaults.js` is the SSOT for entry
 * geometry across ablation (via-api) · UI Advance · dry-run · live.
 *
 * buildConfig deliberately sends NO geometry overrides — mergeBacktestCfg
 * spreads resolveStrategyDefaults(strategyKey) as base. FE Advance
 * defaultParamsFor must mirror the same numbers (see FE backtestStrategies.js).
 * Do NOT reintroduce FE-only stricter/looser research knobs here.
 */
function buildConfig(strategyKey, tradeType, relax) {
  // Do NOT send empty typeOverrides — shallow (pre-fix) or even deep merge
  // of `{ Scalping: {} }` is pointless noise. Let BE resolveStrategyDefaults
  // SSOT supply atrGateRelative / atrMinMult / conf floors.
  let params = ensureDatasetComponentIsolation(
    strategyKey,
    applyStrategyJobDefaults(strategyKey, {}),
  );
  if (!relax) return params;

  const { resolveStrategyDefaults } = require("../../../src/config/strategyDefaults");
  const defaults = resolveStrategyDefaults(strategyKey);
  const baseOv = defaults.typeOverrides || {};
  const legOverride = { ...(baseOv[tradeType] || {}) };
  if (isAfStrategy(strategyKey)) {
    applyRelaxOverrides(legOverride, tradeType);
  }
  params = {
    ...params,
    typeOverrides: {
      Scalping: { ...(baseOv.Scalping || {}) },
      Intraday: { ...(baseOv.Intraday || {}) },
      Swing: { ...(baseOv.Swing || {}) },
      [tradeType]: legOverride,
    },
    ...(tradeType === "Swing" && isAfStrategy(strategyKey)
      ? { smcMinConfidenceC: 55, smcFundingGuard: false }
      : {}),
  };
  return params;
}

function mapTradeRow(t, symbol, idx, strategyKey, tradeType) {
  return {
    id: `${symbol}-${idx + 1}`,
    sessionId: `EXPAND-${strategyKey}-${tradeType}-${symbol}`,
    symbol,
    side: t.side,
    strategy: strategyKey,
    status: "Closed",
    entryPrice: t.entry,
    exitPrice: t.exit,
    sl: t.sl,
    tp: t.tp,
    size: t.size,
    pnl: t.grossPnl ?? t.pnl,
    fee: t.fee,
    funding: t.funding ?? 0,
    pnlNet: t.pnl,
    pnlPct: t.pnlPct,
    plannedRR: t.plannedRR,
    actualRR: "",
    duration: "",
    reason: t.reason,
    exitReason: t.reason,
    entryReasons: t.entryReasons,
    confidence: t.confidence,
    marketCond: t.marketCond ?? "NORMAL",
    htfTrend: t.htfTrend,
    dailyRegime: t.dailyRegime ?? "UNKNOWN",
    component: t.component || tradeType,
    tradeType: t.tradeType || tradeType,
    atr: t.atr,
    entryRsi: t.entryRsi,
    sweepStrength: t.sweepStrength,
    fvgSizeAtr: t.fvgSizeAtr,
    obDistanceAtr: t.obDistanceAtr,
    displacementPct: t.displacementPct,
    htfAdx: t.htfAdx,
    hourUtc: t.hourUtc,
    volumeRatio: t.volumeRatio,
    bbWidth: t.bbWidth,
    fundingRateAtEntry: t.fundingRateAtEntry,
    fundingForecast24h: t.fundingForecast24h,
    holdHours: t.holdHours,
    confSweepStrength: t.confSweepStrength,
    confFvgSize: t.confFvgSize,
    confDisplacementPct: t.confDisplacementPct,
    confHtfAlignment: t.confHtfAlignment,
    confMitigationDepth: t.confMitigationDepth,
    confObConfluence: t.confObConfluence,
    gradedScore: t.gradedScore ?? null,
    gradedScoreBreakdown: t.gradedScoreBreakdown ?? null,
    scoringStrategyKey: t.scoringStrategyKey ?? null,
    sweepAgeBars: t.sweepAgeBars ?? null,
    sweepToChochBars: t.sweepToChochBars ?? null,
    chochToEntryBars: t.chochToEntryBars ?? null,
    mfe: t.mfe ?? null,
    mae: t.mae ?? null,
    mfePercent: t.mfePercent ?? null,
    maePercent: t.maePercent ?? null,
    exitEfficiency: t.exitEfficiency ?? null,
    dryRun: true,
    mode: "backtest",
    exchange: "binance",
    openTime: t.openTime,
    closeTime: t.closeTime || t.date,
    isPartial: false,
    result: t.result,
  };
}

async function runBacktestEngine(opts, strategyKey, typeOrder) {
  if (AF_SMC_KEYS.has(strategyKey)) {
    return runTripleTypeBacktest({ ...opts, typeOrder });
  }
  return runMultiTypeBacktest({ ...opts }, typeOrder);
}

async function runSymbolViaApi(symbol, strategyKey, tradeType, cfg, opts) {
  const tfs = TYPE_TF[tradeType];
  logPhase(`\n══ ${symbol} · ${strategyKey} · ${tradeType} (${tfs.entry}/${tfs.trend}) · via-api ══`);
  const result = await runViaApi({
    apiBase: opts.api,
    token: opts.token,
    symbol,
    strategyKey,
    tradeType,
    days: opts.days,
    start: opts.start,
    end: opts.end,
    capital: opts.capital,
    exchange: opts.exchange,
    parameters: cfg,
    log: logPhase,
  });
  const trades = result.trades || [];
  console.log(`  trades=${trades.length} WR=${result.stats?.winRate} PF=${result.stats?.profitFactor}`);

  // Persist per-strategy ablation funnel from server job. Resolve the ACTIVE
  // racer/voter for this job (SMC / WYCKOFF / VSA / TF / MS / AMT / MR / SD / SA /
  // BR / ICT / LS) and render THAT strategy's own indicator funnel — so 0/low-trade
  // runs are diagnosable per strategy, not only for SMC.
  const ablation = result.perTypeStats?.[tradeType]?.ablation;
  const execAblation = result.perTypeStats?.[tradeType]?.execAblation;
  const ablKey = resolveAblationStrategyKey(strategyKey, cfg);
  if (ablKey && (ablation || execAblation)) {
    try {
      const funnelText = formatStrategyFunnel(
        ablKey,
        ablation,
        execAblation,
        `${ablKey} filter funnel (${tradeType}, via-api, ${trades.length} trades):`,
      );
      console.log(funnelText);
      fs.mkdirSync(DATASET_EXPAND_TMP, { recursive: true });
      fs.writeFileSync(
        path.join(DATASET_EXPAND_TMP, "ablation.txt"),
        [
          `strategy: ${ablKey}`,
          `tradeType: ${tradeType}`,
          `dataSource: via-api`,
          `api: ${opts.api}`,
          `symbol: ${symbol}`,
          `exchange: ${opts.exchange}`,
          `timeframes: ${tfs.entry}/${tfs.trend}`,
          "",
          funnelText,
          "",
        ].join("\n"),
        "utf8",
      );
    } catch { /* ignore */ }
  }

  return {
    symbol,
    trades,
    stats: result.stats,
    perTypeStats: result.perTypeStats,
    fetchMeta: {
      source: "via-api",
      api: opts.api,
      dataInfo: result.dataInfo?.[tradeType] || null,
      engineMeta: result.engineMeta,
    },
  };
}

async function runSymbol(symbol, strategyKey, tradeType, cfg, opts) {
  if (opts.viaApi) {
    return runSymbolViaApi(symbol, strategyKey, tradeType, cfg, opts);
  }

  const tfs = TYPE_TF[tradeType];
  if (!tfs) throw new Error(`Unknown trade type: ${tradeType}`);

  logPhase(`\n══ ${symbol} · ${strategyKey} · ${tradeType} (${tfs.entry}/${tfs.trend}) ══`);
  const entryRes = await loadCandles(symbol, tfs.entry, opts, "entry");
  const htfRes = await loadCandles(symbol, tfs.trend, opts, "htf");
  const dailyRes = await loadCandles(symbol, "1d", opts, "daily");
  let btcEntry = null;
  if (strategyKey === "STATISTICAL_ARBITRAGE" && symbol.toUpperCase() !== "BTCUSDT") {
    const btcRes = await loadCandles("BTCUSDT", tfs.entry, opts, "btc-benchmark");
    btcEntry = btcRes.candles;
  }
  const entry = entryRes.candles;
  const htf = htfRes.candles;
  const daily = dailyRes.candles;
  logPhase(
    `  ready entry=${entry.length.toLocaleString()} htf=${htf.length.toLocaleString()} `
    + `daily=${daily.length.toLocaleString()} source=${opts.source}`,
  );

  const feeSchedule = resolveFeeSchedule(opts.exchange);
  const onProgress = makeProgressLogger("backtest");
  logPhase("  running backtest…");
  const result = await runBacktestEngine({
    strategyKey,
    capital: opts.capital,
    enableFees: true,
    enableSlippage: true,
    exchangeType: opts.exchange,
    feeSchedule,
    config: cfg,
    typeOrder: [tradeType],
    naturalTypeOrder: naturalTypeOrder(strategyKey),
    entryCandles: { [tradeType]: entry },
    htfCandles: { [tradeType]: htf },
    dailyCandles: daily,
    symbol,
    btcEntryCandles: btcEntry,
    dataSource: opts.source,
    ablationMeta: {
      entryTf: tfs.entry,
      htfTf: tfs.trend,
      entryBars: entry.length,
      htfBars: htf.length,
      exchange: entryRes.meta?.exchange || opts.exchange,
      exchangeLabel: entryRes.meta?.exchangeLabel,
      coverage: entryRes.meta?.coverage,
    },
    onProgress: (pct) => onProgress(pct),
  }, strategyKey, [tradeType]);

  const trades = result.trades || [];
  console.log(`  trades=${trades.length} WR=${result.stats?.winRate} PF=${result.stats?.profitFactor}`);
  return {
    symbol,
    trades,
    stats: result.stats,
    perTypeStats: result.perTypeStats,
    fetchMeta: {
      entry: entryRes.meta,
      htf: htfRes.meta,
      daily: dailyRes.meta,
    },
  };
}

/** be-bot-trading/scripts/dataset-expand/tmp — run artifacts (gitignored), NOT under REPO_ROOT/tmp. */
const DATASET_EXPAND_TMP = path.join(__dirname, "..", "tmp", "dataset-expand");

function defaultOutDir(strategyKey, tradeType) {
  const slug = SLUG_BY_KEY[strategyKey] || strategyKey.toLowerCase();
  return path.join(DATASET_EXPAND_TMP, slug, tradeType.toLowerCase());
}

async function main({ strategyKey, tradeType, argv = process.argv.slice(2) }) {
  const started = Date.now();
  const opts = parseArgs(argv);
  if (!Number.isFinite(opts.days) || opts.days <= 0) {
    opts.days = defaultDaysForType(tradeType);
  }
  validateOpts(opts);
  if (opts.viaApi && !opts.token && opts.email && opts.password) {
    opts.token = await loginForToken({
      apiBase: opts.api,
      email: opts.email,
      password: opts.password,
      log: logPhase,
    });
  }
  const tfs = TYPE_TF[tradeType];
  const outDir = opts.out || defaultOutDir(strategyKey, tradeType);
  const cfg = buildConfig(strategyKey, tradeType, opts.relax);
  const columns = mlDatasetColumns(strategyKey);

  logPhase(
    `ready · ${strategyKey} · ${tradeType} (${tfs.entry}/${tfs.trend}) · `
    + `${opts.days}d · ${opts.symbols.length} symbol(s) · ${opts.source}`
    + (opts.viaApi
      ? ` · via-api → ${opts.api} · ${opts.exchange}`
      : opts.source === "real"
        ? ` · ${opts.exchange} (--local)`
        : "")
    + (opts.quick ? " · --quick" : ""),
  );
  if (opts.viaApi) {
    logPhase("mode: via-api (1:1 with UI — fetch+engine on BE server)");
  } else if (opts.source === "real" && tradeType === "Scalping" && opts.days >= 180) {
    logPhase("tip: local Scalping 180d may take 2–5 min/symbol if exchange API reachable");
  }

  fs.mkdirSync(outDir, { recursive: true });
  const allRows = [];
  const perSymbol = [];

  for (const symbol of opts.symbols) {
    const { trades, stats, perTypeStats, fetchMeta } = await runSymbol(
      symbol, strategyKey, tradeType, cfg, opts,
    );
    perSymbol.push({
      symbol,
      totalTrades: trades.length,
      wins: stats?.wins,
      losses: stats?.losses,
      winRate: stats?.winRate,
      profitFactor: stats?.profitFactor,
      totalReturn: stats?.totalReturn,
      perTypeStats: perTypeStats?.[tradeType],
      fetchMeta,
    });
    trades.forEach((t, i) => allRows.push(mapTradeRow(t, symbol, i, strategyKey, tradeType)));
  }

  const csvPath = path.join(outDir, "trades.csv");
  const statsPath = path.join(outDir, "stats.json");
  fs.writeFileSync(csvPath, toCsv(allRows, columns));
  const summary = {
    generatedAt: new Date().toISOString(),
    strategyKey,
    tradeType,
    source: opts.viaApi ? "via-api" : opts.source,
    exchange: opts.source === "real" ? opts.exchange : null,
    api: opts.viaApi ? opts.api : null,
    capital: opts.capital,
    days: opts.days,
    symbols: opts.symbols,
    relax: opts.relax,
    totalTrades: allRows.length,
    targetMet: allRows.length >= 300,
    perSymbol,
    recipe: {
      strategy: strategyKey,
      tradeType,
      entryTf: tfs.entry,
      trendTf: tfs.trend,
      dailyTf: "1d",
      periodDays: opts.days,
      engine: AF_SMC_KEYS.has(strategyKey) ? "runTripleTypeBacktest" : "runMultiTypeBacktest",
      typeTfSsot: "runBacktestJob.TYPE_TF",
      dataParity: opts.viaApi
        ? "via-api: POST /api/v1/backtest/run-real (identical to FE Advance UI)."
        : "local HistoricalKlinesService (needs exchange network + optional DB).",
      notes: [
        "Default: --via-api against DATASET_EXPAND_API_URL (1:1 UI). Use --local only when this machine can reach the exchange.",
        "Pins afActiveRacers/afActiveVoters/selectedComponents to the folder strategy (SMC-only, not full AF race).",
        "SMC via-api also sends FE Advance factory geometry (smcSweepVolMult 1.3, …) — bare BE SSOT is looser and over-fires vs UI.",
        "Match UI with the same --days (UI often 90d / period 3m) + Binance + capital $1000.",
        "Pass --relax for AF research-only denser samples (lower conf floors / session off).",
        "Default --days respects TYPE_MAX_PERIOD cap per entry TF; capital default $1000 (UI parity).",
      ],
    },
  };
  fs.writeFileSync(statsPath, JSON.stringify(summary, null, 2));

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log("\n══ SUMMARY ══");
  console.log(`  Strategy: ${strategyKey} · ${tradeType} (${tfs.entry}/${tfs.trend})`);
  console.log(`  Total trades: ${allRows.length} (target 300+ → ${summary.targetMet ? "YES" : "not yet — try --relax or more symbols"})`);
  console.log(`  Elapsed: ${elapsed}s`);
  console.log(`  CSV:   ${csvPath}`);
  console.log(`  Stats: ${statsPath}`);
}

module.exports = {
  main,
  parseArgs,
  buildConfig,
  ensureDatasetComponentIsolation,
  defaultDaysForType,
  TYPE_TF,
  REPO_ROOT,
};
