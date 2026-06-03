// ─────────────────────────────────────────────
// strategies.js — Kumpulan Strategi Trading
//
// Berdasarkan: "Dokumentasi Panduan Strategi Trading"
//   Aggressive Scalping, Day Trading, dan Swing Trading
//
// Switch strategi via .env:
//   STRATEGY=A  → Aggressive Scalping  (1M–5M, EMA9/21)
//   STRATEGY=B  → Day Trading          (15M–1H, EMA9/21/50)
//   STRATEGY=C  → Swing Trading        (4H, EMA21/50/200)
// ─────────────────────────────────────────────

const STRATEGIES = {

  // ─────────────────────────────────────────────
  // STRATEGI A — Aggressive Scalping
  //
  // Sumber PDF:
  //   TF: 1M–5M | EMA Fast 9 / Slow 21 | RSI 7–14
  //   Long : EMA9 > EMA21 + Close > EMA9 + RSI 50-70 + Volume naik
  //   Short: EMA9 < EMA21 + Close < EMA9 + RSI 30-50 + Volume naik
  //   TP = 1.0x ATR | SL = 0.5x ATR | Risk/trade = 0.5%–1%
  // ─────────────────────────────────────────────
  A: {
    name:          "A",
    label:         "Aggressive Scalping",
    description:   "EMA9/21 + RSI zona momentum + volume spike. Frekuensi tinggi, cocok market volatile",

    emaFast:       9,
    emaSlow:       21,
    emaTrend:      0,          // Tidak pakai trend filter
    rsiPeriod:     7,          // RSI sensitif untuk scalping
    rsiOverbought: 70,         // Filter: RSI tidak boleh > 70 saat Long
    rsiOversold:   30,         // Filter: RSI tidak boleh < 30 saat Short
    rsiLongMin:    50,         // Long hanya jika RSI >= 50 (zona momentum bullish)
    rsiLongMax:    70,         // Long hanya jika RSI <= 70 (belum overbought)
    rsiShortMin:   30,         // Short hanya jika RSI >= 30 (belum oversold)
    rsiShortMax:   50,         // Short hanya jika RSI <= 50 (zona momentum bearish)
    atrPeriod:     14,
    atrMultiplier: 0.5,        // SL = 0.5x ATR (ketat, sesuai PDF)
    riskReward:    2,          // TP = 2x SL = 1.0x ATR (sesuai PDF)
    riskPerTrade:  0.01,       // 1% per trade (batas atas PDF: 0.5%–1%)
    leverage:      3,
    interval:      "1m",       // Default timeframe scalping
    checkInterval: 30000,      // Cek setiap 30 detik

    signalType:    "PDF_SCALPING",

    // Info UI
    trades:        "5-20 trade/hari",
    winrate:       "~45-55%",
    risk:          "Tinggi",
  },

  // ─────────────────────────────────────────────
  // STRATEGI B — Day Trading ⭐ RECOMMENDED
  //
  // Sumber PDF:
  //   TF: 15M–1H | EMA Fast 9 / Slow 21 / Trend 50 | RSI 14
  //   Long : EMA9 > EMA21 + price > EMA50 + RSI 50-70 + Volume naik
  //   Short: EMA9 < EMA21 + price < EMA50 + RSI < 50 + Volume naik
  //   TP = 1.5–3x ATR | SL = 1x ATR | Risk/trade = 1%–2%
  // ─────────────────────────────────────────────
  B: {
    name:          "B",
    label:         "Day Trading",
    description:   "EMA9/21 + filter EMA50 + RSI 50-70 + volume. Balanced frekuensi & akurasi",

    emaFast:       9,
    emaSlow:       21,
    emaTrend:      50,         // Filter trend: price harus di atas/bawah EMA50
    rsiPeriod:     14,
    rsiOverbought: 70,
    rsiOversold:   30,
    rsiLongMin:    50,         // Long: RSI zona momentum bullish
    rsiLongMax:    70,         // Long: RSI belum overbought
    rsiShortMin:   30,
    rsiShortMax:   50,         // Short: RSI zona momentum bearish
    atrPeriod:     14,
    atrMultiplier: 1.0,        // SL = 1x ATR (sesuai PDF)
    riskReward:    2,          // TP = 2x SL = 2x ATR (tengah range PDF: 1.5–3x)
    riskPerTrade:  0.015,      // 1.5% per trade
    leverage:      3,
    interval:      "15m",      // Default timeframe day trading
    checkInterval: 60000,      // Cek setiap 60 detik

    signalType:    "PDF_DAYTRADING",

    trades:        "3-8 trade/hari",
    winrate:       "~55-65%",
    risk:          "Sedang",
  },

  // ─────────────────────────────────────────────
  // STRATEGI C — Swing Trading
  //
  // Sumber PDF:
  //   TF: 4H–1D | EMA Fast 21 / Slow 50 / Trend 200 | RSI 14
  //   Long : price > EMA50 + pullback ke support + RSI 40-60 naik + candle bullish
  //   Short: price < EMA50 + pullback ke resistance + RSI 50-60 turun + candle bearish
  //   TP = 3–6x ATR | SL = 1.5–2x ATR | Risk/trade = 1%–2%
  // ─────────────────────────────────────────────
  C: {
    name:          "C",
    label:         "Swing Trading",
    description:   "EMA21/50/200 + pullback ke EMA + RSI 40-60. Trade sedikit tapi momentum kuat",

    emaFast:       21,
    emaSlow:       50,
    emaTrend:      200,        // Filter tren besar: price vs EMA200
    rsiPeriod:     14,
    rsiOverbought: 60,         // Swing lebih ketat (hindari entry di overbought)
    rsiOversold:   40,         // Swing lebih ketat
    rsiLongMin:    40,         // Long saat RSI pullback ke zona sehat
    rsiLongMax:    60,
    rsiShortMin:   40,
    rsiShortMax:   60,
    atrPeriod:     14,
    atrMultiplier: 1.5,        // SL = 1.5x ATR (sesuai PDF: 1.5–2x)
    riskReward:    3,          // TP = 3x SL = 4.5x ATR (dalam range PDF: 3–6x)
    riskPerTrade:  0.015,      // 1.5% per trade
    leverage:      2,          // Leverage lebih kecil untuk swing
    interval:      "4h",       // Timeframe swing trading
    checkInterval: 300000,     // Cek setiap 5 menit (karena 4H candle)

    signalType:    "PDF_SWING",

    trades:        "1-5 trade/minggu",
    winrate:       "~65-75%",
    risk:          "Rendah-Sedang",
  },
};

/**
 * Ambil strategi berdasarkan key
 * Default: B
 */
function getStrategy(overrideKey = null) {
  const key = (overrideKey || process.env.STRATEGY || "B").toUpperCase();
  const strat = STRATEGIES[key];

  if (!strat) {
    console.warn(`[WARN] Strategi "${key}" tidak ditemukan, pakai B (Day Trading)`);
    return STRATEGIES["B"];
  }

  return strat;
}

/**
 * List semua strategi tersedia
 */
function listStrategies() {
  return Object.values(STRATEGIES).map(s => ({
    key:         s.name,
    label:       s.label,
    description: s.description,
    signalType:  s.signalType,
    trades:      s.trades,
    winrate:     s.winrate,
    risk:        s.risk,
  }));
}

module.exports = { getStrategy, listStrategies, STRATEGIES };
