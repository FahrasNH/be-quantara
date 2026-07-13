# Dokumentasi Strategi & Parameter — Quantara Bot Trading

**Versi:** v2.7 (Gen2 keys) + Pair Tier v2.1  
**Update:** 11 Juli 2026 (DOC-SSOT)  
**Sumber kebenaran kode:** `src/config/strategies.js` (Gen2 keys) → umbrellas →
`src/domain/strategy/implementations/*.js` · Entitlement: `src/domain/tierConfig.js`

> Parameter **efektif** di bot = preset + BotEngine, lalu di-override oleh **Pair Tier**
> (`PairClassifier.PARAM_OVERRIDES`) saat bot start. Lihat [PAIR_VOLATILITY.md](PAIR_VOLATILITY.md).
>
> **Naming:** Dokumen ini memakai **Gen2** (`AF_SMC`, `TS_TF`, `MD_MR`, `BS_BR`).
> Gen1→Gen2 map: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §1.

---

## 1. Ringkasan Perbandingan

| Strategi (Gen2) | Tier min. | Entry TF | HTF | SL×ATR | TP×ATR | RR target | Risk/trade | Leverage | Max trade/hari |
|-----------------|-----------|----------|-----|--------|--------|-----------|------------|----------|----------------|
| **AF_SMC** (Adaptive Fusion pool) | FOUNDRY | 15m | 1h | 1.2–2.2* | 3.0–3.4* | **~1:2.0–3.0** | **0.5%** (1% strong) | 2× | **6** |
| **TS_TF** (Trend Surge pool) | FORGE | 5m | 4h | **1.3** | **2.5** | ~1:1.92 | **1.2%** | 2× | **4** |
| **MD_MR** (Mean Drift) | MINT | 15m | — | **1.4** | **3.2** | ~1:2.3 | **0.8%** | 1× | **3** |
| **BS_BR** (Breakout Storm) | VAULT | 15m | 4h | **1.4** | **5.5** | ~1:4.0 | **2.0%** | 1× | **5** |

\* AF: SL/TP per trade-type leg (lihat §4). Legacy aliases: `ADAPTIVE_FUSION`→`AF_SMC`,
`TREND_FOLLOWING`/`TREND_MOMENTUM`→`TS_TF`, `MEAN_REVERSION`→`MD_MR`, `BREAKOUT_RETEST`→`BS_BR`.

---

## 2. Override Pair Tier (lintas strategi)

Diterapkan otomatis dari `PairClassifier` berdasarkan hybrid score CoinGecko. Menggandakan/membatasi parameter strategi:

| Tier | SL× (override) | Position size | Max trade/hari | Daily loss cap | Regime filter | AF voting threshold |
|------|----------------|---------------|----------------|----------------|---------------|---------------------|
| LIQUID | 1.0× | 100% | unlimited | — | opsional | default |
| STABLE | 1.1× | 95% | 8 | — | wajib | 0.60 |
| SEMI_VOLATILE | 1.3× | 75% | 6 | 2.5% | wajib | 0.70 |
| VOLATILE | 1.5× | 55% | 4 | 3.0% | wajib | 0.78 |

**Position size efektif** = `riskPerTrade × pairPositionSizeAdjustment × ukuran posisi`.

---

## 3. Parameter Global BotEngine

Berlaku semua strategi kecuali di-override eksplisit di preset strategi.

| Parameter | Default | Keterangan |
|-----------|---------|------------|
| `maxDailyLossPct` | **0.03** (3%) | Stop entry bila kerugian harian (realized + floating) ≥ batas |
| `maxRiskPerTrade` | **0.012** (1.2%) | Plafon risiko aktual per trade (guard min lot) |
| `cooldownAfterLoss` | **45 menit** | Jeda setelah loss (`strat.cooldownAfterLoss` override per strategi) |
| `maxConsecLoss` | **3** | Stop entry setelah N loss berturut |
| `feeRate` | 0.0006 (0.06%) | Fee taker per sisi (Bitget USDT-M) |
| `makerFeeRate` | 0.0002 (0.02%) | Fee maker (jika `entryMode: maker`) |
| `entryMode` | `taker` | `taker` \| `maker` (limit post-only) |
| `minEdgeFeeMultiple` | **5** | Reward leg (jarak TP) ≥ N × fee roundtrip; AF preset = **7** |
| `maxEntryExtensionATR` | 1.5 (AF preset **0.7**) | Tolak entry jika \|close − EMA9\| / ATR > N (anti-chase) |
| `strongTrendTPMult` | **1.8** (AF) | TP ×1.8 saat regime STRONG_TREND (AF only) |
| `afMinVotes` | **3** | Kuorum minimum komponen AF searah |
| `afRejectOnDissent` | `true` | Tolak entry AF bila komponen saling berlawanan |
| `atrMinMult` / `atrMaxMult` | 0.1–5.0 (per strategi) | Filter ATR% relatif terhadap harga |
| `volSmaMultiplier` | per strategi | Rasio volume minimum vs SMA volume |
| `checkInterval` | per strategi | Interval polling sinyal (ms) |

---

## 4. AF_SMC — Adaptive Fusion (race-to-confirm, Sprint 12)

**Versi implementasi:** umbrella race + SMC/Wyckoff/VSA racers  
**Tier:** FOUNDRY+  
**Mode default:** race-to-confirm (`afCombinationMode: "race"`). Rollback voting:
`afCombinationMode: "vote"` / `afUseThreeComponentVoting`.

**Sumber kode:**
- Umbrella: `src/domain/strategy/umbrellas/AdaptiveFusionUmbrella.js`
- Racers: `SmartMoneyConceptsStrategy`, `af/wyckoffComponent.js`, `af/vsaComponent.js`
- Config: `src/config/strategies.js` (`TIER_COMPONENT_MAP.FOUNDRY`)

| Parameter | Default | Keterangan |
|-----------|---------|------------|
| `afCombinationMode` | `race` | Race-to-confirm (Sprint 12) |
| `afUseThreeComponentVoting` | (rollback) | Sprint 8 2/3 voting when mode=`vote` |
| `afMinVotes` | `2` | Kuorum absolut (voting rollback only) |

Trade types Scalping/Swing dari SMC; attribution = winning racer label only.

### 4.1 Parameter Runtime - v2.6

| Parameter | Nilai Baru | Keterangan |
|-----------|------------|------------|
| `interval` | 15m | Entry TF |
| `higherTf` | 1h | HTF alignment wajib |
| `htfEmaFast` / `htfEmaSlow` | 9 / 21 | |
| `emaFast` / `emaSlow` / `emaTrend` | 9 / 21 / 50 | |
| `rsiPeriod` | 14 | |
| `rsiOverbought` / `rsiOversold` | 72 / 28 | |
| `rsiLongMin`–`rsiLongMax` | **60–68** | Sangat selektif |
| `rsiShortMin`–`rsiShortMax` | **32–40** | Diperketat |
| `atrPeriod` | 14 | |
| `atrMultiplier` | **1.4** | SL fallback |
| `riskReward` | **2.5** | |
| `atrMinMult` / `atrMaxMult` | **1.2 / 3.5** | Hindari pasar sepi |
| `riskPerTrade` | **0.005** (0.5%) | Default konservatif |
| `riskPerTradeStrong` | **0.01** (1%) | Saat STRONG_TREND |
| `maxDailyLossPct` | **0.035** | |
| `maxTradesPerDay` | **6** | |
| `cooldownAfterLoss` | **90 menit** | |
| `maxConsecLoss` | **2** | |
| `leverage` | 2× | |
| `maxEntryExtensionATR` | **0.7** | Anti-chasing lebih ketat |
| `minEdgeFeeMultiple` | **7** | |
| `afMinVotes` | **3** | |
| `afRejectOnDissent` | true | |
| `volSmaMultiplier` | **2.0** | Volume harus sangat kuat |
| `sidewaysRangeLookback` | 20 | |
| `sidewaysBreakoutVolMult` | **1.5** | |
| `checkInterval` | 60 000 ms | |

### 4.2 Voting & Regime - Enhanced

| Parameter | Nilai Baru | Keterangan |
|-----------|------------|------------|
| `htfTrendStrengthMin` | **0.75** | Trend harus jelas |
| `afMinVotes` | 3 | |
| `votingThresholdOverride` | tier-based | STABLE 0.60 / SEMI 0.70 / VOLATILE 0.78 |
| `LOW_VOL` | **1.4%** ATR | |
| `WEAK_TREND` | **0.55** | |
| `NORMAL_TREND` | 0.65 | |
| `STRONG_TREND` | 0.82 | |
| `strongTrendTPMult` | **1.8** | TP +80% di strong trend |
| Regime `DEAD_MARKET` | — | **Blok entry total** |

### 4.3 Sub-Strategi A / B / C

| Komponen | SL×ATR | TP×ATR | RR | minScore |
|----------|--------|--------|-----|----------|
| **A** Scalp | 2.2 | 3.3 | 1:1.5 | 38 |
| **B** Day | 1.6 | 3.4 | 1:2.1 | 45 |
| **C** Swing | 1.2 | 3.0 | 1:2.5 | 42 |

**Aturan**: SL di VOLATILE pair wajib ikut komponen C (Swing). Strong trend pakai TP multiplier 1.8× dan risk 1%.

### 4.4 Riwayat v2.6 (as-built)

- Preset: risk 0.5% (1% strong), max 6 trade/hari, cooldown 90 mnt
- Guards: `maxEntryExtensionATR` 0.7, `volSmaMultiplier` 2.0, `htfTrendStrengthMin` 0.75
- RSI B 60–68 / 32–40; ATR floor 1.2%

---

## 5. TS_TF — Trend Surge / Trend Following (race pool)

**Versi implementasi:** TrendSurgeUmbrella race-to-confirm (Sprint 12)  
**Tier:** FORGE+  
**Racers:** `TS_TF` (Trend Following), `TS_MS` (Dow Theory), `TS_VP` (Auction Market Theory)  
**Filosofi (TF racer):** Multi-TF — HTF trend (4h) → MTF momentum (15m) → entry retracement (5m).

### 5.1 Timeframe

| Parameter | Nilai |
|-----------|-------|
| `htfInterval` | 4h |
| `mtfInterval` | 15m |
| `entryInterval` | 5m |
| `mtfRatio` | 3 (15m/5m) |
| `htfRatio` | 48 (4h/5m) |
| `checkInterval` | 300 000 ms |

### 5.2 Indikator & Sinyal

| Parameter | Nilai | Keterangan |
|-----------|-------|------------|
| `emaTrendFast` / `Mid` / `Slow` | 9 / 21 / 50 | Struktur trend entry TF |
| `macdFastPeriod` / `Slow` / `Signal` | 12 / 26 / 9 | Momentum MTF |
| `rsiPeriod` | 14 | |
| `rsiOversold` / `Overbought` | 30 / 70 | |
| `rsiSlopePeriod` | 3 | |
| `minRsiSlope` | 0.5 | Slope RSI wajib > 0.5 (LONG) / < −0.5 (SHORT) |
| `htfTrendStrengthMin` | **0.65** | Kekuatan trend HTF minimum (v2.3) |
| `macdHistMinAtrFrac` | 0.10 | \|histogram\| ≥ 0.10 × ATR |
| `pullbackLookback` | 5 bar | Retracement ke EMA |
| `pullbackTol` | 0.001 (0.1%) | |
| `volSMAPeriod` | 20 | |
| `minVolRatio` | 1.0 | Volume ≥ 1× SMA |

**HTF alignment (v2.3):** LONG = EMA9 > EMA21 > EMA50 + harga > EMA200; SHORT = kebalikannya.

### 5.3 Risk & Exit

| Parameter | Nilai (runtime) | Keterangan |
|-----------|-----------------|------------|
| `riskPerTrade` | **0.012** (1.2%) | |
| `slMultiplier` | **1.3** | SL = 1.3 × ATR |
| `tpMultiplier` | **2.5** | TP = 2.5 × ATR |
| `leverage` | 2× | |
| `maxTradesPerDay` | **4** | |
| `maxDailyLossPct` | 0.06 | |
| `cooldownAfterLoss` | 5 menit (preset) / 45 menit (BotEngine fallback) | |
| `maxConsecLoss` | 3 | |
| `tpMode` | **partial** | Partial TP aktif |
| `partialProfitPct` | **0.5** (50%) | Tutup 50% di 1.5R |
| `trailingStopAtrMultiplier` | **0.8** | Trailing setelah partial |
| `maxBarsHeld` | 100 | Timeout force close |
| `breakEvenActivationPct` | 0.2 | SL → entry saat 20% TP tercapai |
| `minCapital` | Rp 10M | Rekomendasi tier MINT |

---

## 6. MD_MR — Mean Drift / Mean Reversion

**Versi implementasi:** layered pipeline (MD-SUB-01/02/03)  
**Tier:** MINT+  
**Filosofi:** Extremes Bollinger Bands + konfirmasi RSI; ADX regime gate; OB/FVG precision.

### 6.1 Indikator

| Parameter | Nilai | Keterangan |
|-----------|-------|------------|
| `bbPeriod` | 20 | Bollinger Bands |
| `bbStdDev` | 2.0 | |
| `rsiPeriod` | 14 | |
| `rsiOverbought` | 70 | SHORT setup |
| `rsiOversold` | 30 | LONG setup |
| `volSMAPeriod` | 20 | |
| `minVolRatio` | 0.8 | Volume ≥ 0.8× SMA |
| `confirmationBars` | 2 | 2 bar konfirmasi bounce/rejection |

### 6.2 Risk (runtime)

| Parameter | Nilai | Keterangan |
|-----------|-------|------------|
| `riskPerTrade` | **0.008** (0.8%) | |
| `slMultiplier` | **1.4** | SL = 1.4 × ATR |
| `tpMultiplier` | **3.2** | TP = 3.2 × ATR → RR ~1:2.3 |
| `leverage` | 1× | Tanpa leverage |
| `maxTradesPerDay` | **3** | |
| `maxConcurrentTrades` | 1 | Satu posisi MR per engine |
| `maxDailyLossPct` | 0.03 | |
| `cooldownAfterLoss` | **15 menit** | |
| `maxConsecLoss` | 2 | |
| `minCapital` | Rp 30M | Rekomendasi tier VAULT |
| `interval` | 15m | |
| `validateEntry` ATR | 0.15–4.0% | |
| `validateEntry` volume | ≥ 0.5× SMA | |

---

## 7. BS_BR — Breakout Storm / Breakout Retest

**Versi implementasi:** BreakoutTradingStrategy (v2.4+)  
**Tier:** VAULT  
**Filosofi:** Breakout level S&R 20-bar + konfirmasi retest; RR tinggi.

### 7.1 Level & Sinyal

| Parameter | Nilai | Keterangan |
|-----------|-------|------------|
| `lookbackBars` | 20 | High/low = resistance/support |
| `volumeMultiplier` | **1.3** | Breakout butuh ≥ 1.3× volume SMA |
| `retestWindow` | 5 bar | Retest harus terjadi ≤ N bar setelah breakout |
| `higherTf` | 4h | Deteksi level (via preset) |
| `interval` | 15m | Entry TF |
| `checkInterval` | 900 000 ms | |

### 7.2 Risk (runtime)

| Parameter | Nilai | Keterangan |
|-----------|-------|------------|
| `riskPerTrade` | **0.02** (2%) | |
| `slMultiplier` | **1.4** | SL = 1.4 × ATR |
| `tpMultiplier` | **5.5** | TP = 5.5 × ATR → RR ~1:4.0 |
| `leverage` | 1× | |
| `maxTradesPerDay` | **5** | |
| `maxDailyLossPct` | 0.08 | |
| `cooldownAfterLoss` | 5 menit | |
| `maxConsecLoss` | 3 | |
| `minCapital` | $100 | Minimum modal bot |

---

## 8. Strategi per Pair Tier (izin runtime)

| Tier pair | AF_SMC | TS_TF | MD_MR | BS_BR |
|-----------|:------:|:-----:|:-----:|:-----:|
| LIQUID | ✅ | ✅ | ✅ | ✅ |
| STABLE | ✅ | ✅ | ✅ | ✅ |
| SEMI_VOLATILE | ❌ | ✅ | ✅ | ❌ |
| VOLATILE | ❌ | ✅ | ✅ | ❌ |

Ditegakkan di `bots-afs.js` saat user memilih strategi + saat bot start.

---

## 9. Subscription Tier (akses strategi) — SSOT `tierConfig.js`

| Tier user | Entitlement keys (code) | Gen2 engines | Max posisi/simbol | Max posisi akun | Max active bots |
|-----------|-------------------------|--------------|-------------------|-----------------|-----------------|
| FOUNDRY | `ADAPTIVE_FUSION` | `AF_SMC` | 1 | 4 | 10 |
| FORGE | + `TREND_FOLLOWING` | `AF_SMC`, `TS_TF` | 2 | 8 | 25 |
| MINT | + `MEAN_REVERSION` | `AF_SMC`, `TS_TF`, `MD_MR` | 3 | 12 | 40 |
| VAULT | + `BREAKOUT_RETEST` | `AF_SMC`, `TS_TF`, `MD_MR`, `BS_BR` | 4 | 16 | 50 |

Sumber: `src/domain/tierConfig.js` (entitlement) · Gen2 normalize: `src/config/strategies.js`.

---

## 10. Catatan Implementasi

1. **Preset vs class config:** Bot runtime memuat preset dari `legacyStrategies.js`. Class strategy mendefinisikan default internal; beberapa field `getRiskConfig()` class **tidak** dipakai langsung oleh BotEngine — yang dipakai adalah `strat.*` dari preset.
2. **Partial TP (TS_TF):** Aktif bila `tpMode: "partial"`. Partial close di 1.5R, sisanya trailing 0.8×ATR.
3. **Fee guards:** `minEdgeFeeMultiple` dan `maxEntryExtensionATR` mencegah entry dengan edge tipis yang ditelan fee.
4. **Pair override:** `slMultiplier` tier **mengalikan** lebar SL strategi; `positionSizeAdjustment` memperkecil ukuran posisi.
5. **AF/TS combination:** Default race-to-confirm (Sprint 12); voting/gate modes retained as rollback flags.

---

**Terakhir diperbarui:** 11 Juli 2026 — Gen2 naming + tier table SSOT (`tierConfig.js`)
