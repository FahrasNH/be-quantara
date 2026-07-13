# Integrasi xAI (console.x.ai) — AI Training & Optimizer

Platform **Quantara** terintegrasi dengan [xAI Console](https://console.x.ai/) untuk:

1. **Analisis optimasi backtest** — Grok menganalisis metrik dan memberikan rekomendasi parameter strategi
2. **Knowledge base (Collections RAG)** — Dokumentasi strategi di-index untuk konteks analisis
3. **Export dataset training** — Trade history dengan snapshot indikator → JSONL siap ML

> **Catatan:** xAI tidak menyediakan fine-tuning model publik. "Training" di sini = membangun knowledge base + dataset analitik + AI advisor untuk optimasi parameter.

---

## Langkah Setup

### 1. Buat akun & API key

1. Daftar di [console.x.ai](https://console.x.ai/)
2. Top-up kredit (ada promo $25 untuk akun baru)
3. Buat **API Key** di [API Keys](https://console.x.ai/team/default/api-keys)

### 2. (Opsional) Setup Collections untuk RAG

1. Buat Collection di [Collections](https://console.x.ai/) — catat `collection_id`
2. Buat **Management API Key** dengan permission `AddFileToCollection` di [Management Keys](https://console.x.ai/team/default/settings/management-keys)

### 3. Konfigurasi `.env`

Tambahkan ke `be-bot-trading/.env`:

```env
XAI_ENABLED=true
XAI_API_KEY="xai-..."
XAI_MODEL="grok-4.3"
XAI_TIMEOUT_MS=60000

# Opsional — RAG knowledge base
XAI_MANAGEMENT_API_KEY="mgmt-..."
XAI_COLLECTION_ID="collection_..."

# Dev/staging: izinkan semua user pakai AI optimizer
XAI_OPTIMIZER_OPEN=true
```

Production tier **VAULT**: set juga `VAULT_AI_OPTIMIZER_ENABLED=true` (sudah ada di `tierConfig.js`).

### 4. Sync dokumentasi strategi

```bash
cd be-bot-trading
node scripts/xai-sync-knowledge.js
```

Upload otomatis:
- `docs/STRATEGIES.md`
- `docs/PAIR_VOLATILITY.md`
- `docs/README.md`
- Default parameter strategi (JSON)

### 5. Restart backend

```bash
npm run dev
```

---

## API Endpoints

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET | `/api/v1/ai/status` | Status integrasi xAI |
| POST | `/api/v1/ai/analyze` | Analisis AI penuh (Grok) |
| POST | `/api/v1/ai/export-training` | Export dataset JSONL |
| POST | `/api/v1/ai/upload-training` | Export + upload ke Collection |
| POST | `/api/v1/ai/sync-knowledge` | Sync docs (butuh `X-Admin-Secret`) |
| POST | `/api/v1/backtest/optimize` | Optimasi (rule-based + AI jika enabled) |

### Contoh: analisis AI

```bash
curl -X POST http://localhost:3000/api/v1/ai/analyze \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "BTCUSDT",
    "strategyKey": "AF_SMC",
    "metrics": {
      "winRate": 48,
      "profitFactor": 1.65,
      "maxDrawdown": 12.5,
      "totalReturn": 23.4,
      "sharpe": 1.2,
      "totalTrades": 87
    }
  }'
```

### Contoh: export training data

```bash
node scripts/xai-export-training.js --userId=<uuid> --symbol=BTCUSDT --limit=500 --out=training.jsonl
```

---

## UI

Tab **Optimasi** di Backtest otomatis memanggil `/backtest/optimize` dengan AI jika:
- `XAI_ENABLED=true` + `XAI_API_KEY` valid
- User punya akses (dev: `XAI_OPTIMIZER_OPEN=true`, prod: tier VAULT)

Respons AI ditandai dengan badge **Grok AI** dan ringkasan `ai_summary`.

---

## Arsitektur

```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│ Backtest UI │────▶│ OptimizationAnalysis │────▶│ XaiTrainingSvc  │
│ Optimasi    │     │ Service (rules+AI)   │     │                 │
└─────────────┘     └──────────────────────┘     └────────┬────────┘
                                                          │
                        ┌─────────────────────────────────┼──────────────┐
                        ▼                                 ▼              ▼
                 ┌────────────┐                  ┌──────────────┐  ┌───────────┐
                 │ XaiClient  │                  │ Collections  │  │ Trade DB  │
                 │ Chat API   │                  │ RAG Search   │  │ getInsights│
                 └────────────┘                  └──────────────┘  └───────────┘
                        │
                        ▼
                 console.x.ai / api.x.ai
```

---

## Biaya & Model

- Model default: `grok-4.3` (flagship, 1M context)
- Ganti via `XAI_MODEL` — lihat [pricing xAI](https://x.ai/api)
- Collections: indexing & storage gratis awal (cek docs terbaru)

---

## Troubleshooting

| Error | Solusi |
|-------|--------|
| `XAI_API_KEY belum dikonfigurasi` | Set env + restart server |
| `403 AI Optimizer membutuhkan tier VAULT` | Set `XAI_OPTIMIZER_OPEN=true` untuk dev |
| RAG search gagal | Cek `XAI_COLLECTION_ID`, sync ulang knowledge |
| Upload collection gagal | Pastikan Management Key punya permission Collections |
