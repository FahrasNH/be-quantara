# 📈 Dokumentasi Strategi — Quantara Bot Trading

Empat strategi premium, masing-masing untuk tier modal berbeda. Semua multi-timeframe
opsional, berbasis indikator di `src/domain/indicators.js`, dieksekusi oleh
`BotEngine` (`src/application/BotEngine.js`).

> ⚠️ **Catatan validasi:** Angka WR/PF/return di bawah berasal dari **backtest data
> SINTETIS** (mock candle ber-seed). Belum divalidasi dengan OHLCV nyata. Target WR
> tinggi pada RR besar sering tidak realistis (breakeven WR = 1/(1+RR)). Lakukan
> validasi data nyata sebelum live.

---

## Ringkasan

| Strategi | Tier | TF entry | SL×ATR | TP×ATR | RR | Risk/trade | Leverage | Max trade/hari |
|----------|------|----------|--------|--------|-----|-----------|----------|----------------|
| ADAPTIVE_FUSION | FOUNDRY/FORGE | 15m | adaptif | adaptif | ~1:2.0 | 1.5–3% | 1–2× | — |
| TREND_MOMENTUM | MINT | 5m | 1.2 | 2.3 | 1:1.92 | 2% | 1.5× | 6 |
| MEAN_REVERSION | VAULT | 15m | 1.0 | 3.0 | 1:3.0 | 1% | 1× | 3 |
| BREAKOUT_RETEST | FOUNDRY | 15m | 1.5 | 6.0 | 1:4.0 | 3% | 2× | 7 |

---

## 1. TREND_MOMENTUM (MINT) — `TrendMomentumStrategy.js`

**Filosofi:** Ikut tren kuat dengan konfirmasi momentum. *Quality over frequency*
(~50–60 trade/tahun).

**3 lapis konfirmasi:**
1. **HTF (4h):** arah tren via EMA — LONG bila `close > EMA21 > EMA50` **dan** `EMA9 > EMA21` (struktur uptrend penuh).
2. **MTF (15m):** momentum via MACD histogram + RSI. Gate momentum minimum `|histogram| ≥ 0.10×ATR` (scale-invariant) + RSI slope `> +0.5` (LONG) / `< −0.5` (SHORT).
3. **Entry (5m):** **pullback nyata** — harga retrace menyentuh EMA9 dalam 5 bar terakhir lalu reclaim; RSI dalam zona sehat 30–70; volume ≥ 1.0× SMA.

**Parameter kunci:** `slMultiplier 1.2`, `tpMultiplier 2.3`, `riskPerTrade 0.02`,
`leverage 1.5`, `minRsiSlope 0.5`, `macdHistMinAtrFrac 0.10`, `pullbackLookback 5`,
`maxBarsHeld 100`, `breakEvenActivationPct 0.2`.

**Manajemen exit:** break-even di 20% TP, trailing 0.8×ATR setelah 50% TP, timeout 100 bar.

**Edge cases:**
- HTF/MTF array tak disediakan → fallback ke proxy entry-TF (MACD dari `calcIndicators`).
- HTF reversal → `resetTrendState()` (cegah entry sisa tren lama).
- `lastIdx < 50` → null (warmup indikator).

---

## 2. MEAN_REVERSION (VAULT) — `MeanReversionStrategy.js`

**Filosofi:** Trade ekstrem statistik via Bollinger Bands; harga cenderung kembali
ke mean. Ultra-konservatif.

**Entry:**
- **LONG:** harga di **separuh bawah** band (zona ≤ `lower + 0.5×bandwidth`), RSI oversold `< 30` (tapi ≥ 15, hindari panic), volume normal (≥0.8× SMA, bukan panic >2×), ada confirmation bar (close > prev).
- **SHORT:** mirror di band atas, RSI overbought `> 70` (≤ 85).

**TP:** `max(3×ATR, BB middle)` untuk LONG / `min(...)` untuk SHORT — selalu jaga RR ≥ 1:3.

**Parameter kunci:** `bbPeriod 20`, `bbStdDev 2.0`, `rsiOversold 30`, `rsiOverbought 70`,
`slMultiplier 1.0`, `tpMultiplier 3.0`, `riskPerTrade 0.01`, `leverage 1`, `maxTradesPerDay 3`,
`confirmationBars 2`.

**Edge cases:**
- `lastIdx < 50` → null (BB 20-period butuh warmup).
- Guard data: ATR/RSI/volSMA wajib ada (fail-closed).
- ⚠️ WR ~42% pada RR 1:3 adalah **profil sehat** (breakeven 25%); target 55% tidak realistis.

---

## 3. BREAKOUT_RETEST (FOUNDRY) — `BreakoutRetestStrategy.js`

**Filosofi:** Breakout level S&R dengan konfirmasi volume, **entry pada RETEST**
(bukan mengejar spike). Alat **pasar trending** — bleed saat choppy.

**Alur:**
1. **Level S&R:** `max(HIGH)` / `min(LOW)` 20 bar (bukan close — diuji oleh wick).
2. **Breakout:** close menembus level + volume ≥ 1.3× SMA.
3. **Retest:** dalam 5 bar, bar **menyentuh** level (wick ±0.3%) lalu close beyond → entry.

**Parameter kunci:** `lookbackBars 20`, `volumeMultiplier 1.3`, `retestWindow 5`,
`slMultiplier 1.5`, `tpMultiplier 6.0` (RR 1:4), `riskPerTrade 0.03`, `leverage 2`,
`maxTradesPerDay 7`.

**Edge cases:**
- SL pernah `0.5×ATR` → 0% WR karena di dalam noise bar; dinaikkan ke `1.5×ATR`.
- Breakout state expire jika retest tak datang dalam window (cegah entry level basi).
- ⚠️ **Regime-dependent:** untung saat trending (~46% WR, PF >3), rugi saat sideways. **Disarankan tambah filter tren HTF sebelum live.**

---

## 4. ADAPTIVE_FUSION (FOUNDRY/FORGE) — `AdaptiveFusionStrategy.js`

**Filosofi:** Voting 3 komponen (A/B/C) dengan mayoritas 2/3 + ranking kondisi pasar.
Exit "bulletproof": preset SL/TP atomik + fallback `setTPSL` 3× retry + emergency
close anti-naked (lihat [EMERGENCY.md](EMERGENCY.md)).

**Status:** Production-ready (per laporan progress); exit logic terverifikasi.

---

## Cara menambah/ubah strategi

- Implementasi extend `StrategyBase` di `src/domain/strategy/implementations/`.
- Daftarkan di registry strategi; endpoint `GET /api/v1/bots/strategies/available` & `/strategies/info/:key` membaca dari config.
- Unit test di `test/<Strategy>.test.js` (gaya `describe/test/expect` via shim `test/helpers/jest-lite.js` — **bukan** Jest/Mocha asli).
- Backtest di `scripts/backtest-<name>.js` (gunakan `--seed` untuk reproducibility).
