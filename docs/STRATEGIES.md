# Dokumentasi Strategi & Parameter — Quantara Bot Trading

**Versi:** v2.4 (Optimasi Win Rate & Profit Factor) + Pair Tier v2.1  
**Update:** Juni 2026  
**Sumber kebenaran kode:** `src/domain/legacyStrategies.js` (preset runtime) → `BotEngine.js` → `src/domain/strategy/implementations/*.js`

> Parameter **efektif** di bot = preset `legacyStrategies` + fallback `BotEngine`, lalu di-override oleh **Pair Tier** (`PairClassifier.PARAM_OVERRIDES`) saat bot start. Lihat [PAIR_VOLATILITY.md](PAIR_VOLATILITY.md).

---

## 1. Ringkasan Perbandingan

| Strategi | Tier min. | Entry TF | HTF | SL×ATR | TP×ATR | RR target | Risk/trade | Leverage | Max trade/hari |
|----------|-----------|----------|-----|--------|--------|-----------|------------|----------|----------------|
| **ADAPTIVE_FUSION** | FOUNDRY | 15m | 1h | 1.0–2.2* | 2.8–3.3* | ~1:1.8–2.8 | **0.9%** | 2× | **8** |
| **TREND_MOMENTUM** | FORGE | 5m | 4h | **1.3** | **2.5** | ~1:1.92 | **1.2%** | 2× | **4** |
| **MEAN_REVERSION** | MINT | 15m | — | **1.4** | **3.2** | ~1:2.3 | **0.8%** | 1× | **3** |
| **BREAKOUT_RETEST** | VAULT | 15m | 4h | **1.4** | **5.5** | ~1:4.0 | **2.0%** | 1× | **5** |

\* AF: SL/TP per komponen A/B/C (lihat §4.3).

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
| `maxEntryExtensionATR` | 1.5 (AF preset **1.0**) | Tolak entry jika \|close − EMA9\| / ATR > N (anti-chase) |
| `strongTrendTPMult` | **1.5** (AF) | TP ×1.5 saat regime STRONG_TREND (AF only) |
| `afMinVotes` | **3** | Kuorum minimum komponen AF searah |
| `afRejectOnDissent` | `true` | Tolak entry AF bila komponen saling berlawanan |
| `atrMinMult` / `atrMaxMult` | 0.1–5.0 (per strategi) | Filter ATR% relatif terhadap harga |
| `volSmaMultiplier` | per strategi | Rasio volume minimum vs SMA volume |
| `checkInterval` | per strategi | Interval polling sinyal (ms) |

---

## 4. ADAPTIVE_FUSION (AF) - v2.4 Optimized

**Versi implementasi:** 2.4.0  
**Tier:** FOUNDRY+  
**Filosofi:** 3 sub-strategi (Scalp / Day / Swing) voting dengan **entry filter lebih ketat**; SL/TP mengikuti komponen pemenang + **dynamic TP extension**.

### Rekomendasi Utama dari Optimasi
- **Win rate target**: Naik ke ≥42% dengan tightening entry.
- **Profit Factor target**: Naik ke ≥1.45 dengan **take profit +50%** pada strong trend.
- **Trade Selection**: Tambah regime filter & minScore lebih tinggi.

### 4.1 Parameter Runtime (legacyStrategies → BotEngine) - Updated

| Parameter | Nilai Baru | Keterangan |
|-----------|------------|------------|
| `interval` | 15m | Timeframe entry utama |
| `higherTf` | 1h | HTF alignment **wajib** |
| `htfEmaFast` / `htfEmaSlow` | 9 / 21 | |
| `emaFast` / `emaSlow` / `emaTrend` | 9 / 21 / 50 | |
| `rsiPeriod` | 14 | |
| `rsiOverbought` / `rsiOversold` | 72 / 28 | **Diperketat** |
| `rsiLongMin`–`rsiLongMax` | **55–68** | Naik dari 50–70 (kurangi false long) |
| `rsiShortMin`–`rsiShortMax` | **32–45** | Diperketat |
| `atrPeriod` | 14 | |
| `atrMultiplier` | 1.5 | Fallback |
| `riskReward` | **2.3** | Naik dari 2.0 |
| `atrMinMult` / `atrMaxMult` | **0.7 / 3.5** | Gate ATR lebih ketat |
| `riskPerTrade` | **0.009** (0.9%) | Turun sedikit untuk safety |
| `maxDailyLossPct` | **0.045** | Override BotEngine |
| `maxTradesPerDay` | **8** | Turun dari 10 |
| `cooldownAfterLoss` | **45 menit** | Naik dari 30 menit |
| `maxConsecLoss` | **2** | Turun dari 3 |
| `leverage` | 2× | |
| `maxEntryExtensionATR` | **1.0** | Diperketat dari 1.2 |
| `minEdgeFeeMultiple` | **7** | Naik dari 6 |
| `afMinVotes` | **3** | Tetap |
| `afRejectOnDissent` | true | |
| `volSmaMultiplier` | **1.3** | Naik dari 1.0 (butuh volume lebih kuat) |
| `sidewaysRangeLookback` | 20 | |
| `sidewaysBreakoutVolMult` | **1.4** | Naik |
| `checkInterval` | 60 000 ms | |

### 4.2 Voting & Regime - Enhanced

| Parameter | Nilai Baru | Keterangan |
|-----------|------------|------------|
| `afMinVotes` | 3 | |
| `votingThresholdOverride` | tier-based | ... |
| `LOW_VOL` | **1.4%** ATR | Diperketat |
| `WEAK_TREND` | **0.55** | Naik dari 0.45 |
| `NORMAL_TREND` | 0.65 | |
| `STRONG_TREND` | 0.82 | |
| **New**: `strongTrendTPMult` | **1.5** | TP ×1.5 jika trend kuat (capture larger moves) |
| Regime `DEAD_MARKET` | — | **Blok entry ketat** |

### 4.3 Sub-Strategi A / B / C - Minor Adjustment

| Komponen | ... | SL×ATR | TP×ATR | RR | ... | minScore |
|----------|-----|--------|--------|----|-----|----------|
| **A** Scalp | ... | **2.2** | **3.2** | 1:1.45 | ... | **35** |
| **B** Day | ... | **1.6** | **3.3** | 1:2.1 | ... | **45** |
| **C** Swing | ... | **1.1** | **2.8** | 1:2.55 | ... | **40** |

**Aturan baru**: Pada **STRONG_TREND**, terapkan `strongTrendTPMult: 1.5` (TP distance ×1.5; SL tidak berubah).

### 4.4 Riwayat v2.4 (as-built)

- Preset: risk 0.9%, max 8 trade/hari, cooldown 45 mnt, maxConsecLoss 2
- Guards: `maxEntryExtensionATR` 1.0, `minEdgeFeeMultiple` 7, `volSmaMultiplier` 1.3
- Regime: LOW_VOL 1.4%, WEAK_TREND 0.55, STRONG_TREND 0.82
- Sub SL/TP/minScore naik; RSI B 55–68 / 32–45

---

## 5. TREND_MOMENTUM (TM)

**Versi implementasi:** 1.2.0  
**Tier:** FORGE+  
**Filosofi:** Multi-TF — HTF trend (4h) → MTF momentum (15m) → entry retracement (5m).

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

## 6. MEAN_REVERSION (MR)

**Versi implementasi:** 1.0.0  
**Tier:** MINT+  
**Filosofi:** Extremes Bollinger Bands + konfirmasi RSI; target mean reversion.

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

## 7. BREAKOUT_RETEST (BR)

**Versi implementasi:** 1.0.0  
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

| Tier pair | AF | TM | MR | BR |
|-----------|:--:|:--:|:--:|:--:|
| LIQUID | ✅ | ✅ | ✅ | ✅ |
| STABLE | ✅ | ✅ | ✅ | ✅ |
| SEMI_VOLATILE | ❌ | ✅ | ✅ | ❌ |
| VOLATILE | ❌ | ✅ | ✅ | ❌ |

Ditegakkan di `bots-afs.js` saat user memilih strategi + saat bot start.

---

## 9. Subscription Tier (akses strategi)

| Tier user | Strategi tersedia | Max posisi/simbol | Max posisi akun |
|-----------|-------------------|-------------------|-----------------|
| FOUNDRY | AF | 1 | 4 |
| FORGE | AF, TM | 2 | 8 |
| MINT | AF, TM, MR | 3 | 12 |
| VAULT | AF, TM, MR, BR | 4 | 16 |

Sumber: `src/domain/tierConfig.js`

---

## 10. Catatan Implementasi

1. **Preset vs class config:** Bot runtime memuat preset dari `legacyStrategies.js`. Class strategy (`TrendMomentumStrategy.js`, dll.) mendefinisikan default internal; beberapa field `getRiskConfig()` class **tidak** dipakai langsung oleh BotEngine — yang dipakai adalah `strat.*` dari preset.
2. **Partial TP (TM):** Aktif bila `tpMode: "partial"`. Partial close di 1.5R, sisanya trailing 0.8×ATR.
3. **Fee guards:** `minEdgeFeeMultiple` dan `maxEntryExtensionATR` mencegah entry dengan edge tipis yang ditelan fee.
4. **Pair override:** `slMultiplier` tier **mengalikan** lebar SL strategi; `positionSizeAdjustment` memperkecil ukuran posisi.

---

**Terakhir diperbarui:** Juni 2026 — Parameter lengkap v2.4 + Pair Tier v2.1
