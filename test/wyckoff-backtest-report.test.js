/**
 * Wyckoff customizable local backtest — prints PnL / win rate / drawdown / etc.
 *
 * No deploy required. Default source is mock (offline CI-safe).
 * For last-12-months real candles, use public exchange fetch (binance by default).
 *
 * ── Config (env or CLI flags) ──────────────────────────────────────────────
 *   WYCKOFF_BT_SOURCE / --source     mock | real          (default: mock)
 *   WYCKOFF_BT_MONTHS / --months     number               (default: 12)
 *   WYCKOFF_BT_SYMBOL / --symbol     BTCUSDT              (default: BTCUSDT)
 *   WYCKOFF_BT_TYPES  / --types      Intraday|Scalping|…  (default: Intraday)
 *   WYCKOFF_BT_CAPITAL / --capital   1000                 (default: 1000)
 *   WYCKOFF_BT_EXCHANGE / --exchange binance|bitget|okx   (default: binance)
 *   WYCKOFF_BT_KLINES / --klines     exchange|vision|file (default: exchange = web parity)
 *       exchange = HistoricalKlinesService (CCXT USDT-M futures/swap) — SAME as website
 *       vision   = data-api.binance.vision SPOT klines (NOT futures parity)
 *       file     = offline JSON (default dir: backtest-reports/btcusdt_data) — NO API
 *   WYCKOFF_BT_CACHE_DIR / --cache-dir  JSON candle dir (default: backtest-reports/btcusdt_data)
 *   WYCKOFF_BT_WEB_PARITY / --web-parity  0|1  (default: 1 for real) — 5m→180d cap,
 *       daily regime candles, HTF warmupBars=60, pair-tier SL× (mirrors runBacktestJob)
 *   WYCKOFF_BT_ENTRY_MODEL / --entry-model  balanced|moderate|aggressive|conservative
 *   WYCKOFF_BT_FEES / --fees         0|1                  (default: 0 for mock, 1 for real)
 *   WYCKOFF_BT_OUT_DIR / --out       custom output folder (optional)
 *   WYCKOFF_BT_OUT_FILE / --out-file custom single .txt path (optional)
 *
 * After each run, ONE combined report file is written:
 *   backtest-reports/wyckoff/<timestamp>_<symbol>_<Nm>_<source>_....txt
 *   (summary + index table + funnel + detail every position)
 *
 * ── Run ────────────────────────────────────────────────────────────────────
 *   # Prefer the CLI script (Node 24 `node --test` does NOT forward --flags):
 *   node scripts/wyckoff-backtest-report.js --source real --months 12 --symbol BTCUSDT --types Scalping,Intraday,Swing --fees 1
 *   npm run wyckoff:report -- --source real --types Scalping --fees 1
 *   npm run test:wyckoff:12m
 *
 *   # Env overrides also work under `node --test`:
 *   set WYCKOFF_BT_TYPES=Scalping,Intraday,Swing&& set WYCKOFF_BT_SOURCE=real&& npm run test:wyckoff:report
 *
 *   # CI-safe mock (no network)
 *   npm run test:wyckoff:report
 */

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { runTripleTypeBacktest } = require("#modules/backtest/services/RealStrategyBacktestService.js");
const {
  applyStrategyJobDefaults,
  ensurePairTierOnParameters,
  getEffectivePeriod,
  TYPE_TF,
  TYPE_MAX_BARS,
} = require("#modules/backtest/services/runBacktestJob.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT_ROOT = path.join(REPO_ROOT, "backtest-reports", "wyckoff");

/** Once Binance CCXT/fapi is blocked (e.g. ISP Internet Positif), skip retries. */
let exchangeKlinesBlocked = false;

// ── Config parsing ───────────────────────────────────────────────────────────

function parseCfg(argv = process.argv.slice(2)) {
  // node --test: args after `--` are forwarded to the test file. Depending on
  // Node version, the literal `--` may or may not remain in process.argv.
  // When it is stripped, values like "Scalping,Intraday,Swing" no longer sit
  // next to "--types" if we only keep tokens that start with "--" — that bug
  // silently fell back to default types=Intraday.
  const dash = argv.indexOf("--");
  let args;
  if (dash >= 0) {
    args = argv.slice(dash + 1);
  } else {
    // Keep flag+value pairs: "--types", "Scalping,Intraday,Swing", ...
    args = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!String(a).startsWith("--")) continue;
      args.push(a);
      const next = argv[i + 1];
      if (next != null && !String(next).startsWith("--")) {
        args.push(next);
        i += 1;
      }
    }
  }

  const get = (flag, envKey, def) => {
    const i = args.indexOf(flag);
    if (i !== -1 && args[i + 1] != null && !String(args[i + 1]).startsWith("--")) {
      return args[i + 1];
    }
    if (process.env[envKey] != null && process.env[envKey] !== "") {
      return process.env[envKey];
    }
    return def;
  };

  const source = String(get("--source", "WYCKOFF_BT_SOURCE", "mock")).toLowerCase();
  const months = Math.max(1, parseInt(get("--months", "WYCKOFF_BT_MONTHS", "12"), 10) || 12);
  const feesFlag = get("--fees", "WYCKOFF_BT_FEES", source === "real" ? "1" : "0");
  const isReal = source === "real" || source === "db";
  // Real defaults to offline file cache (backtest-reports/btcusdt_data) — no exchange API.
  const defaultCacheDir = path.join(REPO_ROOT, "backtest-reports", "btcusdt_data");
  const legacyCacheDir = path.join(REPO_ROOT, "tmp", "wyckoff-bt-cache");
  const cacheDirRaw = get(
    "--cache-dir",
    "WYCKOFF_BT_CACHE_DIR",
    fs.existsSync(defaultCacheDir) ? defaultCacheDir : legacyCacheDir,
  );
  const klinesRaw = String(
    get("--klines", "WYCKOFF_BT_KLINES", isReal ? "file" : "exchange"),
  ).toLowerCase();
  const klines = klinesRaw === "vision" || klinesRaw === "spot"
    ? "vision"
    : (klinesRaw === "file" || klinesRaw === "cache" || klinesRaw === "local")
      ? "file"
      : "exchange";
  const webParityFlag = get(
    "--web-parity",
    "WYCKOFF_BT_WEB_PARITY",
    isReal ? "1" : "0",
  );

  return {
    source: isReal ? "real" : "mock",
    months,
    days: Math.round(months * 30.44),
    /** Maps CLI --months onto website periodId ("3m"|"6m"|"12m"). */
    periodId: months <= 3 ? "3m" : months <= 6 ? "6m" : "12m",
    symbol: String(get("--symbol", "WYCKOFF_BT_SYMBOL", "BTCUSDT")).toUpperCase(),
    types: String(get("--types", "WYCKOFF_BT_TYPES", "Intraday"))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    capital: parseFloat(get("--capital", "WYCKOFF_BT_CAPITAL", "1000")) || 1000,
    exchange: String(get("--exchange", "WYCKOFF_BT_EXCHANGE", "binance")).toLowerCase(),
    /** exchange | vision | file (offline JSON dump). */
    klines,
    cacheDir: path.resolve(String(cacheDirRaw)),
    webParity: webParityFlag === "1" || webParityFlag === "true",
    entryModel: String(get("--entry-model", "WYCKOFF_BT_ENTRY_MODEL", "balanced")),
    enableFees: feesFlag === "1" || feesFlag === "true",
    userId: get("--user", "WYCKOFF_BT_USER_ID", process.env.DATASET_EXPAND_USER_ID || null),
    outDir: get("--out", "WYCKOFF_BT_OUT_DIR", null),
    outFile: get("--out-file", "WYCKOFF_BT_OUT_FILE", null),
  };
}

const CFG = parseCfg();

const TF_MIN = {
  "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080,
};

// ── Candle loaders ───────────────────────────────────────────────────────────

/** Deterministic regime-cycling mock (same spirit as scripts/backtest-af-real.js). */
function genMock(symbol, days, intervalMin) {
  const bars = Math.floor((days * 24 * 60) / intervalMin);
  const seed = symbol.startsWith("BTC") ? 65000
    : symbol.startsWith("ETH") ? 3500
      : 600;
  let price = seed;
  // End "now", walk backward so the window is the last N months
  let time = Date.now() - bars * intervalMin * 60_000;
  const REGIMES = ["STRONG_UP", "NORMAL", "VOLATILE_CHOP", "STRONG_DOWN", "NORMAL"];
  const REGIME_LEN = Math.max(1, Math.floor((24 * 60) / intervalMin));
  const candles = [];
  let s = 123456789;
  const rnd = () => {
    s = (1103515245 * s + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < bars; i++) {
    const regime = REGIMES[Math.floor(i / REGIME_LEN) % REGIMES.length];
    let drift;
    let noiseAmp;
    switch (regime) {
      case "STRONG_UP": drift = price * 0.0015; noiseAmp = 0.004; break;
      case "STRONG_DOWN": drift = -price * 0.0015; noiseAmp = 0.004; break;
      case "VOLATILE_CHOP": drift = (rnd() - 0.5) * price * 0.003; noiseAmp = 0.012; break;
      default: drift = (rnd() - 0.45) * price * 0.0008; noiseAmp = 0.005;
    }
    const noise = (rnd() - 0.5) * price * noiseAmp * 2;
    const open = price;
    const close = Math.max(price + drift + noise, 1);
    const high = Math.max(open, close) * (1 + rnd() * noiseAmp);
    const low = Math.min(open, close) * (1 - rnd() * noiseAmp);
    candles.push({
      timestamp: time,
      date: new Date(time).toISOString(),
      open,
      high,
      low,
      close,
      volume: 1000 + rnd() * 2000,
    });
    price = close;
    time += intervalMin * 60_000;
  }
  return candles;
}

/**
 * Public Binance Vision SPOT OHLCV (no API key).
 * Reachable when api.binance.com / fapi.binance.com are geo-blocked.
 */
async function fetchBinanceVisionKlines(symbol, interval, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  const limit = 1000;
  while (cursor < endMs) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol)}`
      + `&interval=${encodeURIComponent(interval)}&startTime=${cursor}&endTime=${endMs}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`binance.vision HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const ts = Number(r[0]);
      if (ts < startMs || ts > endMs) continue;
      out.push({
        timestamp: ts,
        date: new Date(ts).toISOString(),
        open: +r[1],
        high: +r[2],
        low: +r[3],
        close: +r[4],
        volume: +r[5],
      });
    }
    const lastTs = Number(rows[rows.length - 1][0]);
    const next = lastTs + 1;
    if (next <= cursor || rows.length < limit) break;
    cursor = next;
  }
  return out;
}

/**
 * Direct USDT-M futures klines (no CCXT loadMarkets → avoids api.binance.com).
 * Tries fapi.binance.com then data-api.binance.vision/fapi (often 404).
 */
async function fetchBinanceFuturesKlines(symbol, interval, startMs, endMs) {
  const hosts = [
    "https://fapi.binance.com",
    "https://data-api.binance.vision",
  ];
  let lastErr = null;
  for (const host of hosts) {
    try {
      const out = [];
      let cursor = startMs;
      const limit = 1000;
      while (cursor < endMs) {
        const url = `${host}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}`
          + `&interval=${encodeURIComponent(interval)}&startTime=${cursor}&endTime=${endMs}&limit=${limit}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`${host} HTTP ${res.status}`);
        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length === 0) break;
        for (const r of rows) {
          const ts = Number(r[0]);
          if (ts < startMs || ts > endMs) continue;
          out.push({
            timestamp: ts,
            date: new Date(ts).toISOString(),
            open: +r[1],
            high: +r[2],
            low: +r[3],
            close: +r[4],
            volume: +r[5],
          });
        }
        const lastTs = Number(rows[rows.length - 1][0]);
        const next = lastTs + 1;
        if (next <= cursor || rows.length < limit) break;
        cursor = next;
      }
      if (out.length > 50) return { candles: out, host };
      lastErr = new Error(`${host}: only ${out.length} bars`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Binance futures klines unreachable");
}

function resolveKlineRangeMs(tf, cfg, { warmupBars = 0, periodId = null } = {}) {
  const HistoricalKlinesService = require("#modules/backtest/services/HistoricalKlinesService.js");
  const effectivePeriod = periodId
    || (cfg.webParity ? getEffectivePeriod(cfg.periodId, tf) : cfg.periodId);
  const range = HistoricalKlinesService.periodToRange(effectivePeriod);
  if (!range) {
    const endMs = Date.now();
    return {
      startMs: endMs - cfg.days * 86_400_000,
      endMs,
      effectivePeriod: cfg.periodId,
    };
  }
  let { startMs, endMs } = range;
  if (warmupBars > 0) {
    const tfMs = HistoricalKlinesService.CANDLE_INTERVAL_MS[String(tf).toLowerCase()];
    if (tfMs) startMs -= warmupBars * tfMs;
  }
  const typeMaxBars = TYPE_MAX_BARS[tf];
  if (typeMaxBars) {
    const tfMs = HistoricalKlinesService.CANDLE_INTERVAL_MS[String(tf).toLowerCase()];
    if (tfMs) {
      const minStart = endMs - typeMaxBars * tfMs;
      if (startMs < minStart) startMs = minStart;
    }
  }
  return { startMs, endMs, effectivePeriod };
}

async function loadVisionSpotCandles(symbol, tf, startMs, endMs, effectivePeriod, warmupBars, label) {
  const candles = await fetchBinanceVisionKlines(symbol, tf, startMs, endMs);
  if (candles.length <= 50) {
    throw new Error(`binance.vision returned only ${candles.length} ${tf} bars`);
  }
  return {
    candles,
    source: label,
    meta: {
      count: candles.length,
      effectivePeriod,
      warmupBars,
      exchange: "binance",
      warn: "SPOT Vision — not identical to website futures OHLCV",
    },
  };
}

/** Normalize dump row (legacy lowercase OR Binance PascalCase export). */
function normalizeCacheCandle(r) {
  const ts = Number(
    r.timestamp ?? r.t ?? r.OpenTimeMilliseconds ?? r.openTime ?? r.time ?? r[0],
  );
  if (!Number.isFinite(ts)) return null;
  const open = +(r.open ?? r.Open ?? r[1]);
  const high = +(r.high ?? r.High ?? r[2]);
  const low = +(r.low ?? r.Low ?? r[3]);
  const close = +(r.close ?? r.Close ?? r[4]);
  const volume = +(r.volume ?? r.Volume ?? r[5] ?? 0);
  if (![open, high, low, close].every(Number.isFinite)) return null;
  return {
    timestamp: ts,
    date: r.date || r.OpenTimeUTC || new Date(ts).toISOString(),
    open,
    high,
    low,
    close,
    volume,
  };
}

function readJsonArrayFile(filePath) {
  let text = fs.readFileSync(filePath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const raw = JSON.parse(text);
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.candles)) return raw.candles;
  if (Array.isArray(raw?.data)) return raw.data;
  throw new Error(`Expected JSON array in ${path.basename(filePath)}`);
}

/**
 * Offline JSON: backtest-reports/btcusdt_data/BTCUSDT_15m_12_months.json
 * (also supports legacy tmp/wyckoff-bt-cache/BTCUSDT_5m_365d.json).
 */
function loadFileCacheCandles(symbol, tf, startMs, endMs, effectivePeriod, warmupBars, cacheDir) {
  if (!fs.existsSync(cacheDir)) {
    throw new Error(
      `Candle cache dir missing: ${cacheDir}. `
      + `Place BTCUSDT_*_12_months.json under backtest-reports/btcusdt_data`,
    );
  }
  const tfKey = String(tf);
  const files = fs.readdirSync(cacheDir)
    .filter((f) => f.endsWith(".json") && (
      f.startsWith(`${symbol}_${tfKey}_`)
      // case-insensitive TF match (1M vs 1m)
      || f.toLowerCase().startsWith(`${symbol}_${tfKey}_`.toLowerCase())
    ))
    .sort();
  if (!files.length) {
    throw new Error(
      `No cache file for ${symbol} ${tf} in ${cacheDir}. `
      + `Expected e.g. ${symbol}_${tf}_12_months.json`,
    );
  }
  // Prefer longest window / 12_months naming when several exist.
  const pick = files.find((f) => /12_months/i.test(f)) || files[files.length - 1];
  const raw = readJsonArrayFile(path.join(cacheDir, pick));
  if (!raw.length) throw new Error(`Empty candle cache: ${pick}`);

  const candles = [];
  for (const r of raw) {
    const c = normalizeCacheCandle(r);
    if (!c) continue;
    if (c.timestamp < startMs || c.timestamp > endMs) continue;
    candles.push(c);
  }
  // Weekly / monthly dumps are short; allow fewer bars than intraday.
  const minBars = /^(1w|1W|1M)$/.test(tfKey) ? 20 : 50;
  if (candles.length < minBars) {
    throw new Error(
      `File cache ${pick} only has ${candles.length} bars in requested window `
      + `(need ≥${minBars}; ${new Date(startMs).toISOString().slice(0, 10)}…`
      + `${new Date(endMs).toISOString().slice(0, 10)}).`,
    );
  }
  return {
    candles,
    source: `file(${pick})`,
    meta: {
      count: candles.length,
      effectivePeriod,
      warmupBars,
      cacheFile: pick,
      cacheDir,
    },
  };
}

/**
 * Load OHLCV for one TF.
 * Default (klines=exchange): HistoricalKlinesService — SAME path as website
 *   (CCXT USDT-M futures / Bitget swap). If api.binance.com is geo-blocked
 *   (common: ISP Internet Positif), falls back once to Vision SPOT.
 * Optional (klines=vision): Binance Vision SPOT only (skip blocked futures hosts).
 * Optional (klines=file): offline JSON under --cache-dir (dump once, reuse forever).
 * Note: curl cannot bypass the same ISP block — api/fapi redirect to internet-positif.info.
 */
async function loadCandles(tf, cfg, { warmupBars = 0, periodId = null } = {}) {
  const intervalMin = TF_MIN[tf] || 15;
  if (cfg.source === "mock") {
    return { candles: genMock(cfg.symbol, cfg.days, intervalMin), source: "mock" };
  }

  const { startMs, endMs, effectivePeriod } = resolveKlineRangeMs(tf, cfg, { warmupBars, periodId });

  if (cfg.klines === "file") {
    return loadFileCacheCandles(
      cfg.symbol, tf, startMs, endMs, effectivePeriod, warmupBars, cfg.cacheDir,
    );
  }

  // Explicit Vision SPOT, or resume after we already know futures hosts are blocked.
  if (cfg.klines === "vision" || exchangeKlinesBlocked) {
    if (exchangeKlinesBlocked && cfg.klines !== "vision") {
      // quiet after the first loud warning
    }
    return loadVisionSpotCandles(
      cfg.symbol, tf, startMs, endMs, effectivePeriod, warmupBars,
      exchangeKlinesBlocked ? "binance.vision(spot-fallback)" : "binance.vision(spot)",
    );
  }

  // Website path: CCXT futures/swap via HistoricalKlinesService.
  const HistoricalKlinesService = require("#modules/backtest/services/HistoricalKlinesService.js");
  const typeMaxBars = TYPE_MAX_BARS[tf];
  try {
    const res = await HistoricalKlinesService.fetchHistoricalKlines(cfg.userId, {
      symbol: cfg.symbol,
      timeframe: tf,
      periodId: effectivePeriod,
      exchangeType: cfg.exchange,
      allowClamp: true,
      warmupBars,
      ...(typeMaxBars ? { maxBarsOverride: typeMaxBars } : {}),
    });
    return {
      candles: res.candles || [],
      source: `${res.exchange || cfg.exchange}(futures/swap)`,
      meta: {
        count: (res.candles || []).length,
        effectivePeriod,
        warmupBars,
        exchange: res.exchange,
        coverage: res.coverage,
        clamped: res.clamped,
      },
    };
  } catch (err) {
    const code = err?.code || "";
    const msg = String(err?.message || err);
    const networkBlocked = code === "EXCHANGE_NETWORK_ERROR"
      || /unreachable|fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|451|403|CERT_/i.test(msg);
    if (!networkBlocked) throw err;

    console.warn(`[wyckoff-report] ${cfg.exchange} API blocked/unreachable: ${msg}`);

    // Direct futures REST (skips CCXT loadMarkets → api.binance.com).
    if (cfg.exchange === "binance" || cfg.exchange === "binanceusdm") {
      try {
        const { candles, host } = await fetchBinanceFuturesKlines(
          cfg.symbol, tf, startMs, endMs,
        );
        console.warn(`[wyckoff-report] using direct futures klines via ${host}`);
        return {
          candles,
          source: `binance-fapi(${host.includes("vision") ? "vision" : "fapi"})`,
          meta: { count: candles.length, effectivePeriod, warmupBars, exchange: "binance" },
        };
      } catch (fapiErr) {
        console.warn(`[wyckoff-report] futures REST also failed: ${fapiErr.message}`);
      }

      exchangeKlinesBlocked = true;
      console.warn(
        "[wyckoff-report] FALLBACK → binance.vision SPOT (curl cannot bypass ISP block on api/fapi). "
        + "Website uses USDT-M futures — PnL will NOT match exactly. "
        + "True parity: run on VPS, use VPN, or --klines vision to skip the blocked hosts.",
      );
      return loadVisionSpotCandles(
        cfg.symbol, tf, startMs, endMs, effectivePeriod, warmupBars,
        "binance.vision(spot-fallback)",
      );
    }

    throw err;
  }
}

// ── Report printer ───────────────────────────────────────────────────────────

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}`;
}

function pct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return `${v}%`;
}

function computeExtraStats(trades, capital) {
  const list = Array.isArray(trades) ? trades : [];
  const wins = list.filter((t) => t.result === "win" || (t.pnl ?? t.pnlNet ?? 0) > 0);
  const losses = list.filter((t) => t.result === "loss" || (t.pnl ?? t.pnlNet ?? 0) < 0);
  const totalPnl = list.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const totalPnlNet = list.reduce((s, t) => s + (t.pnlNet ?? t.pnl ?? 0), 0);
  const totalFees = list.reduce((s, t) => s + (t.fee || 0), 0);

  const bySide = {};
  for (const side of ["LONG", "SHORT"]) {
    const subset = list.filter((t) => String(t.side).toUpperCase() === side);
    const w = subset.filter((t) => (t.pnl ?? 0) > 0).length;
    bySide[side] = {
      trades: subset.length,
      wins: w,
      winRate: subset.length ? ((w / subset.length) * 100).toFixed(1) : "0.0",
      pnl: subset.reduce((s, t) => s + (t.pnl ?? 0), 0),
    };
  }

  const exits = {};
  for (const t of list) {
    const r = t.reason || t.exitReason || "unknown";
    exits[r] = (exits[r] || 0) + 1;
  }

  return {
    totalPnl,
    totalPnlNet,
    totalFees,
    wins: wins.length,
    losses: losses.length,
    bySide,
    exits,
    finalCapital: capital + totalPnlNet,
  };
}

function printReport(cfg, result, loadMeta) {
  const stats = result.stats || {};
  const trades = result.trades || [];
  const extra = computeExtraStats(trades, cfg.capital);
  const line = "─".repeat(56);

  console.log(`\n${"═".repeat(58)}`);
  console.log(`  WYCKOFF LOCAL BACKTEST REPORT`);
  console.log(`${"═".repeat(58)}`);
  console.log(`  Symbol        : ${cfg.symbol}`);
  console.log(`  Window        : last ${cfg.months} month(s) (~${cfg.days}d)  periodId=${cfg.periodId}`);
  console.log(`  Source        : ${cfg.source}${loadMeta?.source ? ` (${loadMeta.source})` : ""}`);
  console.log(`  Klines        : ${cfg.klines}${cfg.webParity ? " + web-parity" : ""}`);
  console.log(`  Types         : ${cfg.types.join(", ")}`);
  console.log(`  Entry model   : ${cfg.entryModel}`);
  console.log(`  Capital       : $${cfg.capital}`);
  console.log(`  Fees          : ${cfg.enableFees ? "ON" : "OFF"}`);
  if (loadMeta?.pairTier?.pairSlMultiplier != null) {
    console.log(`  Pair tier SL× : ${Number(loadMeta.pairTier.pairSlMultiplier).toFixed(3)}`);
  }
  if (loadMeta?.bars) {
    console.log(`  Entry bars    : ${loadMeta.bars.entry?.toLocaleString?.() ?? loadMeta.bars.entry}`);
    console.log(`  HTF bars      : ${loadMeta.bars.htf?.toLocaleString?.() ?? loadMeta.bars.htf}`);
    if (loadMeta.bars.daily) {
      console.log(`  Daily bars    : ${loadMeta.bars.daily?.toLocaleString?.() ?? loadMeta.bars.daily}`);
    }
    const ep = loadMeta.bars.perType?.effectivePeriods;
    if (ep) {
      const parts = Object.entries(ep).map(([t, v]) => `${t}:${v.entry}`);
      if (parts.length) console.log(`  Eff. periods  : ${parts.join("  ")}`);
    }
  }
  console.log(line);
  console.log(`  Total Trades  : ${stats.totalTrades ?? trades.length}  (${extra.wins}W / ${extra.losses}L)`);
  console.log(`  Win Rate      : ${pct(stats.winRate ?? (trades.length ? ((extra.wins / trades.length) * 100).toFixed(1) : "0.0"))}`);
  console.log(`  Total PnL     : $${money(extra.totalPnl)}   (net $${money(extra.totalPnlNet)})`);
  console.log(`  Net Return    : ${pct(stats.totalReturn)}   (final $${stats.finalCapital ?? extra.finalCapital.toFixed(2)})`);
  console.log(`  Profit Factor : ${stats.profitFactor ?? "n/a"}`);
  console.log(`  Avg Win/Loss  : $${stats.avgWin ?? "0.00"} / $${stats.avgLoss ?? "0.00"}  (RR ${stats.riskReward ?? "n/a"})`);
  console.log(`  Max Drawdown  : ${pct(stats.maxDrawdown)}`);
  console.log(`  Sharpe        : ${stats.sharpe ?? "n/a"}`);
  console.log(`  Total Fees    : $${stats.totalFees ?? extra.totalFees.toFixed(2)}`);
  console.log(line);
  console.log(
    `  By Direction  : LONG ${extra.bySide.LONG.trades} (${extra.bySide.LONG.winRate}% WR, $${money(extra.bySide.LONG.pnl)})`
    + `  |  SHORT ${extra.bySide.SHORT.trades} (${extra.bySide.SHORT.winRate}% WR, $${money(extra.bySide.SHORT.pnl)})`,
  );
  const exitStr = Object.entries(extra.exits).map(([k, v]) => `${k}:${v}`).join("  |  ") || "none";
  console.log(`  By Exit       : ${exitStr}`);

  // Per-type breakdown
  if (result.perTypeStats) {
    console.log(line);
    for (const [type, ts] of Object.entries(result.perTypeStats)) {
      if (!ts || ts.skipped) {
        console.log(`  ${type.padEnd(10)} : SKIPPED ${ts?.reason ? `(${ts.reason})` : ""}`);
        continue;
      }
      const opened = ts.execAblation?.opened ?? "?";
      const passed = ts.ablation?.passed ?? "?";
      console.log(
        `  ${type.padEnd(10)} : trades=${ts.trades ?? 0}  wins=${ts.wins ?? 0}`
        + `  passed=${passed}  opened=${opened}  bars=${ts.entryBars ?? "?"}`,
      );
    }
  }
  console.log(`${"═".repeat(58)}\n`);

  return { stats, extra, trades };
}

// ── Save detailed position dumps to .txt folder ──────────────────────────────

function fmtNum(n, digits = 4) {
  const v = Number(n);
  if (!Number.isFinite(v)) return n == null ? "-" : String(n);
  return v.toFixed(digits);
}

function formatDuration(openTime, closeTime) {
  const a = Date.parse(openTime);
  const b = Date.parse(closeTime);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return "-";
  const mins = Math.round((b - a) / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 48) return `${h}h ${m}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function pickMeta(trade) {
  const meta = trade.entryMeta || trade.meta || {};
  const lines = [];
  const keys = [
    "reason", "wyPatternType", "wyPhase", "wyPhaseStrength", "wyVolumeRatio",
    "wyRr", "wySosOrSow", "wyLpsLevel", "wyEntryModel", "wyFakeBreakDepthAtr",
    "confidence", "plannedRR", "htfTrend", "dailyRegime", "marketCond",
  ];
  for (const k of keys) {
    const v = trade[k] ?? meta[k] ?? meta?.entry?.[k];
    if (v != null && v !== "") lines.push(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  }
  if (trade.entryReasons) {
    lines.push(`  entryReasons: ${trade.entryReasons}`);
  }
  // Dump leftover useful nested bits (compact)
  if (meta && typeof meta === "object") {
    const phase = meta.phase?.phase || meta.phase;
    const event = meta.signal?.event || meta.entry?.event;
    if (phase && !lines.some((l) => l.includes("wyPhase"))) lines.push(`  phase: ${phase}`);
    if (event) lines.push(`  signalEvent: ${event}`);
    if (meta.stopLoss != null) lines.push(`  meta.stopLoss: ${fmtNum(meta.stopLoss)}`);
    if (meta.takeProfit != null) lines.push(`  meta.takeProfit: ${fmtNum(meta.takeProfit)}`);
    if (meta.rr != null) lines.push(`  meta.rr: ${fmtNum(meta.rr, 2)}`);
  }
  return lines.length ? lines.join("\n") : "  (none)";
}

function formatPositionBlock(trade, index, runningPnl) {
  const entry = trade.entry ?? trade.entryPrice;
  const exit = trade.exit ?? trade.exitPrice;
  const pnl = trade.pnl ?? 0;
  const pnlNet = trade.pnlNet ?? pnl;
  const size = trade.size ?? trade.quantity;
  const result = trade.result || (pnl > 0 ? "win" : pnl < 0 ? "loss" : "flat");
  const lines = [
    `${"=".repeat(64)}`,
    `POSITION #${String(index).padStart(4, "0")}  |  ${String(trade.side || "?").toUpperCase()}  |  ${String(result).toUpperCase()}`,
    `${"=".repeat(64)}`,
    `Symbol       : ${trade.symbol || CFG.symbol}`,
    `Strategy     : ${trade.strategy || "WYCKOFF"}`,
    `Trade type   : ${trade.tradeType || trade.component || "-"}`,
    `Component    : ${trade.winningComponent || trade.component || "-"}`,
    ``,
    `Open time    : ${trade.openTime || trade.date || "-"}`,
    `Close time   : ${trade.closeTime || trade.date || "-"}`,
    `Duration     : ${formatDuration(trade.openTime, trade.closeTime || trade.date)}`,
    ``,
    `Entry price  : ${fmtNum(entry)}`,
    `Exit price   : ${fmtNum(exit)}`,
    `Stop loss    : ${fmtNum(trade.sl ?? trade.stopLoss)}`,
    `Take profit  : ${fmtNum(trade.tp ?? trade.takeProfit)}`,
    `Size         : ${fmtNum(size, 6)}`,
    `ATR (entry)  : ${fmtNum(trade.atr, 6)}`,
    `Planned RR   : ${fmtNum(trade.plannedRR, 2)}`,
    `Confidence   : ${fmtNum(trade.confidence, 3)}`,
    ``,
    `Gross PnL    : $${money(trade.grossPnl ?? pnl)}`,
    `Fee          : $${fmtNum(trade.fee ?? 0, 4)}`,
    `PnL          : $${money(pnl)}   (${fmtNum(trade.pnlPct, 2)}%)`,
    `PnL net      : $${money(pnlNet)}`,
    `Running PnL  : $${money(runningPnl)}`,
    ``,
    `Exit reason  : ${trade.reason || trade.exitReason || "-"}`,
    `Result       : ${result}`,
    `Partial      : ${trade.isPartial ? "yes" : "no"}`,
    ``,
    `HTF trend    : ${trade.htfTrend ?? "-"}`,
    `Daily regime : ${trade.dailyRegime ?? "-"}`,
    `Market cond  : ${trade.marketCond ?? "-"}`,
    `Entry RSI    : ${fmtNum(trade.entryRsi, 2)}`,
    ``,
    `-- Entry / Wyckoff meta --`,
    pickMeta(trade),
    ``,
  ];
  return lines.join("\n");
}

function buildSummarySection(cfg, result, loadMeta, report, filePath) {
  const stats = result.stats || {};
  const extra = report.extra;
  const lines = [
    "WYCKOFF LOCAL BACKTEST REPORT (SINGLE FILE)",
    "=".repeat(64),
    `Generated    : ${new Date().toISOString()}`,
    `Report file  : ${filePath}`,
    `Symbol       : ${cfg.symbol}`,
    `Window       : last ${cfg.months} month(s) (~${cfg.days}d)`,
    `Source       : ${cfg.source}${loadMeta?.source ? ` (${loadMeta.source})` : ""}`,
    `Types        : ${cfg.types.join(", ")}`,
    `Entry model  : ${cfg.entryModel}`,
    `Capital      : $${cfg.capital}`,
    `Fees         : ${cfg.enableFees ? "ON" : "OFF"}`,
    `Exchange     : ${cfg.exchange}`,
    "",
    `Entry bars   : ${loadMeta?.bars?.entry ?? "-"}`,
    `HTF bars     : ${loadMeta?.bars?.htf ?? "-"}`,
    "",
    "-".repeat(64),
    "SUMMARY",
    "-".repeat(64),
    `Total Trades : ${stats.totalTrades ?? report.trades.length}  (${extra.wins}W / ${extra.losses}L)`,
    `Win Rate     : ${pct(stats.winRate)}`,
    `Total PnL    : $${money(extra.totalPnl)}   (net $${money(extra.totalPnlNet)})`,
    `Net Return   : ${pct(stats.totalReturn)}   (final $${stats.finalCapital ?? extra.finalCapital.toFixed(2)})`,
    `Profit Factor: ${stats.profitFactor}`,
    `Avg Win/Loss : $${stats.avgWin} / $${stats.avgLoss}  (RR ${stats.riskReward})`,
    `Max Drawdown : ${pct(stats.maxDrawdown)}`,
    `Sharpe       : ${stats.sharpe}`,
    `Total Fees   : $${stats.totalFees ?? extra.totalFees.toFixed(2)}`,
    "",
    `LONG         : ${extra.bySide.LONG.trades} trades, WR ${extra.bySide.LONG.winRate}%, PnL $${money(extra.bySide.LONG.pnl)}`,
    `SHORT        : ${extra.bySide.SHORT.trades} trades, WR ${extra.bySide.SHORT.winRate}%, PnL $${money(extra.bySide.SHORT.pnl)}`,
    `Exits        : ${Object.entries(extra.exits).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
    "",
  ];

  if (result.perTypeStats) {
    lines.push("Per trade-type:");
    for (const [type, ts] of Object.entries(result.perTypeStats)) {
      if (!ts || ts.skipped) {
        lines.push(`  ${type}: SKIPPED ${ts?.reason || ""}`);
        continue;
      }
      lines.push(
        `  ${type}: trades=${ts.trades ?? 0} wins=${ts.wins ?? 0}`
        + ` passed=${ts.ablation?.passed ?? "-"} opened=${ts.execAblation?.opened ?? "-"}`
        + ` bars=${ts.entryBars ?? "-"}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildIndexSection(trades) {
  const lines = [
    "-".repeat(64),
    "POSITION INDEX",
    "-".repeat(64),
    "IDX  | RESULT | SIDE  | TYPE      | OPEN                 | CLOSE                | ENTRY      | EXIT       | PnL       | REASON",
    "-".repeat(120),
  ];
  trades.forEach((t, i) => {
    lines.push([
      String(i + 1).padStart(4, " "),
      String(t.result || "-").padEnd(6, " "),
      String(t.side || "-").padEnd(5, " "),
      String(t.tradeType || t.component || "-").padEnd(9, " "),
      String(t.openTime || "-").slice(0, 19).padEnd(20, " "),
      String(t.closeTime || t.date || "-").slice(0, 19).padEnd(20, " "),
      fmtNum(t.entry ?? t.entryPrice, 2).padStart(10, " "),
      fmtNum(t.exit ?? t.exitPrice, 2).padStart(10, " "),
      money(t.pnl ?? 0).padStart(9, " "),
      String(t.reason || t.exitReason || "-"),
    ].join(" | "));
  });
  if (!trades.length) lines.push("(no closed trades)");
  lines.push("");
  return lines.join("\n");
}

function buildFunnelSection(result) {
  const lines = [
    "-".repeat(64),
    "ABLATION / EXECUTION FUNNEL",
    "-".repeat(64),
    "",
  ];
  const pts = result.perTypeStats || {};
  if (!Object.keys(pts).length) {
    lines.push("(no perTypeStats)", "");
    return lines.join("\n");
  }
  for (const [type, ts] of Object.entries(pts)) {
    lines.push(`-- ${type} --`);
    if (!ts || ts.skipped) {
      lines.push(`  skipped: ${ts?.reason || "yes"}`, "");
      continue;
    }
    lines.push(`  trades      : ${ts.trades ?? 0}`);
    lines.push(`  wins        : ${ts.wins ?? 0}`);
    lines.push(`  entryBars   : ${ts.entryBars ?? 0}`);
    lines.push(`  htfBars     : ${ts.htfBars ?? 0}`);
    if (ts.ablationKey) lines.push(`  ablationKey : ${ts.ablationKey}`);
    if (ts.ablation && typeof ts.ablation === "object") {
      lines.push("  strategy ablation:");
      for (const [k, v] of Object.entries(ts.ablation)) {
        lines.push(`    ${k}: ${v}`);
      }
    }
    if (ts.execAblation && typeof ts.execAblation === "object") {
      lines.push("  execution ablation:");
      for (const [k, v] of Object.entries(ts.execAblation)) {
        lines.push(`    ${k}: ${v}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildPositionsSection(trades) {
  const lines = [
    "-".repeat(64),
    `POSITION DETAILS (${trades.length} trades)`,
    "-".repeat(64),
    "",
  ];
  let running = 0;
  trades.forEach((t, i) => {
    running += t.pnl ?? 0;
    lines.push(formatPositionBlock(t, i + 1, running));
  });
  if (!trades.length) lines.push("(no closed trades in this run)", "");
  return lines.join("\n");
}

/**
 * Write ONE combined .txt report under backtest-reports/wyckoff/
 * @returns {{ outFile: string, outDir: string, tradeCount: number }}
 */
function savePositionReports(cfg, result, loadMeta, report) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runId = [
    stamp,
    cfg.symbol,
    `${cfg.months}m`,
    cfg.source,
    cfg.types.join("-") || "Intraday",
    cfg.entryModel,
  ].join("_");

  const outDir = cfg.outDir
    ? path.resolve(cfg.outDir)
    : DEFAULT_OUT_ROOT;
  fs.mkdirSync(outDir, { recursive: true });

  const outFile = cfg.outFile
    ? path.resolve(cfg.outFile)
    : path.join(outDir, `${runId}.txt`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const trades = report.trades || result.trades || [];
  const body = [
    buildSummarySection(cfg, result, loadMeta, report, outFile),
    buildIndexSection(trades),
    buildFunnelSection(result),
    buildPositionsSection(trades),
    "=".repeat(64),
    "END OF REPORT",
    "=".repeat(64),
    "",
  ].join("\n");

  fs.writeFileSync(outFile, body, "utf8");

  // Pointer at repo root for easy discovery in the IDE
  try {
    const pointer = [
      "WYCKOFF backtest report (latest — single file)",
      "",
      outFile,
      "",
      `Trades : ${trades.length}`,
      `Generated : ${new Date().toISOString()}`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(REPO_ROOT, "WYCKOFF_REPORT_LATEST.txt"), pointer, "utf8");
  } catch {
    /* ignore pointer write failures */
  }

  return { outFile, outDir, tradeCount: trades.length, files: [outFile] };
}

// ── Backtest runner ──────────────────────────────────────────────────────────

async function runWyckoffCustomBacktest(cfg) {
  const typeOrder = cfg.types.filter((t) => TYPE_TF[t]);
  if (!typeOrder.length) {
    throw new Error(`No valid trade types in: ${cfg.types.join(",")}. Use Scalping, Intraday, and/or Swing.`);
  }

  if (cfg.source === "real" && cfg.klines === "vision") {
    console.warn(
      "[wyckoff-report] WARNING: --klines vision uses Binance SPOT bars. "
      + "Website Advance uses USDT-M futures/swap via HistoricalKlinesService — "
      + "results will NOT match. Prefer default --klines exchange.",
    );
  }
  if (cfg.source === "real" && cfg.klines === "file") {
    console.log(`[wyckoff-report] offline file cache: ${cfg.cacheDir}`);
  }

  const entryCandles = {};
  const htfCandles = {};
  const barsMeta = { entry: {}, htf: {}, sources: {}, effectivePeriods: {} };
  let candleExchange = cfg.exchange;

  for (const type of typeOrder) {
    const tfs = TYPE_TF[type];
    // Web parity: 12m + 5m → 180d (getEffectivePeriod); HTF gets warmupBars=60.
    const entryPeriod = cfg.webParity
      ? getEffectivePeriod(cfg.periodId, tfs.entry)
      : cfg.periodId;
    const htfPeriod = cfg.webParity
      ? getEffectivePeriod(cfg.periodId, tfs.trend)
      : cfg.periodId;

    console.log(
      `[wyckoff-report] fetch ${type} entry=${tfs.entry} period=${entryPeriod}`
      + ` htf=${tfs.trend} period=${htfPeriod} via ${cfg.klines}/${cfg.exchange}`,
    );

    const entryLoad = await loadCandles(tfs.entry, cfg, { periodId: entryPeriod });
    const htfLoad = await loadCandles(tfs.trend, cfg, {
      periodId: htfPeriod,
      warmupBars: cfg.webParity ? 60 : 0,
    });
    entryCandles[type] = entryLoad.candles;
    htfCandles[type] = htfLoad.candles;
    barsMeta.entry[type] = entryLoad.candles.length;
    barsMeta.htf[type] = htfLoad.candles.length;
    barsMeta.sources[type] = { entry: entryLoad.source, htf: htfLoad.source };
    barsMeta.effectivePeriods[type] = { entry: entryPeriod, htf: htfPeriod };
    if (entryLoad.meta?.exchange) candleExchange = entryLoad.meta.exchange;

    if (!entryLoad.candles.length) {
      throw new Error(`No ${tfs.entry} candles for ${type} (${cfg.source}/${cfg.klines})`);
    }
  }

  // Website always fetches 1d for dailyRegimeGate (CHOP → 50% size on WYCKOFF).
  // Also fetch on Vision / spot-fallback so desktop runs keep the same gate.
  let dailyCandles = [];
  if (cfg.source === "real" && cfg.webParity) {
    try {
      console.log("[wyckoff-report] fetch 1d daily candles for regime gate…");
      const dailyLoad = await loadCandles("1d", cfg, { periodId: cfg.periodId });
      dailyCandles = dailyLoad.candles || [];
      barsMeta.daily = dailyCandles.length;
    } catch (err) {
      console.warn(`[wyckoff-report] daily candles failed (fail-open): ${err.message}`);
      dailyCandles = [];
    }
  }

  const { STRATEGIES } = require("#config/strategyDefaults.js");
  const wyDefaults = STRATEGIES.WYCKOFF || {};
  let config = applyStrategyJobDefaults("WYCKOFF", {
    activeTypes: typeOrder,
    entryModel: cfg.entryModel,
    allowHtfSideways: wyDefaults.allowHtfSideways,
    sidewaysShortOnly: wyDefaults.sidewaysShortOnly,
    allowHtfSidewaysLong: wyDefaults.allowHtfSidewaysLong,
    requireHtfAlign: wyDefaults.requireHtfAlign !== false,
    volumeConfirmMult: wyDefaults.volumeConfirmMult,
    longVolumeConfirmMult: wyDefaults.longVolumeConfirmMult,
    shortVolumeConfirmMult: wyDefaults.shortVolumeConfirmMult,
    cooldownBars: wyDefaults.cooldownBars,
    atrMinMult: wyDefaults.atrMinMult,
    riskPerTrade: wyDefaults.riskPerTrade ?? 0.008,
    typeRiskWeights: wyDefaults.typeRiskWeights,
    riskSizingBasis: wyDefaults.riskSizingBasis,
    maxDailyLossPct: wyDefaults.maxDailyLossPct,
    maxTradesPerDay: wyDefaults.maxTradesPerDay,
    typeOverrides: wyDefaults.typeOverrides,
    wyckoff: {
      entryModel: cfg.entryModel,
      allowHtfSideways: wyDefaults.allowHtfSideways,
      sidewaysShortOnly: wyDefaults.sidewaysShortOnly,
      allowHtfSidewaysLong: wyDefaults.allowHtfSidewaysLong,
      requireHtfAlign: wyDefaults.requireHtfAlign !== false,
      volumeConfirmMult: wyDefaults.volumeConfirmMult,
      longVolumeConfirmMult: wyDefaults.longVolumeConfirmMult,
      shortVolumeConfirmMult: wyDefaults.shortVolumeConfirmMult,
      cooldownBars: wyDefaults.cooldownBars,
    },
  });
  config.entryModel = cfg.entryModel;
  config.afActiveRacers = ["WYCKOFF"];
  config.selectedComponents = ["WYCKOFF"];
  if (wyDefaults.typeOverrides) config.typeOverrides = wyDefaults.typeOverrides;
  if (wyDefaults.atrMinMult != null) config.atrMinMult = wyDefaults.atrMinMult;
  if (wyDefaults.allowHtfSideways != null) config.allowHtfSideways = wyDefaults.allowHtfSideways;
  if (wyDefaults.sidewaysShortOnly != null) config.sidewaysShortOnly = wyDefaults.sidewaysShortOnly;
  if (wyDefaults.allowHtfSidewaysLong != null) config.allowHtfSidewaysLong = wyDefaults.allowHtfSidewaysLong;
  if (wyDefaults.riskPerTrade != null) config.riskPerTrade = wyDefaults.riskPerTrade;
  if (wyDefaults.typeRiskWeights) config.typeRiskWeights = wyDefaults.typeRiskWeights;
  if (wyDefaults.riskSizingBasis != null) config.riskSizingBasis = wyDefaults.riskSizingBasis;
  if (wyDefaults.maxDailyLossPct != null) config.maxDailyLossPct = wyDefaults.maxDailyLossPct;
  if (wyDefaults.maxTradesPerDay != null) config.maxTradesPerDay = wyDefaults.maxTradesPerDay;
  if (wyDefaults.longVolumeConfirmMult != null) config.longVolumeConfirmMult = wyDefaults.longVolumeConfirmMult;
  if (wyDefaults.shortVolumeConfirmMult != null) config.shortVolumeConfirmMult = wyDefaults.shortVolumeConfirmMult;

  // Website runBacktestJob stamps PairClassifier SL× via live exchange metrics.
  // Offline --klines file must NOT hit exchange/DB (avoids ECONNREFUSED noise).
  let pairTierMeta = null;
  if (cfg.source === "real" && cfg.webParity && cfg.klines !== "file") {
    try {
      config = await ensurePairTierOnParameters(config, {
        symbol: cfg.symbol,
        strategyKey: "WYCKOFF",
        exchangeType: candleExchange || cfg.exchange,
      });
      pairTierMeta = {
        pairSlMultiplier: config.pairSlMultiplier ?? null,
        pairTier: config.pairTier ?? null,
      };
      if (pairTierMeta.pairSlMultiplier != null) {
        console.log(
          `[wyckoff-report] pair tier applied  SL×${Number(pairTierMeta.pairSlMultiplier).toFixed(3)}`
          + (pairTierMeta.pairTier ? ` (${pairTierMeta.pairTier})` : ""),
        );
      }
    } catch (err) {
      console.warn(`[wyckoff-report] pair tier skipped: ${err.message}`);
    }
  }

  const result = await runTripleTypeBacktest({
    strategyKey: "WYCKOFF",
    capital: cfg.capital,
    enableFees: cfg.enableFees,
    enableSlippage: false,
    typeOrder,
    entryCandles,
    htfCandles,
    dailyCandles,
    config,
    symbol: cfg.symbol,
    dataSource: cfg.source,
    exchangeType: candleExchange || cfg.exchange,
  });

  const loadMeta = {
    source: cfg.klines === "file"
      ? `file(${cfg.cacheDir})`
      : cfg.klines === "vision"
        ? "binance.vision(spot)"
        : `${candleExchange || cfg.exchange}(futures/swap)`,
    klines: cfg.klines,
    webParity: !!cfg.webParity,
    periodId: cfg.periodId,
    pairTier: pairTierMeta,
    bars: {
      entry: Object.values(barsMeta.entry).reduce((a, b) => a + b, 0),
      htf: Object.values(barsMeta.htf).reduce((a, b) => a + b, 0),
      daily: barsMeta.daily || 0,
      perType: barsMeta,
    },
  };

  return { result, loadMeta };
}

// ── Tests ────────────────────────────────────────────────────────────────────

// ── Tests (skipped when loaded as a library by the CLI script) ───────────────

if (!process.env.WYCKOFF_BT_CLI) {
describe("Wyckoff customizable backtest report", () => {
  test(`runs ${CFG.months}m ${CFG.source} backtest and prints PnL / win rate`, async (t) => {
    // Node 24 `node --test` does not forward CLI args after `--` into
    // process.argv — custom runs must use scripts/wyckoff-backtest-report.js
    // (or WYCKOFF_BT_* env). Warn when this harness is stuck on defaults.
    if (typeof process.env.NODE_TEST_CONTEXT === "string" || process.execArgv.includes("--test")) {
      const argvHasTypes = process.argv.includes("--types");
      if (!argvHasTypes && !process.env.WYCKOFF_BT_TYPES) {
        console.warn(
          "[wyckoff-report] note: under `node --test`, --flags are ignored on Node 24."
          + " Use: node scripts/wyckoff-backtest-report.js --types Scalping,Intraday,Swing ...",
        );
      }
    }

    console.log(
      `\n[wyckoff-report] starting  source=${CFG.source}  months=${CFG.months}`
      + `  symbol=${CFG.symbol}  types=${CFG.types.join(",")}  model=${CFG.entryModel}`,
    );

    let packed;
    try {
      packed = await runWyckoffCustomBacktest(CFG);
    } catch (err) {
      if (CFG.source === "real") {
        console.error(`\n[wyckoff-report] REAL fetch/backtest failed: ${err.message}`);
        console.error("  Tip: check network, or fall back to mock:");
        console.error("       npm run test:wyckoff:report");
        if (typeof t.skip === "function") {
          t.skip(`real data unavailable: ${err.message}`);
          return;
        }
        console.warn(`[wyckoff-report] skipping hard fail (real unavailable)`);
        return;
      }
      throw err;
    }

    const { result, loadMeta } = packed;
    const report = printReport(CFG, result, loadMeta);
    const saved = savePositionReports(CFG, result, loadMeta, report);

    console.log(`[wyckoff-report] saved single report (${saved.tradeCount} positions)`);
    console.log(`[wyckoff-report] file: ${saved.outFile}`);

    // Hard contracts: engine shape + numeric stats fields present
    assert.ok(result && typeof result === "object");
    assert.ok(Array.isArray(result.trades));
    assert.ok(result.stats && typeof result.stats === "object");
    assert.equal(typeof result.stats.totalTrades, "number");
    assert.ok(result.stats.winRate != null, "winRate missing");
    assert.ok(result.stats.totalReturn != null, "totalReturn missing");
    assert.ok(result.stats.profitFactor != null, "profitFactor missing");
    assert.ok(result.stats.maxDrawdown != null, "maxDrawdown missing");
    assert.ok(Number.isFinite(report.extra.totalPnl), "totalPnl not finite");

    // Single combined report file must exist
    assert.ok(fs.existsSync(saved.outFile), `report missing: ${saved.outFile}`);
    const reportBody = fs.readFileSync(saved.outFile, "utf8");
    assert.ok(reportBody.includes("SUMMARY"), "report missing SUMMARY section");
    assert.ok(reportBody.includes("POSITION INDEX"), "report missing POSITION INDEX");
    assert.ok(reportBody.includes("POSITION DETAILS"), "report missing POSITION DETAILS");
    assert.ok(reportBody.includes("END OF REPORT"), "report missing END OF REPORT");

    console.log(
      `[wyckoff-report] summary  trades=${result.stats.totalTrades}`
      + `  WR=${result.stats.winRate}%`
      + `  PnL=${money(report.extra.totalPnl)}`
      + `  return=${result.stats.totalReturn}%`
      + `  PF=${result.stats.profitFactor}`
      + `  MDD=${result.stats.maxDrawdown}%`,
    );
  });
});
}

// Export helpers for optional programmatic use / future scripts
module.exports = {
  parseCfg,
  loadCandles,
  runWyckoffCustomBacktest,
  printReport,
  computeExtraStats,
  savePositionReports,
  formatPositionBlock,
  genMock,
};
