# ML / RAG Deploy Playbook

How to deploy WinPredictor and trade embeddings to the VPS after walkforward export or retrain. For gate concepts and architecture, see [`RAG.md`](./RAG.md).

**Last updated:** 2026-07-28

---

## TL;DR — most common commands

Run these from the **laptop** at the repo root (`be-bot-trading/`).

| Goal | Command |
|------|---------|
| Deploy to **staging** VPS | `npm run ml:deploy:staging` |
| Deploy to **dev** VPS | `npm run ml:deploy:dev` |
| Refresh model locally, then deploy | `npm run ml:refresh` → commit model → `npm run ml:deploy:staging` |
| Check embedding counts (no DB write) | `npm run ml:seed:dry-run` |
| Verify RAG gate on VPS | `npm run ml:diag -- --strategy TREND_SURGE --symbol BTCUSDT` |

**One deploy does:** rsync `tmp/*-walkforward` → VPS → `git pull` → `prisma migrate deploy` → seed 12 strategies → PM2 reload.

---

## How it works (30 seconds)

RAG needs **two separate artifacts**:

| Artifact | Where it lives | In git? |
|----------|----------------|---------|
| WinPredictor model | `data/models/win-predictor.json` | Yes |
| Trade embeddings (retrieval) | Postgres `TradeEmbedding` + pgvector | No — seeded on VPS |

Walkforward CSVs live in **`tmp/` on your laptop** (never committed). Seeding must run on the VPS — your laptop's `DATABASE_URL` points at localhost, which has no Postgres/pgvector.

```
Laptop                          VPS
──────                          ───
walkforward → tmp/     rsync →  tmp/
train → win-predictor  git  →  win-predictor.json
                               seed → TradeEmbedding
                               pm2 reload
```

---

## Prerequisites

### Laptop

- SSH access to VPS (`VPS_HOST=root@187.77.135.156` is the default in scripts)
- Walkforward exports in `tmp/<prefix>-{scalping|intraday|swing}-walkforward/`
- Node 18+ and `npm ci` already run once in this repo

### VPS (staging / dev)

| Env | Checkout path | Git branch | PM2 app | Port |
|-----|---------------|------------|---------|------|
| **staging** | `/opt/quantara-staging/be` | `staging` | `be-quantara-staging` | 3001 |
| **dev** | `/opt/quantara-dev/be` | `development` | `be-quantara-dev` | 3002 |
| prod | `/opt/quantara-prod/be` | `main` | `be-quantara-prod` | 3000 |

Also required on VPS:

- `.env` with **VPS** `DATABASE_URL` (not localhost from your laptop)
- pgvector extension (via `prisma migrate deploy`)
- `TradeEmbedding` table exists

---

## Local refresh (before deploy)

Use this when strategy logic changed or you need a new WinPredictor model.

### 1. Export walkforward CSVs

Run exports from `scripts/walkforward/` — one per strategy × trade type. Example:

```bash
node scripts/walkforward/smart-money-concepts/intraday.js
```

Repeat for each strategy you need, or export all 12. Output goes to `tmp/<prefix>-{scalping|intraday|swing}-walkforward/`.

### 2. Train model (optional)

```bash
npm run ml:refresh          # dry-run count + train + prints next steps
# or just train:
npm run ml:train
```

### 3. Commit model to git

```bash
git add data/models/win-predictor.json data/ml-engine-dataset.json
git commit -m "chore(ml): refresh win-predictor"
git push origin staging     # merge to development after staging verify
```

Embeddings are **not** in git — the VPS deploy step seeds those.

### When to retrain vs just redeploy

| Situation | Local | VPS |
|-----------|-------|-----|
| HTF / strategy logic changed | Re-export walkforward, retrain | `npm run ml:deploy:staging` |
| Walkforward CSV refresh only | Re-export `tmp/` | `npm run ml:deploy:staging` |
| Model already in git, CSVs unchanged | — | deploy (default skips train) |
| Schema migration only | — | deploy runs `migrate deploy` + seed |

---

## VPS deploy

### From laptop (recommended)

```bash
npm run ml:deploy:staging    # most common
npm run ml:deploy:dev
```

Equivalent manual form:

```bash
./scripts/ml/deploy-rag-vps.sh --env staging --from-walkforward --all-live --skip-train
```

### Already SSH'd into the VPS?

The script auto-detects when `pwd` is `/opt/quantara-{staging|dev}/be` — it skips rsync/SSH and runs migrate + seed + PM2 locally.

```bash
cd /opt/quantara-staging/be
npm run ml:deploy:staging
```

If `tmp/` on the VPS is empty, the script prints exact `rsync` commands to run from your laptop. **Do not** seed from the VPS until CSVs are there.

### Seed a subset (tier or single strategy)

Deploy defaults to all 12 LIVE strategies (`--all-live`). For narrower seeding:

```bash
# On VPS (or via deploy script flags):
npm run ml:seed:af          # SMC + Wyckoff + VSA
npm run ml:seed:ts          # Trend Following + Market Structure + AMT
npm run ml:seed:md          # Mean Reversion + Supply/Demand + Stat Arb
npm run ml:seed:bs          # Breakout Retest + ICT + Liquidation Squeeze
```

Preset source of truth: `scripts/ml/walkforward-dir-presets.js`

### 12 strategies → tmp/ folders

Each strategy has 3 trade types: `{prefix}-{scalping|intraday|swing}-walkforward`.

| # | Strategy | Tier | tmp prefix |
|---|----------|------|------------|
| 1 | SMART_MONEY_CONCEPTS | AF | `smc` |
| 2 | WYCKOFF | AF | `wyckoff` |
| 3 | VOLUME_SPREAD_ANALYSIS | AF | `vsa` |
| 4 | TREND_FOLLOWING | TS | `tf` |
| 5 | MARKET_STRUCTURE | TS | `ms` |
| 6 | AUCTION_MARKET_THEORY | TS | `amt` |
| 7 | MEAN_REVERSION | MD | `mr` |
| 8 | SUPPLY_AND_DEMAND | MD | `snd` |
| 9 | STATISTICAL_ARBITRAGE | MD | `sa` |
| 10 | BREAKOUT_RETEST | BS | `br` |
| 11 | ICT_STYLE_TRADING | BS | `ict` |
| 12 | LIQUIDATION_SQUEEZE | BS | `ls` |

Example path: `tmp/tf-intraday-walkforward/window-01/BTCUSDT/trades.csv`

### Manual fallback (if one-command fails)

**A. Rsync from laptop**

```bash
rsync -avz tmp/smc-intraday-walkforward/ \
  root@187.77.135.156:/opt/quantara-staging/be/tmp/smc-intraday-walkforward/
```

**B. On VPS**

```bash
ssh root@187.77.135.156
cd /opt/quantara-staging/be
git fetch origin staging && git reset --hard origin/staging
npm ci
npx prisma migrate deploy
npm run ml:seed
pm2 startOrReload ecosystem.config.js --only be-quantara-staging --update-env
```

---

## Verify

```bash
# Health (on VPS)
curl -sf http://127.0.0.1:3001/health          # staging = 3001, dev = 3002

# DB + pgvector
npm run ml:verify-db

# Embedding counts by strategy
npm run ml:embeddings

# RAG gate preflight (on VPS)
npm run ml:diag -- --strategy TREND_SURGE --symbol BTCUSDT

# API (needs JWT)
curl -H "Authorization: Bearer <token>" \
  https://staging.quantara.software/api/v1/backtest/rag-gate-status
```

---

## AF vs TS — what "backfill" actually means

People say "backfill" for several different scripts. Only some of them fill **`TradeEmbedding`** (what RAG retrieval needs).

| Script / command | Writes to | For RAG embeddings? |
|------------------|-----------|------------------------|
| `npm run ml:seed:af` / `ml:seed:ts` / `ml:seed` | `TradeEmbedding` | **Yes** — main path |
| `npm run ml:bootstrap:engine` | `TradeEmbedding` + dataset | Yes — from ~510 closed bot trades |
| `npm run ml:backfill:shadow` | `MLShadowLog` | No — shadow/AUC promotion metrics |
| `npm run ml:bootstrap:walkforward` | `ml-engine-dataset.json` (local) | No — offline WinPredictor training |
| `scripts/backfill-ml-readiness.js` | `Trade` columns | No — pair_tier, etc. |
| `scripts/backfill-regime.js` | `entryContext.market.regime` | No — historical regime labels |

**Bottom line:** RAG gate reads **`TradeEmbedding`** in pgvector. AF fills this from walkforward CSV (`ml:seed:af`) and optionally engine trades. TS uses the same walkforward path (`ml:seed:ts`) — no separate backfill needed for embeddings.

### TS workflow (VPS)

```bash
npm run ml:seed:ts
npm run ml:embeddings
npm run ml:diag -- --strategy TREND_SURGE --symbol BTCUSDT

# Optional — supplement from live bot trades
npm run ml:bootstrap:engine
npm run ml:backfill:shadow -- --days=30
```

### AF workflow (VPS)

```bash
npm run ml:seed:af          # SMC + Wyckoff + VSA only
npm run ml:seed             # all 12 strategies
```

---

## npm scripts reference

| Script | What it does |
|--------|--------------|
| `ml:deploy:staging` | Full staging deploy (rsync + migrate + seed all + PM2) |
| `ml:deploy:dev` | Same for dev VPS |
| `ml:seed` | Seed all 12 LIVE strategies |
| `ml:seed:af` / `ml:seed:ts` / `ml:seed:md` / `ml:seed:bs` | Seed one umbrella tier |
| `ml:seed:dry-run` | Count embeddings without writing DB |
| `ml:refresh` | Local: dry-run count + train + deploy instructions |
| `ml:train` | Train WinPredictor → `data/models/win-predictor.json` |
| `ml:bootstrap:engine` | Closed engine trades → dataset + TradeEmbedding (VPS) |
| `ml:bootstrap:walkforward` | CSV walkforward → `ml-engine-dataset.json` (local) |
| `ml:backfill:shadow` | Engine trades → `MLShadowLog` (not embeddings) |
| `ml:diag` | RAG preflight (`--strategy`, `--symbol`) |
| `ml:verify-db` | pgvector + TradeEmbedding table check |
| `ml:embeddings` | Print embedding counts by strategyKey |

---

## Git vs local vs VPS

| Path | Git? | Notes |
|------|------|-------|
| `data/models/win-predictor.json` | Yes | Pulled on VPS via `git pull` |
| `data/ml-engine-dataset.json` | Yes | Training cache |
| `tmp/*-walkforward/` | No | Rsync to VPS only |
| `.env` | No | Secrets + per-env `DATABASE_URL` |
| Postgres `TradeEmbedding` | No | Lives only on VPS DB |

Do not commit `tmp/` or `.env`.

---

## Environments

| | staging | development | production |
|---|---------|-------------|------------|
| Branch | `staging` | `development` | `main` |
| Deploy command | `ml:deploy:staging` | `ml:deploy:dev` | Manual / change window |
| Typical `ML_GATE_MODE` | `shadow` | `shadow` / off | `active` after promotion |
| RAG backtest UI | ON | ON | Per policy |

**Branch flow:** push ML changes to `staging` → deploy & verify → merge to `development` for dev VPS. Production (`main`) is separate.

---

## Troubleshooting

### pgvector extension missing

- **Symptom:** migrate or seed fails on vector type
- **Cause:** migration not applied
- **Fix:**
  ```bash
  cd /opt/quantara-staging/be
  npx prisma migrate deploy
  psql "$DATABASE_URL" -c "SELECT * FROM pg_extension WHERE extname='vector';"
  ```

### `ECONNREFUSED` / Cannot connect to Postgres at localhost

- **Symptom:** seed fails immediately on laptop
- **Cause:** seed ran locally; laptop has no VPS Postgres
- **Fix:** run `npm run ml:deploy:staging` from laptop (seeds via SSH), or SSH to VPS and run `npm run ml:seed`

### TradeEmbedding table missing

- **Symptom:** seed or verify fails on table not found
- **Cause:** VPS branch missing migration
- **Fix:** `git pull` + `npx prisma migrate deploy`

### No local `tmp/*-walkforward` dirs found

- **Symptom:** deploy exits before rsync
- **Cause:** walkforward not exported locally, or deploy started on VPS without CSVs
- **Fix:** export walkforward on laptop, then `npm run ml:deploy:staging`. Or rsync manually first.

### No `trades.csv` under tmp/

- **Symptom:** seed reports 0 trades
- **Cause:** incomplete export or failed rsync
- **Fix:**
  ```bash
  npm run ml:seed:dry-run
  ls tmp/*-walkforward/**/trades.csv | head
  head -3 tmp/tf-scalping-walkforward/window-01/BTCUSDT/trades.csv
  ```

### Need >= N embeddings, got 0

- **Symptom:** seed rejects with minimum count error
- **Cause:** empty CSV or `Result` column not `win`/`loss`
- **Fix:** inspect CSV headers and rows (see command above)

### Bot logs: "no ML signal" / gate cold-start

- **Symptom:** trades not gated despite RAG enabled
- **Cause:** low embedding count, missing model, or shadow mode
- **Fix:**
  - Re-seed with correct tier preset (`ml:seed:af`, `ml:seed:ts`, etc.)
  - Confirm `data/models/win-predictor.json` exists after `git pull`
  - Check `ML_GATE_MODE=shadow` — logs only, does not reject trades

### rsync / SSH fails

- **Symptom:** permission denied or host unreachable
- **Cause:** wrong `VPS_HOST` or missing SSH key
- **Fix:**
  ```bash
  ssh root@187.77.135.156 'ls /opt/quantara-staging/be/tmp'
  ```

### PM2 reload but health check fails

- **Symptom:** deploy completes but `/health` fails
- **Cause:** app crash on startup
- **Fix:**
  ```bash
  pm2 logs be-quantara-staging --lines 50
  node --check index.js
  ```

---

## Script files

| File | Role |
|------|------|
| `scripts/ml/deploy-rag-vps.sh` | Main one-command deploy |
| `scripts/ml/seed-embeddings-from-walkforward.js` | CSV → TradeEmbedding |
| `scripts/ml/walkforward-dir-presets.js` | 12-strategy dir lists (SSOT) |
| `scripts/ml/full-rag-refresh.sh` | Local train workflow (`ml:refresh`) |
| `scripts/ml/train-win-predictor.js` | Train → win-predictor.json |
| `scripts/ml/diag-rag-gate.js` | RAG preflight diagnostics |

---

## Related docs

- [`RAG.md`](./RAG.md) — gate concepts, FeatureEngineer, shadow mode
- [`scripts/walkforward/README.md`](../scripts/walkforward/README.md) — CSV export
- `ARCHITECTURE.md` — deployment branches & PM2

---

*If strategy presets change, update `walkforward-dir-presets.js` first, then this doc.*
