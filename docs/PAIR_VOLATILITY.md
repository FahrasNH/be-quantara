# Klasifikasi Volatilitas Koin (Pair Tier) — Versi Hybrid Optimasi

**Versi:** 2.0 (Hybrid HV + ATR + Liquidity)  
**Tanggal Update:** Juni 2026  
**Tujuan:** Meningkatkan win rate ke 40–45%, menjaga average loss <1.2%, dan Actual R:R ≥ 1:2 dengan klasifikasi yang lebih akurat dan adaptif.

**Sumber kebenaran:** `src/infrastructure/classification/PairClassifier.js`

---

## 1. Ringkasan 4 Tier (Hybrid)

| Tier              | Risk Level | Karakteristik                              | Contoh Koin                  | Hybrid Score Range |
|-------------------|------------|--------------------------------------------|------------------------------|--------------------|
| **LIQUID**        | LOW        | Blue-chip, likuiditas sangat tinggi        | BTC, ETH, SOL, BNB           | < 0.48             |
| **STABLE**        | MEDIUM     | Mid-large cap, volatilitas terkendali      | AVAX, ADA, XRP, NEAR         | 0.48 – 0.65        |
| **SEMI_VOLATILE** | HIGH-MED   | Volatilitas tinggi meski market cap besar  | **WLD, HYPE, LAB, ENA, TAO** | 0.66 – 0.78        |
| **VOLATILE**      | HIGH       | Altcoin kecil, meme, likuiditas rendah     | Microcap, coin baru, GRASS   | > 0.78             |

**Kelebihan Hybrid:**
- Coin baru otomatis terklasifikasi (tidak perlu manual entry).
- Menggabungkan **historical** (HV), **current** (ATR), dan **eksekusi risk** (Liquidity).
- Lebih akurat daripada hanya market cap rank CoinGecko.

---

## 2. Hybrid Volatility Score (Core Logic)

**Formula:**

```javascript
/**
 * Menghitung Hybrid Volatility Score (0.0 - 1.0)
 * @returns {string} 'LIQUID' | 'STABLE' | 'SEMI_VOLATILE' | 'VOLATILE'
 */
calculateHybridVolatilityScore(symbol, data) {
  const { hv30, atrPercent14, liquidityRatio, marketCapRank, betaToBTC } = data;

  // Normalisasi
  const hvScore = normalize(hv30, 20, 120);           // HV 30 hari
  const atrScore = normalize(atrPercent14, 0.5, 6.0); // ATR dalam persen
  const liqScore = normalizeInverted(liquidityRatio, 0.001, 0.15); // Semakin rendah = semakin berbahaya

  let score = 
    (hvScore * 0.40) + 
    (atrScore * 0.35) + 
    (liqScore * 0.25);

  // Adjustment tambahan
  if (betaToBTC > 1.8) score += 0.08;
  if (marketCapRank > 150) score += 0.10;

  score = Math.min(Math.max(score, 0), 1);

  if (score > 0.78) return 'VOLATILE';
  if (score > 0.65) return 'SEMI_VOLATILE';
  if (score > 0.48) return 'STABLE';
  return 'LIQUID';
}