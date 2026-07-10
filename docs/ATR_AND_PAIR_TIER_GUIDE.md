# Penentuan ATR per Coin & Klasifikasi Tier Pair (Liquid / Stable / Volatile)

> Dokumen ini menjelaskan **dari mana** nilai ATR setiap coin berasal dan **bagaimana** sebuah coin dinilai sebagai LIQUID, STABLE, SEMI_VOLATILE, atau VOLATILE di Quantara.
>
> Sumber kode (source of truth runtime):
> - ATR: `src/domain/indicators.js` → `calcATR()`
> - Klasifikasi: `src/infrastructure/classification/PairClassifier.js`
> - Spesifikasi lengkap scoring: `docs/PAIR_VOLATILITY.md`

---

## 1. Apa itu ATR dan Bagaimana Dihitung per Coin

**ATR (Average True Range)** mengukur rata-rata pergerakan harga sebuah coin dalam satu candle — bukan arah, hanya *besaran*. Coin dengan ATR% tinggi berarti harganya bergerak liar; ATR% rendah berarti tenang.

### Rumus (Wilder's smoothing, period 14)

```
True Range (TR) per bar = max(
  high − low,                  // range bar itu sendiri
  |high − close sebelumnya|,   // gap naik
  |low  − close sebelumnya|    // gap turun
)

ATR pertama = rata-rata 14 TR pertama
ATR berikut = (ATR sebelumnya × 13 + TR baru) / 14
```

Implementasi: `calcATR(highs, lows, closes, period = 14)` di `indicators.js:66`.

### ATR dihitung PER COIN dan PER TIMEFRAME

ATR **tidak pernah statis** — dihitung ulang dari candle OHLCV coin itu sendiri pada timeframe entry masing-masing komponen strategi:

| Strategi / Komponen | Entry TF | ATR yang dipakai |
|---|---|---|
| SMC Scalping (A) | 5m | ATR14 dari candle 5m coin tsb |
| SMC Intraday (B) | 15m | ATR14 dari candle 15m coin tsb |
| SMC Swing (C) | 4h | ATR14 dari candle 4h coin tsb |
| Trend Following | 5m (konfirmasi 15m/1h) | ATR14 dari candle 5m |
| Mean Reversion A/B | 5m / 15m | ATR14 per TF |
| Breakout Trading | multi-TF | ATR14 per TF aktif |

Karena itu, **SL/TP dalam satuan ATR otomatis menyesuaikan karakter tiap coin**: `SL = 1.5×ATR` di BTC (ATR% ~0.5% di 15m) menghasilkan stop ±0.75%, sedangkan di altcoin volatil (ATR% ~3%) menghasilkan stop ±4.5% — proporsional terhadap noise masing-masing.

### ATR Ratio (Relative ATR) — pengganti threshold absolut

Threshold ATR% absolut (mis. "tolak entry jika ATR% < 0.8% atau > 5%") punya cacat struktural: angka yang sama tidak berlaku adil untuk semua coin dan semua rezim. ATR% 0.7% adalah pasar mati untuk altcoin, tapi kondisi normal untuk BTC — gate absolut membuat timeframe kecil BTC hampir tidak pernah lolos (terbukti pada insiden AF-SCALP-02: gate 0.8–5% yang dikalibrasi di 1h membuat 5m tidak pernah entry kecuali flash crash).

Pendekatan yang dipakai sekarang adalah **Relative ATR** — membandingkan ATR bar saat ini terhadap baseline historis coin itu sendiri:

```
ATR Ratio = ATR saat ini / rata-rata rolling ATR 100 bar
```

Interpretasi rezim (self-normalizing, berlaku untuk semua coin dan semua TF):

| ATR Ratio | Rezim | Perlakuan |
|---|---|---|
| **< 0.6** | Quiet Market | Skip entry — pergerakan terlalu kecil untuk membayar fee & spread |
| **0.6 – 1.8** | Normal | Entry diizinkan (zona operasi standar) |
| **1.8 – 3.0** | Expansion | Entry diizinkan dengan hati-hati — volatilitas melebar, SL berbasis ATR ikut melebar otomatis |
| **> 3.0** | Extreme | Skip entry — kondisi anomali (news event, liquidation cascade); estimasi risiko tidak reliable |

**Alasan desain:** baseline rolling 100-bar membuat ambang ini *adaptif per coin per TF* tanpa kalibrasi manual. Coin yang secara natural liar punya baseline tinggi, sehingga ratio-nya tetap ~1.0 di kondisi normalnya sendiri. Ambang 0.6/1.8/3.0 adalah rasio terhadap kebiasaan coin itu — bukan angka absolut yang harus dikalibrasi ulang setiap kali market berubah rezim. Implementasi: flag `atrGateRelative` (bar ATR vs rolling 100-bar baseline).

### ATR% (dinormalisasi)

Untuk membandingkan antar coin (kebutuhan klasifikasi tier, bukan entry gate), ATR tetap diubah ke persen harga:

```
ATR% = (ATR / harga penutupan) × 100
```

ATR% dipakai di dua tempat:
1. **Klasifikasi tier pair** (bagian berikutnya) — sebagai salah satu input hybrid score.
2. **Entry gate** — melalui ATR Ratio relatif di atas, bukan ambang absolut.

---

## 2. Dari Mana Penilaian LIQUID / STABLE / VOLATILE Berasal

Klasifikasi dilakukan oleh **`PairClassifier`** menggunakan **Hybrid Volatility Score v2.x** — sebuah skor 0.0–1.0 yang menggabungkan tiga metrik utama + penyesuaian kontinu.

### 2.1 Komponen skor (dengan bobot)

| Metrik | Bobot | Sumber data | Range normalisasi | Artinya |
|---|---|---|---|---|
| **HV blend** (HV7/HV14/HV30) | **40%** | Candle harian coin | 20 → 120 | Volatilitas realisasi multi-horizon |
| **ATR%14** | **35%** | Candle coin (lihat §1) | 0.5% → 6.0% | Besaran gerak harian saat ini |
| **Liquidity Ratio** = volume 24h ÷ market cap | **25%** (inverted) | CoinGecko | 0.001 → 0.15 (dibalik) | Semakin kecil rasio → semakin berbahaya (thin book) |

```
score = (HV_blend_norm × 0.40) + (ATR%_norm × 0.35) + (Liq_norm_inverted × 0.25)
```

**HV blend — kenapa bukan HV30 saja.** HV30 tunggal terlalu lamban untuk crypto: coin yang meledak volatilitasnya minggu ini masih terlihat "tenang" di HV30 selama ±3 minggu, sehingga klasifikasi telat justru saat paling dibutuhkan. Blend multi-horizon menyeimbangkan responsivitas dan stabilitas:

```
HV_blend = (HV7 × 0.5) + (HV14 × 0.3) + (HV30 × 0.2)
```

- **HV7 (bobot 50%)** — deteksi cepat perubahan rezim (crypto berpindah rezim dalam hitungan hari, bukan bulan).
- **HV14 (bobot 30%)** — jembatan; meredam noise HV7 pada spike 1–2 hari.
- **HV30 (bobot 20%)** — jangkar jangka menengah; dipertahankan agar spike sesaat tidak membuat coin blue-chip terlempar tier.

Dengan blend ini, coin yang volatilitasnya meledak terdeteksi dalam ~1 minggu (bukan ~1 bulan), sementara satu hari liar tidak cukup untuk memindahkan tier.

### 2.2 Penyesuaian kontinu (menggantikan soft adjustment ber-threshold)

Versi lama memakai step function (`beta > 1.8 → +0.08`, `rank > 150 → +0.10`, `ATR30 > 4.5% → naik 1 tier`). Masalah matematisnya: **diskontinuitas di sekitar ambang** — coin dengan beta 1.79 dan 1.81 diperlakukan sangat berbeda padahal secara risiko hampir identik, dan coin bisa bolak-balik tier ("tier flapping") hanya karena noise kecil di sekitar ambang. Semua penalti kini fungsi kontinu:

**Beta penalty (linear scaling, saturasi di 2.5):**

```
betaPenalty = 0.08 × clamp((beta − 1.0) / 1.5, 0, 1)
```

Beta 1.0 (bergerak seirama BTC) → +0. Beta 1.75 → +0.04. Beta ≥ 2.5 → +0.08 penuh. Transisi mulus, tidak ada lompatan di satu angka ajaib.

**Rank penalty (logarithmic scaling):**

```
rankPenalty = 0.10 × clamp(log10(rank / 50) / log10(6), 0, 1)
```

Rank ≤ 50 → +0. Rank 100 → +0.039. Rank 150 → +0.061. Rank ≥ 300 → +0.10 penuh. Skala logaritmik dipilih karena perbedaan risiko rank 50→100 jauh lebih signifikan daripada 250→300 — likuiditas market cap menurun secara eksponensial, bukan linear, terhadap rank.

**ATR% ekstrem (continuous penalty, menggantikan "bump 1 tier"):**

```
atrPenalty = 0.15 × clamp((ATR%30d − 3.5) / 3.0, 0, 1)
```

ATR%30d ≤ 3.5% → +0. ATR%30d 5% → +0.075. ATR%30d ≥ 6.5% → +0.15 penuh (setara ~1 tier). Ini menggantikan aturan lama "ATR30 > 4.5% → naik 1 level" yang membuat coin di 4.49% vs 4.51% berbeda satu tier penuh.

```
score_final = clamp(score + betaPenalty + rankPenalty + atrPenalty, 0, 1)
```

Satu-satunya aturan diskrit yang dipertahankan: **likuiditas di bawah ambang minimum → paksa VOLATILE**. Ini fail-safe keselamatan (thin order book = slippage tak terukur), bukan penyesuaian gradual — di sini lompatan memang disengaja.

### 2.3 Ambang tier (threshold)

| Skor akhir | Tier | Risk level |
|---|---|---|
| **< 0.48** | 🔵 **LIQUID** | LOW |
| **0.48 – 0.65** | 🟢 **STABLE** | MEDIUM |
| **0.66 – 0.78** | 🟡 **SEMI_VOLATILE** | HIGH-MED |
| **> 0.78** | 🔴 **VOLATILE** | HIGH |

**Dari mana angka 0.48 / 0.65 / 0.78 berasal.** Ambang ini bukan angka acak — berasal dari **kalibrasi distribusi historis** terhadap universe top-250 CoinGecko (spesifikasi PAIR_VOLATILITY.md v2.0→v2.3):

1. **Distribusi skor** dihitung untuk seluruh universe pada data 2023–2024; ambang dipasang sehingga keanggotaan tier cocok dengan ground truth yang diketahui — top-10 blue-chip (BTC/ETH/SOL dst.) harus jatuh di LIQUID, dan micro-cap thin-book yang secara historis menyebabkan slippage besar harus jatuh di VOLATILE.
2. **0.48** = pemisah blue-chip: persentil skor di mana kluster top-10 by volume terpisah dari mid-cap.
3. **0.78** = risk calibration dari sisi kerugian: di atas skor ini, backtest strategi voting (AF) menunjukkan over-trading dan drawdown tidak proporsional — maka AF diblokir mulai ambang ini.
4. **0.65** ditambahkan belakangan (v2.3) sebagai transisi SEMI_VOLATILE karena gap STABLE→VOLATILE terlalu lebar — coin rank 61–150 (WLD, HYPE, ENA, TAO) tidak cocok di kedua sisi.

Ambang ini **perlu dikalibrasi ulang secara periodik** (rekomendasi: per kuartal) karena distribusi volatilitas market crypto bergeser antar cycle. Karena semua penyesuaian kini kontinu (§2.2), sensitivitas terhadap posisi ambang jauh lebih rendah daripada versi step-function.

### 2.4 Confidence Score — seberapa dapat dipercaya klasifikasi ini

Setiap hasil klasifikasi menyertakan **confidence 0–100%** yang mencerminkan kualitas data di baliknya. Tier yang sama bisa punya keandalan sangat berbeda tergantung jalur data yang dipakai.

```
confidence = basis_jalur_data − penalti_kelengkapan − penalti_kesegaran
```

| Faktor | Nilai |
|---|---|
| **Basis: Jalur 1** — candle OHLCV sendiri (HV blend + ATR%14 + liquidity asli) | 95 |
| **Basis: Jalur 2** — CoinGecko real-time (liquidity asli, HV/ATR proxy) | 70 |
| **Basis: Jalur 3** — tabel statis darurat | 40 |
| Penalti: tiap metrik utama yang hilang/di-proxy (HV, ATR, liquidity) | −10 per metrik |
| Penalti: data CoinGecko lebih tua dari 1× TTL (2 jam) | −5 |
| Penalti: skor jatuh ≤ 0.03 dari ambang tier (zona rawan flapping) | −10 |

Contoh interpretasi:

| Kasus | Confidence | Makna |
|---|---|---|
| BTC, candle lengkap, skor 0.32 (jauh dari ambang) | ~95% → **LIQUID (92%)** | Klasifikasi sangat andal |
| WLD, CoinGecko path, skor 0.67 (dekat ambang 0.66) | ~60% → **SEMI_VOLATILE (60%)** | Andal sedang; pantau, jangan agresif |
| Coin baru listing, fallback statis | ~40% → **VOLATILE (40%)** | Label default, bukan pengukuran |

**Konsumsi confidence oleh engine:** confidence < 60% → engine memperlakukan coin satu tingkat lebih konservatif dari tier-nya (size mengikuti tier di atasnya) sampai data membaik. Confidence bukan kosmetik — ia adalah pengganti eksplisit dari kebiasaan lama "berpura-pura yakin" saat data sebenarnya proxy.

---

## 3. Sumber Data: 3 Jalur dengan Fallback

`PairClassifier.determineTier()` mencoba tiga jalur berurutan:

```
┌─ Jalur 1 (PRIMARY): metrics dari candle sendiri ─────────────┐
│  HV7/14/30 + ATR%14 + liquidityRatio dihitung dari OHLCV     │
│  → hybrid score penuh (confidence basis 95)                  │
└──────────────────────────┬───────────────────────────────────┘
                           │ tidak tersedia?
┌─ Jalur 2 (SECONDARY): CoinGecko real-time ───────────────────┐
│  Top-250 coins, refresh tiap 2 jam (hemat free tier)         │
│  liquidityRatio = volume24h / marketCap (data asli)          │
│  HV/ATR: proxy range-based (lihat §"ATR Proxy" di bawah)     │
│  → confidence basis 70, turun per metrik yang di-proxy       │
└──────────────────────────┬───────────────────────────────────┘
                           │ CoinGecko down?
┌─ Jalur 2.5 (OHLCV RESCUE): hitung sendiri dari exchange ─────┐
│  Bila CoinGecko gagal TAPI candle exchange tersedia:         │
│  hitung ATR + HV dari OHLCV, volume 24h dari candle 1h/1d    │
│  → estimasi tier dari data riil, confidence dikurangi        │
│  (liquidity pakai volume exchange, bukan agregat pasar)      │
└──────────────────────────┬───────────────────────────────────┘
                           │ candle juga tidak ada?
┌─ Jalur 3 (EMERGENCY): tabel statis ──────────────────────────┐
│  LIQUID: BTC, ETH, SOL, BNB, XRP, ADA, DOGE, TRX, LINK, LTC  │
│  Simbol lain yang tidak dikenal → VOLATILE (fail-safe        │
│  konservatif), confidence 40 — label default, bukan hasil    │
│  pengukuran                                                  │
└───────────────────────────────────────────────────────────────┘
```

**Prinsip Jalur 2.5 (perbaikan dari perilaku lama):** kegagalan CoinGecko tidak boleh langsung menjatuhkan coin ke label VOLATILE bila bot sedang memegang candle OHLCV coin tersebut — ATR, HV, dan volume bisa dihitung sendiri dari data itu. VOLATILE-by-default hanya untuk kasus **benar-benar buta data**. Ini mencegah insiden "CoinGecko outage 30 menit → semua pair blue-chip tiba-tiba dipaksa size 55% + AF terblokir".

**ATR Proxy (Jalur 2) — batasan yang diakui.** Formula lama `ATR ≈ |24h change| × 1.2 + 0.8` menyesatkan secara konsep: perubahan harga 24h adalah *net displacement*, bukan *range*. Coin bisa naik-turun 5% berkali-kali dan ditutup +0.2% — proxy lama membacanya "tenang". Pendekatan fallback yang lebih realistis, berurutan:

1. **Range-based**: bila CoinGecko menyediakan `high_24h`/`low_24h`, pakai `rangePct = (high − low) / close × 100` sebagai proxy ATR% harian — ini mengukur range sungguhan, lalu dikonversi kasar ke ATR%14 harian (`ATR% ≈ rangePct × 0.7`, karena range 1 hari biasanya melebihi rata-rata TR yang di-smooth).
2. **Displacement-based** (data minimum): bila hanya ada `priceChange24h`, pakai sebagai *lower bound* volatilitas — dan **turunkan confidence 10 poin** alih-alih berpura-pura itu ATR yang sebenarnya.

Aturan umumnya: **jika data tidak cukup, yang menurun adalah confidence — bukan memaksakan estimasi yang terlihat presisi.**

Catatan simbol: `_baseOf()` menormalkan simbol exchange ke ticker CoinGecko — `"1000BONKUSDT"` → `BONK`, `"BTCUSDT"` → `BTC`. Stablecoin (USDT, USDC, DAI, dll.) di-skip dari klasifikasi.

---

## 4. Konsekuensi Tier: Apa yang Berubah per Coin

Tier pair **bukan label kosmetik** — ia mengubah parameter risk dan strategi yang boleh jalan.

### 4.1 Override parameter risk

Parameter risiko utama (SL multiplier & position size) kini **fungsi kontinu dari volatility score**, bukan tabel step per tier. Alasannya sama dengan §2.2: dua coin di skor 0.64 dan 0.67 nyaris identik risikonya — melompatkan SL dari 1.1× ke 1.3× dan size dari 95% ke 75% di antara keduanya menciptakan diskontinuitas artifisial dan tier flapping yang mengubah sizing drastis tanpa perubahan risiko nyata.

**SL Multiplier (linear terhadap score, clamp 1.0–1.5):**

```
slMultiplier = 1.0 + 0.5 × clamp((score − 0.40) / 0.45, 0, 1)
```

| Score | SL Multiplier |
|---|---|
| ≤ 0.40 | 1.00× |
| 0.48 (batas LIQUID) | 1.09× |
| 0.65 | 1.28× |
| 0.78 | 1.42× |
| ≥ 0.85 | 1.50× |

Nilai di ambang tier lama (≈1.1 / ≈1.3 / ≈1.5) tetap tercapai — perilaku agregat sama, transisinya yang jadi mulus.

**Position Size Adjustment (linear terhadap score, clamp 0.55–1.0):**

```
positionSize = 1.0 − 0.45 × clamp((score − 0.45) / 0.40, 0, 1)
```

| Score | Position Size |
|---|---|
| ≤ 0.45 | 100% |
| 0.55 | 89% |
| 0.65 | 78% |
| 0.78 | 63% |
| ≥ 0.85 | 55% |

Contoh perhitungan: coin dengan score 0.70 → `slMultiplier = 1.0 + 0.5 × (0.30/0.45) = 1.33×`, `positionSize = 1.0 − 0.45 × (0.25/0.40) = 72%`. Tidak ada satu titik pun di mana pergeseran skor 0.01 mengubah sizing lebih dari ~1.5%.

Parameter yang **tetap diskrit per tier** (memang bersifat kebijakan, bukan besaran kontinu):

| Parameter | 🔵 LIQUID | 🟢 STABLE | 🟡 SEMI_VOL | 🔴 VOLATILE |
|---|---|---|---|---|
| **Max trades/hari** | ∞ | 8 | 6 | **4** |
| **Daily loss cap** | — | — | 2.5% | **3%** |
| **HTF regime filter** | opsional | wajib | wajib | **wajib** |
| **AF voting threshold** | default | 0.60 | 0.70 | **0.78** |

> `pairSlMultiplier` ini **diterapkan juga di backtest** (live parity, fix 2026-07-03) — jadi hasil backtest BTC vs altcoin sudah mencerminkan SL yang berbeda.

### 4.2 Strategi yang direkomendasikan / diblokir

| Tier | ✅ Direkomendasikan | ⚠️ Hati-hati | ❌ Diblokir |
|---|---|---|---|
| 🔵 LIQUID | AF_SMC, TF, MR | BR | — |
| 🟢 STABLE | AF_SMC, MR | TF, BR | — |
| 🟡 SEMI_VOLATILE | MR, TF | BR | **AF_SMC** |
| 🔴 VOLATILE | MR, TF (regime filter ketat) | — | **AF_SMC, BR** |

Alasan blokir AF_SMC di pair volatil: struktur SMC (sweep→CHoCH→FVG) di thin-book altcoin dipenuhi false signal — voting engine-nya rentan over-trading.

---

## 5. Contoh Perhitungan

### Contoh A — BTCUSDT (blue-chip)

```
HV7 = 42, HV14 = 44, HV30 = 45
HV_blend = 42×0.5 + 44×0.3 + 45×0.2 = 43.2
HV norm (20–120)   = 0.23 × 0.40 = 0.093
ATR%14 = 1.2%      → norm (0.5–6.0)  = 0.13 × 0.35 = 0.045
LiqRatio = 0.045   → inverted norm    = 0.70 × 0.25 = 0.176
Beta 1.0 → penalty 0 | Rank 1 → penalty 0 | ATR%30d 1.3% → penalty 0
─────────────────────────────────────────────────────
Score ≈ 0.31  →  < 0.48  →  🔵 LIQUID
slMultiplier = 1.00× | positionSize = 100%
Confidence: jalur 1, data lengkap, jauh dari ambang → ~95%
```

### Contoh B — altcoin mid-cap (mis. WLD)

```
HV7 = 95, HV14 = 88, HV30 = 82
HV_blend = 95×0.5 + 88×0.3 + 82×0.2 = 90.3
HV norm            = 0.70 × 0.40 = 0.281
ATR%14 = 4.0%      → norm = 0.64 × 0.35 = 0.223
LiqRatio = 0.08    → inverted = 0.47 × 0.25 = 0.118
Beta 2.1  → 0.08 × (1.1/1.5)         = +0.059
Rank 120  → 0.10 × log10(2.4)/log10(6) = +0.049
ATR%30d 4.2% → 0.15 × (0.7/3.0)      = +0.035
─────────────────────────────────────────────────────
Score ≈ 0.77  →  0.66–0.78  →  🟡 SEMI_VOLATILE
slMultiplier = 1.41× | positionSize = 64%
Confidence: jalur 1 tapi skor 0.01 dari ambang 0.78 → ~85 − 10 = 75%
→ AF_SMC diblokir, max 6 trade/hari
```

Perhatikan: HV7 tinggi (95 vs HV30 82) menandakan volatilitas *sedang naik* — blend menangkapnya minggu ini; HV30 tunggal baru akan menaikkannya ~3 minggu lagi.

### Contoh C — micro-cap rank 280

```
Score dasar 0.70
Rank 280 → 0.10 × log10(5.6)/log10(6) = +0.096
Beta 2.6 → +0.08 (saturasi)
─────────────────────────────────────────────────────
Score ≈ 0.88  →  > 0.78  →  🔴 VOLATILE
slMultiplier = 1.50× | positionSize = 55%
→ hanya MR/TF dengan regime filter, cap loss harian 3%
```

---

## 6. FAQ

**Q: Apakah tier sebuah coin bisa berubah?**
Ya. Data CoinGecko di-refresh tiap 2 jam, dan hybrid metrics (ATR%/HV blend) dihitung dari candle terbaru. Karena penalti kini kontinu, perpindahan tier terjadi secara bertahap mengikuti skor — bukan melompat karena satu metrik menyeberangi angka ajaib. Coin yang volatilitasnya naik terdeteksi dalam ~1 minggu via HV7.

**Q: Kenapa coin yang tidak dikenal langsung VOLATILE?**
Fail-safe konservatif — tapi hanya bila **benar-benar buta data** (CoinGecko gagal DAN candle exchange tidak tersedia). Bila OHLCV ada, tier diestimasi dari ATR/HV/volume yang dihitung sendiri (Jalur 2.5) dengan confidence dikurangi. Label darurat selalu terlihat dari confidence-nya yang rendah (40%).

**Q: Apa beda "pair tier" dengan tier langganan (FOUNDRY/FORGE/MINT/VAULT)?**
Beda total. Pair tier = klasifikasi risiko coin. Subscription tier = paket langganan user yang menentukan strategi apa yang bisa diakses. Keduanya kebetulan sama-sama disebut "tier".

**Q: ATR dipakai di mana saja selain klasifikasi?**
1. **SL/TP sizing** — semua strategi memakai `SL = slMult × ATR`, `TP = tpMult × ATR`, dengan `slMult` kini fungsi kontinu dari volatility score (§4.1).
2. **Entry gate** — ATR Ratio relatif (bar ATR vs rolling 100-bar baseline, rezim Quiet/Normal/Expansion/Extreme) — bukan ambang absolut.
3. **Trailing stop** — trail distance dalam kelipatan ATR.
4. **Daily Regime Gate** — proxy ADX memakai |EMA9−EMA21|/ATR untuk deteksi chop.

**Q: Seberapa sering ambang 0.48/0.65/0.78 dan parameter kontinu perlu dikalibrasi ulang?**
Rekomendasi per kuartal, atau setelah pergeseran rezim market besar (bull→bear atau sebaliknya): jalankan ulang distribusi skor pada universe top-250 dan verifikasi kluster blue-chip masih di bawah 0.48. Karena fungsi penalti kontinu, drift kecil pada distribusi tidak lagi menyebabkan perubahan tier mendadak.

---

*Dokumen dibuat 2026-07-06, direvisi 2026-07-06 (dynamic ATR review: relative ATR gate, HV blend, continuous penalties, OHLCV rescue fallback, confidence score). Rujukan: PairClassifier.js (runtime source of truth), PAIR_VOLATILITY.md v2.3 (spesifikasi), indicators.js (calcATR).*
