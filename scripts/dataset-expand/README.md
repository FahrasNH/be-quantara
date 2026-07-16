# Dataset Expand

Batch backtest + ablation **1:1 dengan UI Advance** — candle fetch + engine jalan di **BE server** (bukan laptop).

## Mengapa lokal gagal?

Di laptop kamu biasanya:

| Layer | Status lokal | Status UI (server) |
|-------|--------------|--------------------|
| `api.binance.com` / Bitget | **timeout / blocked** | OK |
| Postgres `localhost:5433` | **ECONNREFUSED** | DB staging hidup |
| `--cache-only` | kosong (DB mati) | cache terisi setelah backtest |

Jadi `--exchange` / `--cache-only` di laptop **tidak bisa** 1:1. Solusinya: **`--via-api`** (default untuk real) — memanggil `POST /api/v1/backtest/run-real` yang sama dengan FE.

## Setup sekali (wajib untuk 1:1)

Di `be-bot-trading/.env` (sudah dipasang default ke BE dev):

```env
DATASET_EXPAND_API_URL=https://dev.quantara.software
# Auto-login (rekomendasi) — script tukar email+password jadi JWT sendiri:
DATASET_EXPAND_EMAIL=you@example.com
DATASET_EXPAND_PASSWORD=••••••••
# Alternatif: paste JWT manual, kosongkan email/password kalau pakai ini:
# DATASET_EXPAND_TOKEN=<jwt-access-token>
```

- **Auto-login**: isi `DATASET_EXPAND_EMAIL` + `DATASET_EXPAND_PASSWORD` dengan kredensial dashboard-mu. Script memanggil `POST /api/v1/auth/login` dan memakai `accessToken` yang didapat — tidak perlu copy-paste token.
- **Token manual**: kalau lebih suka, login FE → DevTools → Network → header `Authorization: Bearer …` → tempel ke `DATASET_EXPAND_TOKEN`.

> Database tidak perlu di-setup lokal untuk mode ini — fetch candle + query DB semua terjadi di BE dev (`dev.quantara.software`), sama seperti UI.

## Penggunaan

Dari `be-bot-trading/` atau `scripts/dataset-expand/`:

```bash
# 1:1 UI — Scalping 90d Binance (default = via-api)
node smart-money-concepts/scalping.js --symbols BTCUSDT --days 90 --capital 1000

# Quick smoke via API (30d)
node smart-money-concepts/scalping.js --quick

# Explicit flags (one-shot tanpa .env)
node smart-money-concepts/scalping.js \
  --api https://dev.quantara.software \
  --email you@example.com \
  --password '***' \
  --exchange binance \
  --symbols BTCUSDT \
  --days 90
```

Hasil: `tmp/dataset-expand/<slug>/<type>/trades.csv` + `stats.json` + `scalping-ablation.txt` (Scalping).

## Mode

| Mode | Flag | Kapan dipakai |
|------|------|----------------|
| **via-api (default real)** | otomatis / `--via-api` | Laptop tanpa akses exchange — **ini path 1:1 UI** |
| local direct | `--local` | Mesin punya network ke Binance/Bitget + optional DB |
| cache-only | `--cache-only` | DB berisi `candle_cache` (Postgres harus hidup) |
| mock | `--mock` | Dev offline — **bukan** parity UI |

## Timeframe (SSOT)

| Trade type | Entry | HTF |
|------------|-------|-----|
| Scalping | 5m | 1h |
| Intraday | 15m | 4h |
| Swing | 4h | 1w |

## Flags

| Flag | Default | Keterangan |
|------|---------|------------|
| `--symbols` | `BTCUSDT` | Pair list |
| `--days` | cap TF (Scalping 180) | `90`→`3m`, `180`→`6m`, `365`→`12m` |
| `--exchange` | `binance` | Candle source (sama UI Advance dropdown) |
| `--capital` | `1000` | Modal |
| `--api` | env `DATASET_EXPAND_API_URL` | Base URL BE (default `https://dev.quantara.software`) |
| `--email` | env `DATASET_EXPAND_EMAIL` | Email dashboard → auto-login JWT |
| `--password` | env `DATASET_EXPAND_PASSWORD` | Password dashboard → auto-login JWT |
| `--token` | env `DATASET_EXPAND_TOKEN` | JWT manual (alternatif email/password) |
| `--via-api` | on (real) | Paksa mode API |
| `--local` | off | Bypass API — fetch di laptop |
| `--cache-only` | off | DB cache only (butuh Postgres) |
| `--mock` / `--quick` | off | Dev / smoke |
| `--out` | `tmp/dataset-expand/...` | Output folder |

## Struktur

```
scripts/dataset-expand/
├── README.md
├── lib/
│   ├── runDatasetExpand.js
│   ├── viaApi.js              # POST run-real + poll (UI path)
│   └── strategyRegistry.js
└── <strategy-slug>/{scalping,intraday,swing}.js
```

## Catatan

- via-api = engine + klines di **server** → angka harus selaras screenshot UI (± timing window).
- `--mock` over-fires (ratusan trades) — jangan dibanding ke UI.
- Token JWT expire → refresh dari FE lalu update `.env`.
