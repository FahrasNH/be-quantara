# Walk-forward Export

Batch walk-forward backtest exports — **1:1 with UI Advance / dataset-expand** via BE API (`--via-api` default).

Organized like `scripts/dataset-expand/`: strategy slug folders × trade type entry scripts + shared `lib/`.

## Prerequisites

Same as dataset-expand — in `be-bot-trading/.env`:

```env
# Target BE (switch this to choose environment)
DATASET_EXPAND_API_URL=https://dev.quantara.software
# DATASET_EXPAND_API_URL=https://staging.quantara.software

DATASET_EXPAND_EMAIL=you@example.com
DATASET_EXPAND_PASSWORD=••••••••
```

Akun harus bisa login di dashboard environment tersebut (dev / staging). Token opsional: `DATASET_EXPAND_TOKEN`.

## Dev vs Staging (cara jalan)

Walk-forward **tidak** jalan di laptop engine — default `--via-api` memanggil `POST /api/v1/backtest/run-real` di BE yang kamu set. Jadi:

| Target | `DATASET_EXPAND_API_URL` | Syarat |
|--------|--------------------------|--------|
| **Dev** | `https://dev.quantara.software` | Branch/fix sudah deploy ke VPS **dev** |
| **Staging** | `https://staging.quantara.software` | Branch/fix sudah merge + deploy ke VPS **staging** |

### Alur praktis

1. **Pastikan kode engine sudah di target**  
   Commit walk-forward script saja tidak mengubah angka backtest. Angka mengikuti **engine di server**.  
   Contoh: fix SMC Swing harus sudah ada di `development` → deploy **dev**, lalu merge ke `staging` → deploy **staging**, baru WF staging mirror hasilnya.

2. **Set target di `.env`** (atau one-shot di shell):

```bash
# Dev (default kamu sekarang)
export DATASET_EXPAND_API_URL=https://dev.quantara.software

# Staging — ganti URL saja; email/password akun staging
export DATASET_EXPAND_API_URL=https://staging.quantara.software
```

3. **Smoke dulu, baru full grid**

```bash
# Manifest only (tanpa hit API)
node scripts/walkforward/smart-money-concepts/swing.js --dry-run

# Satu cell — cek auth + engine
node scripts/walkforward/smart-money-concepts/swing.js --window 5 --symbol BTCUSDT

# Full 5×5 (lama — puluhan job)
node scripts/walkforward/smart-money-concepts/swing.js

# Setelah selesai / mid-run: baca ulang NET% dari tmp/
node scripts/walkforward/smart-money-concepts/swing.js --summary-only
```

4. **Pisahkan output per environment** (opsional, biar tidak campur)  
   Default path sama (`tmp/smc-*-walkforward/`). Kalau bandingkan dev vs staging, rename folder setelah run:

```bash
mv tmp/smc-swing-walkforward tmp/smc-swing-walkforward-dev
# … ganti DATASET_EXPAND_API_URL ke staging, run lagi …
mv tmp/smc-swing-walkforward tmp/smc-swing-walkforward-staging
```

5. **Yang walk-forward *tidak* lakukan**  
   Lulus gate di script ≠ otomatis live di staging. Promotion tetap lewat code (`liveTradeTypeGate.js` / deploy), setelah verdict `PASS`.

> Laptop Postgres (`localhost:5433`) **tidak** dibutuhkan untuk `--via-api`. DB candle/engine ada di server target.

## Usage

From `be-bot-trading/`:

```bash
# SMC Intraday promotion gate — 5 windows × 5 coins
node scripts/walkforward/smart-money-concepts/intraday.js --dry-run
node scripts/walkforward/smart-money-concepts/intraday.js
node scripts/walkforward/smart-money-concepts/intraday.js --summary-only

# SMC Swing promotion gate — 5 windows × 5 coins
node scripts/walkforward/smart-money-concepts/swing.js --dry-run
node scripts/walkforward/smart-money-concepts/swing.js
node scripts/walkforward/smart-money-concepts/swing.js --summary-only

# SMC Scalping ML export — 8 windows BTC
node scripts/walkforward/smart-money-concepts/scalping.js --dry-run

# SMC Scalping + Research #1/#3
node scripts/walkforward/smart-money-concepts/scalping-research.js --analyze-only

# SA Swing Gelombang 1+2
node scripts/walkforward/statistical-arbitrage/swing.js --window 3 --symbol ETHUSDT

# VSA Intraday Sprint 23 GO/NO-GO — 3 windows BTC (2023 / 2024-25 / 2025-26)
node scripts/walkforward/volume-spread-analysis/intraday.js --dry-run
node scripts/walkforward/volume-spread-analysis/intraday.js --window 2 --symbol BTCUSDT
node scripts/walkforward/volume-spread-analysis/intraday.js --summary-only
```

## Common flags

| Flag | Keterangan |
|------|------------|
| `--dry-run` | Write manifests only, no backtest |
| `--local` | Direct fetch on laptop (needs exchange network) |
| `--via-api` | Default for real runs — engine on `DATASET_EXPAND_API_URL` (dev or staging) |
| `--window N` | Single window id |
| `--symbol SYM` | Single symbol (multi-coin grids) |
| `--summary-only` | Re-print NET% table from existing stats.json (SMC Intraday) |
| `--export-only` / `--analyze-only` | Scalping research export / analysis phases |

## Window sets (`lib/windows.js`)

| Set | Windows | Used by |
|-----|---------|---------|
| `GAP_POLICY_5` | 5 (2020–2024, bear gap excluded) | SMC Intraday, SMC Swing, SA Swing |
| `GAP_POLICY_8` | 8 (2020–2026) | SMC Scalping, Scalping research |
| `GAP_POLICY_8_WITH_FORMAT` | 8 + xlsx on W8 | SMC Scalping export |
| `VSA_INTRADAY_3` | 3 (2023 / 2024-25 / 2025-26) | VSA Intraday GO/NO-GO |

Gap **2021-12 → 2022-10** intentionally excluded in all sets.

## Output layout

Legacy output paths preserved for existing `tmp/` artifacts:

| Script | Output root |
|--------|-------------|
| SMC Scalping | `tmp/smc-scalping-walkforward/window-XX/` |
| SMC Scalping research | `tmp/sprint19-smc-walkforward/window-XX/` |
| SA Swing | `tmp/sprint20-sa-swing-walkforward/window-XX/SYMBOL/` |
| SMC Intraday | `tmp/smc-intraday-walkforward/window-XX/SYMBOL/` |
| SMC Swing | `tmp/smc-swing-walkforward/window-XX/SYMBOL/` |
| VSA Intraday | `tmp/vsa-intraday-walkforward/window-XX/SYMBOL/` |

New exports may also use `tmp/walkforward/<slug>/<type>/` via `lib/paths.defaultOutRoot()`.

Per cell: `manifest.json` · `trades.csv` · `stats.json` (+ `walkforward-summary.json` for promotion gates).

## Structure

```
scripts/walkforward/
├── README.md
├── lib/
│   ├── paths.js              # REPO_ROOT, windowDir, defaultOutRoot
│   ├── windows.js            # GAP_POLICY_5 / _8 window SSOT
│   ├── symbols.js            # DEFAULT_SYMBOLS_5
│   ├── parseArgs.js          # --dry-run, --window, --symbol, …
│   ├── summary.js            # NET% table, verdict / promotion gate
│   ├── auth.js               # Single login for via-api grids
│   ├── runGridExport.js      # window×symbol via runDatasetExpand
│   ├── runSpawnExport.js     # window via spawn dataset-expand script
│   ├── researchAnalysis.js   # R#1/R#3 CSV analysis
│   ├── strategyRegistry.js   # re-export from dataset-expand
│   └── stubExport.js         # placeholder exit for unimplemented combos
└── <strategy-slug>/
    ├── scalping.js
    ├── intraday.js
    ├── swing.js
    └── … (e.g. scalping-research.js, transition-research.py)
```

## Implemented vs gaps

| Strategy | Scalping | Intraday | Swing |
|----------|----------|----------|-------|
| Smart Money Concepts | ✅ Scalping (+ research) | ✅ Intraday | ✅ Swing |
| Statistical Arbitrage | stub | stub | ✅ Swing (+ transition-research.py) |
| Volume Spread Analysis | stub | ✅ Intraday (3-window GO/NO-GO) | stub |
| Wyckoff | stub | stub | stub |
| Trend Following | stub | stub | stub |
| Market Structure | stub | stub | stub |
| Auction Market Theory | stub | stub | stub |
| Mean Reversion | stub | stub | stub |
| Supply and Demand | stub | stub | stub |
| Breakout Retest | stub | stub | stub |
| ICT Style Trading | stub | stub | stub |
| Liquidation Squeeze | stub | stub | stub |

## Adding a new walk-forward script

1. Copy `smart-money-concepts/intraday.js` (multi-coin grid + summary) or `scalping.js` (spawn / single-symbol).
2. Set `strategyKey`, `tradeType`, `OUT_ROOT`, `buildManifest`, and window set from `lib/windows.js`.
3. Replace the matching stub under `<slug>/<type>.js`.

Shared runners:

- **`runGridExport`** — direct `runDatasetExpand` + single JWT (multi-coin grid pattern).
- **`runSpawnExport`** — spawn `dataset-expand/<slug>/<type>.js` per window (spawn pattern).

Promotion gate helpers in **`summary.js`**: `collectSummary`, `printSummaryTable`, `buildVerdict`.

## Related

- `scripts/dataset-expand/` — single-window backtest / ablation (feeds walk-forward cells)
- `scripts/ml/bootstrap-from-walkforward-csv.js` — ML bootstrap from `tmp/sprint19-smc-walkforward`
- `docs/SMC_SCALPING_WALKFORWARD_EXPORT.md` — Full ML column export for Scalping windows
