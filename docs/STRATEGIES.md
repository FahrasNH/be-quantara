# Dokumentasi Strategi — Quantara Bot Trading (Versi Optimasi Performa v2.3)

**Tujuan Utama Versi Ini:** Win rate 40–45% | Avg Loss ≤ 1.15% | Actual R:R ≥ 1:2.0

**Catatan validasi:** Semua angka win rate berasal dari backtest historis + dry-run. Parameter telah di-tighten berdasarkan analisis loss pattern (terutama WLD, LAB, HYPE).

---

## 3. Ringkasan Perbandingan (Diperbarui)

| Strategi            | Tier min. | TF Entry | HTF   | SL×ATR     | TP×ATR   | RR Target | Risk/trade | Leverage | Max trade/hari |
|---------------------|-----------|----------|-------|------------|----------|-----------|------------|----------|----------------|
| **ADAPTIVE_FUSION** | FOUNDRY   | 15m      | 1h    | 1.0–1.3    | 2.5–3.5  | 1:2.2     | **1.0%**   | 1.5×     | **6**          |
| **TREND_MOMENTUM**  | FORGE     | 5m       | 4h    | **1.3**    | **2.5**  | **1:2.0+**| **1.2%**   | 1.5×     | **4**          |
| MEAN_REVERSION      | MINT      | 15m      | —     | 1.4        | 3.2      | 1:2.3     | 0.8%       | 1×       | 3              |
| BREAKOUT_RETEST     | VAULT     | 15m      | 4h    | 1.4        | 5.5      | 1:4.0     | 2%         | 1×       | 5              |

**Perubahan kunci:**
- Risk per trade diturunkan secara keseluruhan.
- SL lebih ketat + partial TP + trailing wajib.
- ADAPTIVE_FUSION voting lebih konservatif.

---

## 4. ADAPTIVE_FUSION (Optimasi Utama)

**Versi:** 2.3.0

**Perubahan untuk target win rate:**
- `afMinVotes`: **3** (dari 2) — butuh konsensus lebih kuat.
- `votingThresholdOverride`: VOLATILE = **0.75**, STABLE = **0.60**.
- `interpretMarketCondition`:
  - `LOW_VOL`: **1.2%** ATR
  - `WEAK_TREND`: **0.45** (dari 0.3)
- Risk per trade default: **1.0%** (dari 1.5%).
- SL wajib pakai komponen C logic (Swing) di VOLATILE pair.
- HTF (1h) alignment **wajib** sebelum voting.

---

## 5. TREND_MOMENTUM (Jadikan Core Strategy)

**Versi:** 1.2.0

**Optimasi:**
- HTF alignment: EMA9 > EMA21 > EMA50 **+** harga di atas/bawah EMA200.
- `htfTrendStrengthMin`: **0.65**
- `slMultiplier`: **1.3** (dari 1.2) — kurangi premature SL.
- `tpMultiplier`: **2.5**
- `partialProfitPct`: 50% di 1.5R + trailing 0.8×ATR.
- Max trade/hari: **4**

---

## 9. Parameter Global BotEngine (Diperketat)

**Risk Management Harian (baru):**
- `maxDailyLossPct`: **0.03** (3%)
- `maxRiskPerTrade`: **0.012**
- `cooldownAfterLoss`: **45 menit**
- `maxConsecLoss`: **3**

**Dynamic Position Sizing**: Selalu kalikan dengan `pairPositionSizeAdjustment` dari PairClassifier.

---

**Terakhir diperbarui:** Juni 2026 — Optimasi Win Rate & Risk (v2.3)