# Klasifikasi Volatilitas Koin (Pair Tier) — Hybrid Real-Time CoinGecko

**Versi:** 2.1 (Full Real API + Hybrid Score)  
**Update:** Juni 2026  
**Tujuan:** Klasifikasi otomatis berdasarkan data real-time CoinGecko tanpa manual list sebanyak mungkin.

---

## 1. Ringkasan Tier (Hybrid Score)

| Tier              | Hybrid Score Range | Karakteristik                          | Contoh (real-time)              | Strategi yang Diizinkan          |
|-------------------|--------------------|----------------------------------------|---------------------------------|----------------------------------|
| **LIQUID**        | < 0.48             | Blue-chip, likuiditas sangat tinggi    | BTC, ETH, SOL, BNB              | Semua strategi                   |
| **STABLE**        | 0.48 – 0.65        | Mid-large cap, volatilitas terkendali  | AVAX, ADA, XRP, NEAR            | AF, TM, MR                       |
| **SEMI_VOLATILE** | 0.66 – 0.78        | Volatilitas tinggi meski cap besar     | WLD, HYPE, LAB, ENA, TAO        | TM + MR (AF dibatasi)            |
| **VOLATILE**      | > 0.78             | Likuiditas rendah, microcap, coin baru | Meme coins, GRASS, listing baru | Hanya MR                         |

---

## 2. Hybrid Volatility Score (Real API Based)

**Method Utama di `PairClassifier.js`:**

```javascript
/**
 * Hybrid Volatility Score - dihitung dari data real CoinGecko
 */
async calculateHybridVolatilityScore(symbol) {
  const cgData = await this.fetchCoinGeckoMarketData(symbol);     // market cap, volume, rank
  const historicalPrices = await this.fetchHistoricalPrices(symbol, 30); // 30 hari price data

  const hv30 = this.calculateHV(historicalPrices, 30);           // Historical Volatility
  const atrPercent14 = this.calculateATRPercent(historicalPrices, 14);
  const liquidityRatio = cgData.volume24h / cgData.marketCap;

  let score = 
    (this.normalize(hv30, 20, 120) * 0.40) +
    (this.normalize(atrPercent14, 0.5, 6.0) * 0.35) +
    (this.normalizeInverted(liquidityRatio, 0.001, 0.15) * 0.25);

  // Soft adjustment dari market cap rank
  if (cgData.marketCapRank > 150) score += 0.10;

  score = Math.min(Math.max(score, 0), 1.0);

  if (score > 0.78) return 'VOLATILE';
  if (score > 0.65) return 'SEMI_VOLATILE';
  if (score > 0.48) return 'STABLE';
  return 'LIQUID';
}