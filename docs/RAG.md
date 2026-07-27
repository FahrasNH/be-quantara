# RAG di Quantara — Panduan Lengkap

**Scope:** Apa arti RAG di project ini, mengapa bisa berjalan, dan bagaimana alurnya dari data → model → gate.  
**Bukan:** RAG generik NLP (chatbot knowledge-base). Di Quantara, RAG = **Retrieval-Augmented Gate** untuk keputusan trade.  
**Doc date:** 2026-07-26  
**SSOT terkait:** `ARCHITECTURE.md` (§ RAG gate), `src/modules/ml/`, `scripts/ml/`, `scripts/walkforward/`

---

## Ringkasan singkat

Di Quantara, **RAG** adalah lapisan ML yang:

1. **Mengambil** (retrieve) trade historis mirip dari Postgres + pgvector (`TradeEmbedding`).
2. **Memprediksi** peluang menang dengan model **WinPredictor** (gradient boosting murni JS, 60 fitur).
3. **Menggabungkan** skor prediksi + similaritas → **gate** (approve / reject / hanya log).

Ada jalur terpisah bernama **True-RAG** (Sprint 21) untuk **jelaskan keputusan** lewat dokumen + Grok — itu **bukan** hot-path entry live.

---

## 1. Apa itu RAG pada project ini?

### 1.1 Definisi operasional

**Istilah:** RAG  
**Kepanjangan di Quantara:** Retrieval-Augmented **Gate** (bukan hanya Generation)  
**Tujuan:** Filter / skor setup trade memakai model + memori trade serupa  
**Bukan:** Chatbot Q&A, knowledge wiki, atau pengganti strategi SMC/Wyckoff/dll.

---

**Istilah:** WinPredictor  
**Peran:** Model `p(win)` dari vektor fitur 60 dimensi  
**File:** `src/modules/ml/domain/WinPredictor.js`  
**Artefak:** `data/models/win-predictor.json`

---

**Istilah:** FeatureEngineer  
**Peran:** Mengubah `entryContext` (confidence, ATR, regime, skor sinyal, …) → `Float32Array(60)`  
**File:** `src/modules/ml/domain/FeatureEngineer.js`

---

**Istilah:** TradeEmbedding / VectorStore  
**Peran:** Retrieval — cari trade historis mirip (cosine / pgvector)  
**Tabel:** `TradeEmbedding` (vektor 60d)  
**File:** `src/infrastructure/db/VectorStore.js`

---

**Istilah:** MLGateService  
**Peran:** Gate **live** sebelum entry (`BotEngine`) berdasarkan `pWin`  
**File:** `src/modules/ml/services/MLGateService.js`  
**Env:** `ML_GATE_MODE`

---

**Istilah:** `_applyRagGate`  
**Peran:** Gate **post-hoc** pada hasil backtest (blend LGB + similarity)  
**File:** `src/modules/backtest/services/RealStrategyBacktestService.js`  
**Trigger FE:** Advanced Options → “RAG Gate (ML)”

---

**Istilah:** MLShadowLog / MLShadowService  
**Peran:** Mencatat prediksi vs outcome; seed embedding; laporan kesiapan promosi  
**File:** `src/modules/ml/services/MLShadowService.js` + hook `BotEngineMlHook.js`

---

**Istilah:** True-RAG (research)  
**Peran:** Explain grounded (DocEmbedding 384d + HybridRetriever + opsional Grok)  
**API:** `POST /api/v1/ai/explain`, ingest dokumen  
**Bukan** pengganti WinPredictor gate di live entry

---

**Istilah:** Grok Confirm  
**Peran:** Overlay LLM untuk konfirmasi entry / TP (xAI)  
**Status:** **Terpisah** dari RAG ML — bisa hidup berdampingan, stack berbeda

### 1.2 Dua makna “RAG” di codebase

**Jalur:** Entry / backtest gate (inti dokumen ini)  
**Komponen:** WinPredictor + FeatureEngineer + TradeEmbedding + MLGate / `_applyRagGate`  
**Output:** `allowed` / `rejected` / shadow log  
**User-facing:** toggle RAG Gate di backtest; mode live lewat env

---

**Jalur:** True-RAG explain (Sprint 21)  
**Komponen:** `RagExplainService`, `DocEmbedding`, HybridRetriever, opsional Grok  
**Output:** teks penjelasan berdasar evidence  
**User-facing:** panel Explain Why / admin AI

### 1.3 Apa yang RAG **tidak** lakukan

- Tidak mengganti deteksi sinyal strategi (SMC sequence, Wyckoff, VSA, …).
- Tidak membuka posisi sendiri — hanya menilai setup yang sudah dihasilkan engine.
- Tidak wajib aktif di production (`ML_GATE_MODE=active` diblokir saat `NODE_ENV=production`).
- Tidak sama dengan antrean walkforward/backtest job (itu concurrency BE, bukan RAG).

---

## 2. Kenapa RAG bisa berjalan di project ini?

RAG di Quantara **bukan magic** — butuh tiga fondasi yang sudah ada di stack.

### 2.1 Fondasi data

**Fondasi:** Konteks entry terstruktur  
**Mengapa perlu:** Model butuh fitur numerik konsisten per trade  
**Dari mana:** `entryContext` / kolom CSV walkforward / enrichment `BotEngine`  
**Tanpa ini:** Train & predict gagal / cold-start

---

**Fondasi:** Label outcome (win/loss)  
**Mengapa perlu:** Supervised learning `p(win)`  
**Dari mana:** `exitContext.pnl`, kolom CSV `Result`, engine `trades` closed  
**Tanpa ini:** Dataset kosong → model tidak tersimpan

---

**Fondasi:** Postgres + pgvector  
**Mengapa perlu:** Similarity retrieval (“R” di RAG)  
**Dari mana:** Migrasi `TradeEmbedding`, pool `database.js`  
**Tanpa ini:** Backtest gate fail-open (hanya LGB / atau skip reject)

---

**Fondasi:** Artefak model di disk  
**Mengapa perlu:** Runtime load tanpa retrain tiap boot  
**Path:** `data/models/win-predictor.json`  
**Tanpa ini:** `rag-gate-status` offline; live gate cold / disabled efektif

### 2.2 Fondasi infrastruktur yang sudah ada

**Komponen:** Walkforward + dataset-expand  
**Kontribusi:** Menghasilkan `trades.csv` historis multi-window (SMC, Wyckoff, …)  
**Skrip:** `scripts/walkforward/**`, `scripts/dataset-expand/**`

---

**Komponen:** Bootstrap offline  
**Kontribusi:** CSV → `data/ml-engine-dataset.json` tanpa DB lokal  
**Skrip:** `scripts/ml/bootstrap-from-walkforward-csv.js` (`--smc-all`)

---

**Komponen:** Bootstrap engine (staging)  
**Kontribusi:** Closed trades live/paper → dataset + upsert embedding  
**Skrip:** `scripts/ml/bootstrap-from-engine-trades.js`  
**Deploy:** `scripts/ml/deploy-rag-staging-remote.sh`

---

**Komponen:** Isolasi backtest worker  
**Kontribusi:** Gate post-hoc aman dijalankan di job yang sama dengan simulasi  
**Env:** `BACKTEST_ISOLATE`, heap cap worker

---

**Komponen:** Live BotEngine hooks  
**Kontribusi:** Prediksi + shadow log tiap open/close tanpa mengubah race strategi  
**File:** `BotEngine.js` + `BotEngineMlHook.js`

### 2.3 Env yang mengontrol “boleh jalan”

**Env:** `ML_GATE_MODE`  
**Nilai:** `shadow` (default) · `active` · `disabled`  
**Efek:** Live — log saja / blok entry rendah `pWin` / bypass  
**Catatan:** `active` **dilarang** di `NODE_ENV=production`

---

**Env:** `ML_WIN_GATE_THRESHOLD`  
**Nilai default:** `0.45`  
**Efek:** Ambang `pWin` saat mode `active`

---

**Env:** `ML_COLD_START_TRADES`  
**Nilai default:** `200`  
**Efek:** Di bawah jumlah closed trades → regime confidence default (bukan model penuh)

---

**Env:** `RAG_APPROVE_THRESHOLD`  
**Nilai tipikal:** `0.4`  
**Efek:** Ambang skor blend di `_applyRagGate` (backtest)

---

**Env:** `RAG_SEED_AFTER_BACKTEST`  
**Nilai default:** `false` (harus `"true"` eksplisit untuk aktif)  
**Efek:** Setelah backtest RAG gate, upsert trade ke `TradeEmbedding`. Matikan (default) agar rerun backtest tidak terkontaminasi outcome masa depan.

---

**Env:** `RAG_MODE`  
**Nilai:** `shadow` · `advisory`  
**Efek:** Mode dashboard / promote admin (beda channel dari `ML_GATE_MODE`)

---

**Env:** `RAG_BACKTEST_ENABLED`  
**Nilai:** `true` di staging sering dipaksa  
**Efek:** Mengizinkan API analytics RAG backtest di non-prod

### 2.4 Checklist “RAG siap dipakai”

**Syarat:** File `data/models/win-predictor.json` ada  
**Cek:** `ls data/models/win-predictor.json` atau `GET /api/v1/backtest/rag-gate-status`  
**Minimal untuk:** Live MLGate + skor LGB di backtest

---

**Syarat:** Embedding cukup di `TradeEmbedding`  
**Cek:** `rag-gate-status` / admin RAG dashboard  
**Minimal untuk:** Reject berbasis similarity (tanpa ini backtest cenderung **fail-open keep**)

---

**Syarat:** BE sudah load model (restart setelah train)  
**Cek:** Restart PM2 setelah `ml:train-win-predictor`  
**Minimal untuk:** Gate runtime memakai model baru

---

**Syarat:** pgvector migration applied  
**Cek:** `npx prisma migrate deploy` di VPS  
**Minimal untuk:** Upsert / `findSimilar`

---

## 3. Bagaimana RAG berjalan di project ini?

### 3.1 Peta alur end-to-end

```text
┌──────────────────────────────┐
│ 1. DATA                      │
│  Walkforward CSV  ──┐        │
│  Engine trades    ──┼──► bootstrap ──► ml-engine-dataset.json
│  Prisma Trade     ──┘              └──► TradeEmbedding (opsional)
└──────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────┐
│ 2. TRAIN                     │
│  ml:train-win-predictor      │
│  ──► win-predictor.json      │
│  ──► training-report.json    │
└──────────────────────────────┘
                 │
        ┌────────┴────────┐
        ▼                 ▼
┌───────────────┐  ┌──────────────────┐
│ 3a. LIVE      │  │ 3b. BACKTEST     │
│ MLGateService │  │ _applyRagGate    │
│ (pWin only)   │  │ 0.5 LGB + 0.5 sim│
│ shadow/active │  │ ragGate: true    │
└───────┬───────┘  └────────┬─────────┘
        ▼                   ▼
┌───────────────┐  ┌──────────────────┐
│ Shadow log +  │  │ Filter trades +  │
│ seed embed    │  │ seed embed BT    │
└───────────────┘  └──────────────────┘
```

### 3.2 Tahap data → dataset

**Langkah:** Export walkforward  
**Perintah:** `node scripts/walkforward/<slug>/<type>.js`  
**Output:** `tmp/<prefix>-{scalping|intraday|swing}-walkforward/**/trades.csv`  
**Catatan:** Via-api ke BE; butuh token / email password `.env`

---

**Langkah:** Bootstrap gabungan (contoh SMC)  
**Perintah:** `node scripts/ml/bootstrap-from-walkforward-csv.js --smc-all`  
**Output:** `data/ml-engine-dataset.json`  
**Isi:** samples `{ features[60], label, timestamp, sourceFile }`

---

**Langkah:** Bootstrap dari DB staging  
**Perintah:** `npm run ml:bootstrap-engine-trades`  
**Output:** dataset JSON + upsert `TradeEmbedding`  
**Syarat:** Closed trades ≥ min (lihat deploy script)

---

**Langkah:** Train  
**Perintah:** `npm run ml:train-win-predictor`  
**Urutan source:** cache JSON → (opsional) Prisma → engine trades  
**Output:** `data/models/win-predictor.json` + `training-report.json`

### 3.3 Tahap live (BotEngine)

**Langkah:** Boot server  
**Aksi:** `assertMlGateProductionSafety()` — tolak `ML_GATE_MODE=active` di production  
**SSOT:** `src/modules/ml/guards/mlGateProductionGuard.js`

---

**Langkah:** Sinyal strategi siap entry  
**Aksi:** Enrich `entryContext` → `MLGateService.evaluateEntry`  
**Hasil shadow:** selalu `allowed` + log “would skip” jika `pWin` rendah  
**Hasil active:** skip entry jika `pWin < ML_WIN_GATE_THRESHOLD`

---

**Langkah:** (Opsional) Grok Confirm  
**Aksi:** Overlay terpisah setelah / di sekitar gate ML  
**SSOT:** `GrokConfirmService` — **bukan** bagian skor RAG

---

**Langkah:** Open / close posisi  
**Aksi:** `BotEngineMlHook` → `MLShadowService.logPrediction` / `recordOutcome`  
**Side effect:** baris `MLShadowLog` + best-effort embedding baru

### 3.4 Tahap backtest (UI Advance)

**Langkah:** Probe kesiapan  
**API:** `GET /api/v1/backtest/rag-gate-status`  
**Cek:** model ada **atau** embedding count cukup  
**FE:** disable toggle bila offline

---

**Langkah:** Jalankan backtest dengan gate  
**API:** `POST /api/v1/backtest/run-real` body `ragGate: true`  
**Engine:** simulasi penuh dulu → lalu `_applyRagGate` pada daftar trade

---

**Langkah:** Skor per trade di `_applyRagGate`  
**LGB:** `WinPredictor.predict` → `lgbScore`  
**Retrieval:** `VectorStore.findSimilar` (time-aware) → `ragScore`  
**Blend:** `0.5 * lgbScore + 0.5 * ragScore` (jika keduanya ada)  
**Keputusan:** bandingkan ke threshold (setelah discount konservatif)  
**Fail-open:** tanpa similarity evidence → **tidak menolak** (hindari false reject)

---

**Langkah:** Setelah run  
**Aksi:** seed embedding dari trade backtest (best-effort)  
**Tujuan:** run berikutnya punya memori mirip lebih kaya

### 3.5 True-RAG explain (jalur samping)

**Langkah:** Ingest dokumen  
**API:** `POST /api/v1/ai/rag/ingest` (admin secret)  
**Store:** `DocEmbedding` 384d

---

**Langkah:** Minta penjelasan  
**API:** `POST /api/v1/ai/explain`  
**Service:** `RagExplainService.explain` → HybridRetriever (+ opsional Grok)  
**FE:** Explain Why panel

### 3.6 Mode operasional (cheat sheet vertikal)

**Concern:** Blok entry live  
**Env:** `ML_GATE_MODE`  
**shadow:** Tidak pernah blok  
**active:** Blok jika `pWin` rendah (prod forbidden)  
**disabled:** Bypass total

---

**Concern:** Promosi dashboard admin  
**Env:** `RAG_MODE`  
**shadow:** Default observasi  
**advisory:** Setelah `/rag/promote` (butuh readiness AUC, dll.)

---

**Concern:** Filter hasil backtest  
**Kontrol:** request `ragGate: true`  
**Perilaku:** Post-hoc filter; fail-open jika deps kurang. Similarity search memakai filter `beforeDate` + `strategyKey` agar tidak look-ahead.

---

**Concern:** Explain Why (evidence RAG)  
**API:** `POST /api/v1/ai/explain`  
**Perilaku:** LLM xAI dipanggil dengan `temperature: 0` untuk respons deterministik berbasis bukti.

---

**Concern:** Meta strategy advisor  
**Env:** `ML_ADVISOR_MODE` + `WEIGHT_RL3`  
**Perilaku:** HybridAdvisor — **bukan** entry gate WinPredictor

---

## 4. File & perintah penting

### 4.1 Kode inti

**Path:** `src/modules/ml/domain/WinPredictor.js`  
**Fungsi kunci:** `train`, `predict`, `walkForwardValidate`, `load` / `save`

---

**Path:** `src/modules/ml/domain/FeatureEngineer.js`  
**Fungsi kunci:** `buildFeatureVector`

---

**Path:** `src/modules/ml/services/MLGateService.js`  
**Fungsi kunci:** `evaluateEntry`, `getMode`, `autoStart`

---

**Path:** `src/modules/ml/services/MLShadowService.js`  
**Fungsi kunci:** `logPrediction`, `recordOutcome`, `checkPromotionReadiness`

---

**Path:** `src/modules/backtest/services/RealStrategyBacktestService.js`  
**Fungsi kunci:** `_applyRagGate`, `_seedBacktestTradeEmbeddings`, `getRagGateDeps`

---

**Path:** `src/infrastructure/db/VectorStore.js`  
**Fungsi kunci:** `upsertEmbedding`, `findSimilar`, `batchUpsert`, `checkAvailability`

---

**Path:** `src/modules/ml/constants/modelPaths.js`  
**Konstanta:** `WIN_PREDICTOR_PATH`, `ML_ENGINE_DATASET_PATH`, `TRAINING_REPORT_PATH`

### 4.2 Skrip npm / CLI

**Perintah:** `npm run ml:bootstrap-walkforward`  
**Alias ke:** `scripts/ml/bootstrap-from-walkforward-csv.js`  
**Kapan:** Setelah walkforward CSV siap (offline OK)

---

**Perintah:** `npm run ml:bootstrap-engine-trades`  
**Kapan:** Staging dengan closed trades di DB

---

**Perintah:** `npm run ml:train-win-predictor`  
**Kapan:** Setelah dataset; prefer cache JSON bila DB lokal mati

---

**Perintah:** `./scripts/ml/deploy-rag-staging-remote.sh`  
**Kapan:** Bootstrap + train + reload PM2 di VPS staging

---

**Perintah:** `node scripts/backtest-clear-queue.js`  
**Kapan:** Slot backtest `max 1` nyangkut (bukan bagian RAG, tapi sering bentrok saat train/export)

### 4.3 Rantai praktis (SMC contoh)

```bash
# 1) Export (opsional — jika CSV belum ada)
node scripts/walkforward/smart-money-concepts/scalping.js
node scripts/walkforward/smart-money-concepts/intraday.js
node scripts/walkforward/smart-money-concepts/swing.js

# 2) Merge dataset
node scripts/ml/bootstrap-from-walkforward-csv.js --smc-all

# 3) Train
npm run ml:train-win-predictor

# 4) Deploy artefak ke VPS + restart BE
# 5) UI: Backtest → Advanced Options → RAG Gate ON
# 6) Live: set ML_GATE_MODE=shadow (staging) → amati shadow log
```

---

## 5. Fail-open & keamanan

**Aturan:** Deps ML tidak tersedia  
**Perilaku:** Backtest / live tidak memalsukan reject keras tanpa evidence  
**Alasan:** Hindari memotong edge strategi karena model kosong

---

**Aturan:** Similarity kosong di `_applyRagGate`  
**Perilaku:** Trade **tetap di-keep** (fail-open) meski LGB ada  
**Alasan:** Reject butuh retrieval evidence (“R”)

---

**Aturan:** `ML_GATE_MODE=active` + production  
**Perilaku:** Throw saat boot / konstruksi engine  
**SSOT:** `mlGateProductionGuard.js`

---

**Aturan:** Ctrl+C saat walkforward via-api  
**Perilaku (setelah fix):** cancel job di server agar slot concurrency bebas  
**Bukan RAG:** tapi sering mengacaukan pipeline data yang dipakai train RAG

---

## 6. Glosarium cepat

**Istilah:** `pWin`  
**Arti:** Probabilitas prediksi trade menang (0–1) dari WinPredictor

---

**Istilah:** Cold-start  
**Arti:** Belum cukup closed trades → gate pakai default regime, bukan model penuh

---

**Istilah:** Shadow  
**Arti:** Sistem menilai & mencatat, tetapi **tidak** mengubah eksekusi

---

**Istilah:** Fail-open  
**Arti:** Jika ML gagal / evidence kurang → biarkan trade/strategi jalan seperti tanpa RAG

---

**Istilah:** Seed embedding  
**Arti:** Menulis vektor trade (live close / akhir backtest) ke `TradeEmbedding` untuk retrieval berikutnya

---

## 7. Referensi silang

- Architecture ringkas gate backtest: `ARCHITECTURE.md` → “RAG gate on backtest”
- Walkforward: `scripts/walkforward/README.md`
- Dataset expand (via-api): `scripts/dataset-expand/README.md`
- Strategy entry (bukan RAG): `docs/AF_SMC.md` dan sibling `docs/AF_*`, `docs/TS_*`, …
- Prisma models: `TradeEmbedding`, `MLShadowLog`, `DocEmbedding` di `prisma/schema.prisma`

---

*Dokumen ini menggambarkan perilaku kode saat ini (AS-IS). Perubahan env/model tanpa restart BE tidak otomatis terbaca runtime.*
