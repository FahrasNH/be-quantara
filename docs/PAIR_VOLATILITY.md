# Klasifikasi Volatilitas Koin (Pair Tier) — Versi Dinamis Optimasi

**Filosofi Baru:** Klasifikasi **sepenuhnya dinamis** berdasarkan market cap rank CoinGecko + ATR historis 30 hari. Minim ketergantungan manual list.

---

## 3. Mode Dinamis (CoinGecko) — Diperkuat

**Refresh:** Setiap **2 jam** (dari 4 jam) + saat bot start.

**Aturan Rank yang Diperbarui (lebih granular):**

| Rank CoinGecko | Tier       | Catatan |
|----------------|------------|---------|
| ≤ 12           | **LIQUID** | Ultra blue-chip |
| 13 – 60        | **STABLE** | Mid-cap stabil |
| 61 – 150       | **SEMI_VOLATILE** (baru) | Transisi |
| > 150 atau tidak ada | **VOLATILE** | High risk |

**Tambahan Hybrid Metric:**
- Jika ATR% 30-hari > **4.5%** → naikkan tier 1 level (misal STABLE → VOLATILE).
- Liquidity score (24h volume) < threshold → paksa VOLATILE.

**Default unknown/new coin:** **VOLATILE** (fail-safe).

---

## 6. Dampak ke Strategi (Diperbarui)

### VOLATILE (termasuk SEMI_VOLATILE)
- **Direkomendasikan:** MEAN_REVERSION + TREND_MOMENTUM (dengan regime filter ketat)
- **Diblokir:** ADAPTIVE_FUSION (kecuali LIQUID/STABLE)

### Override Parameter Risk (Diperketat)

| Parameter                  | LIQUID | STABLE | SEMI_VOL | VOLATILE |
|---------------------------|--------|--------|----------|----------|
| `slMultiplier`            | 1.0×   | 1.1×   | 1.3×     | **1.5×** |
| `positionSizeAdjustment`  | 1.0    | 0.95   | 0.75     | **0.55** |
| `maxTradesPerDay`         | unlimited | 8   | 6        | **4**    |
| `dailyLossLimit`          | —      | —      | 2.5%     | **3%**   |
| `votingThresholdOverride` | —      | 0.60   | 0.70     | **0.78** |

---

**Perubahan Lain:**
- Tambah `SEMI_VOLATILE` tier untuk transisi yang lebih halus.
- HTF regime filter wajib untuk semua tier kecuali LIQUID.
- PairClassifier otomatis hitung ATR% historis untuk adjustment dinamis.

---

*Terakhir diperbarui: Juni 2026 — Dynamic Volatility + Risk Tightening untuk Win Rate Target*