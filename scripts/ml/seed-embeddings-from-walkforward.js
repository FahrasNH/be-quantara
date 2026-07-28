#!/usr/bin/env node
"use strict";

/**
 * seed-embeddings-from-walkforward.js — Upsert TradeEmbedding from walkforward CSV exports.
 *
 * Use when staging has no closed engine trades but walkforward artifacts exist locally
 * (or were rsync'd to the VPS).
 *
 * Usage:
 *   node scripts/ml/seed-embeddings-from-walkforward.js --tf-all
 *   node scripts/ml/seed-embeddings-from-walkforward.js --af-all   # SMC + Wyckoff + VSA
 *   node scripts/ml/seed-embeddings-from-walkforward.js --ts-all   # TF + MS + AMT
 *   node scripts/ml/seed-embeddings-from-walkforward.js --dir=tmp/tf-scalping-walkforward
 *   node scripts/ml/seed-embeddings-from-walkforward.js \
 *     --dir=tmp/tf-scalping-walkforward --dir=tmp/tf-intraday-walkforward \
 *     --strategy=TREND_FOLLOWING --min=50
 *   node scripts/ml/seed-embeddings-from-walkforward.js --tf-all --dry-run
 *
 * npm: ml:seed-embeddings-walkforward
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const FeatureEngineer = require("#modules/ml/domain/FeatureEngineer.js");
const VectorStore = require("../../src/infrastructure/db/VectorStore");
const { _pool } = require("../../src/infrastructure/db/database");
const { REPO_ROOT } = require("#modules/ml/constants/modelPaths.js");

const TF_ALL_DIRS = [
  "tmp/tf-scalping-walkforward",
  "tmp/tf-intraday-walkforward",
  "tmp/tf-swing-walkforward",
];

const SMC_ALL_DIRS = [
  "tmp/smc-scalping-walkforward",
  "tmp/smc-intraday-walkforward",
  "tmp/smc-swing-walkforward",
];

const AF_ALL_DIRS = [
  ...SMC_ALL_DIRS,
  "tmp/wyckoff-scalping-walkforward",
  "tmp/wyckoff-intraday-walkforward",
  "tmp/wyckoff-swing-walkforward",
  "tmp/vsa-scalping-walkforward",
  "tmp/vsa-intraday-walkforward",
  "tmp/vsa-swing-walkforward",
];

const TS_ALL_DIRS = [
  ...TF_ALL_DIRS,
  "tmp/ms-scalping-walkforward",
  "tmp/ms-intraday-walkforward",
  "tmp/ms-swing-walkforward",
  "tmp/amt-scalping-walkforward",
  "tmp/amt-intraday-walkforward",
  "tmp/amt-swing-walkforward",
];

function dbHostHint() {
  const dbUrl = process.env.DATABASE_URL || "";
  try {
    const u = new URL(dbUrl.replace(/^postgres(ql)?:\/\//, "http://"));
    return `${u.hostname}:${u.port || 5432}`;
  } catch {
    return dbUrl ? "(from DATABASE_URL)" : "(DATABASE_URL unset)";
  }
}

function isLocalDbUrl() {
  const dbUrl = process.env.DATABASE_URL || "";
  return /localhost|127\.0\.0\.1|::1/i.test(dbUrl);
}

/**
 * Fail fast before parsing CSVs — seed must run against staging Postgres on VPS.
 * @param {import('pg').Pool} pool
 */
async function preflightDatabase(pool) {
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    const msg = err?.message || String(err);
    console.error(`[seed-walkforward] Cannot connect to Postgres at ${dbHostHint()}: ${msg}`);
    if (isLocalDbUrl()) {
      console.error("[seed-walkforward] DATABASE_URL points to localhost — no local Postgres is expected.");
      console.error("[seed-walkforward] Run on VPS (recommended):");
      console.error("[seed-walkforward]   cd /opt/quantara-staging/be");
      console.error("[seed-walkforward]   npm run ml:seed-embeddings-walkforward -- --tf-all");
      console.error("[seed-walkforward] Or one-command from laptop:");
      console.error("[seed-walkforward]   RSYNC=1 ./scripts/ml/deploy-rag-staging-remote.sh --from-walkforward --tf-all --skip-train");
      console.error("[seed-walkforward] Or SSH tunnel: ssh -L 5433:127.0.0.1:5432 root@srv1722932 then point DATABASE_URL at localhost:5433");
    }
    process.exit(1);
  }

  let extRows;
  try {
    ({ rows: extRows } = await pool.query(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1"
    ));
  } catch (err) {
    console.error(`[seed-walkforward] pgvector check failed: ${err?.message || err}`);
    process.exit(1);
  }

  if (!extRows?.length) {
    console.error("[seed-walkforward] pgvector extension missing on this database.");
    console.error("[seed-walkforward] On VPS: npx prisma migrate deploy");
    console.error("[seed-walkforward] Verify:  SELECT * FROM pg_extension WHERE extname='vector';");
    process.exit(1);
  }

  const { rows: tblRows } = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'TradeEmbedding' LIMIT 1"
  );
  if (!tblRows?.length) {
    console.error("[seed-walkforward] TradeEmbedding table missing — run: npx prisma migrate deploy");
    process.exit(1);
  }

  console.log(`[seed-walkforward] DB OK (${dbHostHint()}, pgvector ${extRows[0].extversion})`);
}

function parseArgs() {
  const out = {
    dirs: [],
    min: 5,
    strategy: null,
    dryRun: false,
    preset: null,
    tradeIdPrefix: "wf",
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--tf-all") out.preset = "tf";
    else if (arg === "--smc-all") out.preset = "smc";
    else if (arg === "--af-all") out.preset = "af";
    else if (arg === "--ts-all") out.preset = "ts";
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--dir=")) out.dirs.push(path.resolve(REPO_ROOT, arg.slice(6)));
    else if (arg.startsWith("--min=")) out.min = parseInt(arg.slice(6), 10);
    else if (arg.startsWith("--strategy=")) out.strategy = arg.slice(11).toUpperCase();
    else if (arg.startsWith("--prefix=")) out.tradeIdPrefix = arg.slice(9);
  }

  if (out.preset === "tf") {
    out.dirs = TF_ALL_DIRS.map((d) => path.join(REPO_ROOT, d));
    out.strategy = out.strategy || "TREND_FOLLOWING";
  } else if (out.preset === "smc") {
    out.dirs = SMC_ALL_DIRS.map((d) => path.join(REPO_ROOT, d));
    out.strategy = out.strategy || "SMART_MONEY_CONCEPTS";
  } else if (out.preset === "af") {
    out.dirs = AF_ALL_DIRS.map((d) => path.join(REPO_ROOT, d));
    out.strategy = null; // multi-strategy umbrella
  } else if (out.preset === "ts") {
    out.dirs = TS_ALL_DIRS.map((d) => path.join(REPO_ROOT, d));
    out.strategy = null;
  } else if (out.dirs.length === 0) {
    out.dirs = [path.join(REPO_ROOT, "tmp/tf-scalping-walkforward")];
    out.strategy = out.strategy || "TREND_FOLLOWING";
  }
  return out;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function loadCsv(filePath) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((ln) => {
    const vals = parseCsvLine(ln);
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
    return row;
  });
}

function num(v, fallback = null) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function csvRowToEntryContext(row) {
  const strategyKey = row.Strategy || "TREND_FOLLOWING";
  const entryPrice = num(row["Entry Price"], 1);
  const side = String(row.Side || "LONG").toUpperCase();

  // SMC / Wyckoff exports with graded columns
  if (row["Graded Score"] != null && row["Graded Score"] !== "") {
    const graded = num(row["Graded Score"], 50);
    const htfAdx = num(row["HTF ADX"]);
    return {
      capturedAt:       row["Open Time"] || new Date().toISOString(),
      confidenceScore:  graded,
      entryConfidence:  graded,
      signalQuality:    graded,
      bosScore:         Math.min(100, num(row["Conf Sweep"], 0) * 25),
      chochScore:       Math.min(100, num(row["Conf Disp %"], 0) * 100),
      fvgScore:         Math.min(100, num(row["Conf FVG"], 0) * 100),
      liquidityScore:   Math.min(100, num(row["Sweep Strength"], 0) * 20),
      votingScore:      graded,
      atr:              num(row.ATR, 0),
      atrPct:           entryPrice > 0 ? +((num(row.ATR, 0) / entryPrice) * 100).toFixed(4) : 0,
      adx:              htfAdx,
      rsi:              50,
      bbWidth:          num(row["BB Width"], 0),
      volumeRatio:      num(row["Volume Ratio"], 1),
      fundingRate:      num(row["Funding Rate At Entry"]),
      strategyKey,
      tradeType:        row.Component || "Scalping",
      pairTier:         "LIQUID",
      leverage:         1,
      regime:           htfAdx != null && htfAdx > 25 ? "trend_up" : "ranging",
      htfRegime:        side === "LONG" ? "trending_up" : "trending_down",
      source:           "walkforward-csv",
    };
  }

  // Trend Following / generic exports (Entry Reasons, ATR, no graded columns)
  const reasons = String(row["Entry Reasons"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const reasonScore = Math.min(100, Math.max(40, reasons.length * 20));
  const hasAdx = reasons.some((r) => /adx/i.test(r));
  const hasHtf = reasons.some((r) => /htf/i.test(r));

  return {
    capturedAt:       row["Open Time"] || new Date().toISOString(),
    confidenceScore:  reasonScore,
    entryConfidence:  reasonScore,
    signalQuality:    reasonScore,
    votingScore:      reasonScore,
    atr:              num(row.ATR, 0),
    atrPct:           entryPrice > 0 ? +((num(row.ATR, 0) / entryPrice) * 100).toFixed(4) : 0,
    adx:              hasAdx ? 30 : null,
    rsi:              50,
    bbWidth:          0,
    volumeRatio:      1,
    strategyKey,
    tradeType:        row.Component || "Intraday",
    pairTier:         "LIQUID",
    leverage:         1,
    regime:           hasAdx || hasHtf ? "trend_up" : "ranging",
    htfRegime:        side === "LONG" ? "trending_up" : "trending_down",
    ema9:             entryPrice,
    ema21:            entryPrice,
    ema50:            entryPrice,
    source:           "walkforward-csv",
  };
}

function findTradeCsvFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name === "trades.csv") files.push(full);
    }
  };
  walk(rootDir);
  return files.sort();
}

function buildTradeId(prefix, row, csvPath) {
  const base = row.ID || `${row.Symbol}-${row["Open Time"]}-${row.Side}`;
  const rel = path.relative(REPO_ROOT, csvPath).replace(/[^\w.-]+/g, "_");
  return `${prefix}-${base}-${rel}`;
}

async function main() {
  const { dirs, min, strategy, dryRun, tradeIdPrefix } = parseArgs();

  if (!dryRun) {
    await preflightDatabase(_pool);
  } else {
    console.log("[seed-walkforward] DRY RUN — skipping DB preflight");
  }

  const csvFiles = [];
  const missing = [];

  for (const dir of dirs) {
    const found = findTradeCsvFiles(dir);
    if (found.length === 0) missing.push(dir);
    else csvFiles.push(...found);
  }
  csvFiles.sort();

  if (csvFiles.length === 0) {
    console.error(`[seed-walkforward] No trades.csv under: ${dirs.map((d) => path.relative(REPO_ROOT, d)).join(", ")}`);
    console.error("[seed-walkforward] Rsync local tmp/tf-* to VPS or run walkforward export first.");
    process.exit(1);
  }
  if (missing.length) {
    console.warn(`[seed-walkforward] No CSV in: ${missing.map((d) => path.relative(REPO_ROOT, d)).join(", ")}`);
  }

  const fe = new FeatureEngineer();
  const embeddings = [];
  const seen = new Set();
  let skipped = 0;
  let dupes = 0;

  for (const csvPath of csvFiles) {
    for (const row of loadCsv(csvPath)) {
      if (row.Result !== "win" && row.Result !== "loss") { skipped++; continue; }

      const rowStrategy = String(row.Strategy || "").toUpperCase();
      if (strategy && rowStrategy && rowStrategy !== strategy) { skipped++; continue; }

      const tradeId = buildTradeId(tradeIdPrefix, row, csvPath);
      if (seen.has(tradeId)) { dupes++; continue; }
      seen.add(tradeId);

      try {
        const entryContext = csvRowToEntryContext(row);
        const strategyKey = strategy || entryContext.strategyKey || "TREND_FOLLOWING";
        const symbol = row.Symbol || "BTCUSDT";
        const side = String(row.Side || "LONG").toUpperCase();
        const entryPrice = num(row["Entry Price"], 1);
        const pnlNet = num(row["PnL Net"], 0);
        const pnlPct = entryPrice > 0 ? +((pnlNet / entryPrice) * 100).toFixed(4) : pnlNet;
        const outcome = row.Result === "win" ? "win" : "loss";

        const features = fe.buildFeatureVector(entryContext, { strategyKey, symbol, side });
        embeddings.push({
          tradeId,
          vector: features,
          metadata: {
            strategyKey,
            symbol,
            side,
            regime: entryContext.regime,
            outcome,
            pnlPct,
            timestamp: row["Open Time"] || new Date().toISOString(),
            source: "walkforward-csv",
            component: row.Component || null,
            sourceFile: path.relative(REPO_ROOT, csvPath),
          },
        });
      } catch {
        skipped++;
      }
    }
  }

  const sourceDirs = dirs.map((d) => path.relative(REPO_ROOT, d));
  console.log(`[seed-walkforward] Dirs: ${sourceDirs.join(", ")}`);
  console.log(`[seed-walkforward] Strategy filter: ${strategy || "(any)"}`);
  console.log(`[seed-walkforward] CSV files: ${csvFiles.length}, embeddings: ${embeddings.length}, skipped: ${skipped}, dupes: ${dupes}`);

  if (embeddings.length < min) {
    console.error(`[seed-walkforward] Need >= ${min} embeddings, got ${embeddings.length}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log("[seed-walkforward] DRY RUN — no DB writes");
    const byStrategy = {};
    for (const e of embeddings) {
      const k = e.metadata.strategyKey;
      byStrategy[k] = (byStrategy[k] || 0) + 1;
    }
    console.log("[seed-walkforward] By strategy:", byStrategy);
    process.exit(0);
  }

  const vs = new VectorStore(_pool);

  const batchSize = 50;
  let upserted = 0;
  for (let i = 0; i < embeddings.length; i += batchSize) {
    const batch = embeddings.slice(i, i + batchSize);
    try {
      await vs.batchUpsert(batch);
      upserted += batch.length;
    } catch (err) {
      console.error(`[seed-walkforward] batchUpsert failed at offset ${i}: ${err?.message || err}`);
      process.exit(1);
    }
  }

  const totalCount = await vs.count();
  const strategyCount = strategy
    ? await vs.count({ strategyKey: strategy })
    : null;

  if (upserted !== embeddings.length) {
    console.error(`[seed-walkforward] Upsert incomplete — wrote ${upserted}/${embeddings.length}`);
    process.exit(1);
  }
  if (totalCount === 0) {
    console.error("[seed-walkforward] Upsert finished but TradeEmbedding count is still 0");
    process.exit(1);
  }

  console.log(`[seed-walkforward] Upserted ${upserted} TradeEmbedding rows`);
  if (strategyCount != null) {
    console.log(`[seed-walkforward] DB count — strategy ${strategy}: ${strategyCount}, total: ${totalCount}`);
  } else {
    console.log(`[seed-walkforward] DB count — total: ${totalCount} (multi-strategy preset, no filter)`);
  }
  console.log("[seed-walkforward] Done. Verify: curl http://127.0.0.1:3001/api/v1/backtest/rag-gate-status (needs JWT on public URL)");

  await _pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[seed-walkforward] Fatal:", err);
  try { await _pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
