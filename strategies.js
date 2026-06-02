// ─────────────────────────────────────────────
// strategies.js — Kumpulan Strategi Trading
//
// Switch strategi via .env:
//   STRATEGY=A  → Aggressive Scalping
//   STRATEGY=B  → Momentum Breakout (DEFAULT)
//   STRATEGY=C  → Multi-Timeframe Pro
//
// Cara pakai:
//   const { getStrategy } = require('./strategies')
//   const strat = getStrategy()
// ─────────────────────────────────────────────

const STRATEGIES = {

  // ─────────────────────────────────────────────
  // STRATEGI A — Aggressive Scalping
  // Banyak trade, cepat, cocok saat market volatile
  // Target: 5-15 trade/hari
  // Win rate: ~45-50%
  // ─────────────────────────────────────────────
  A: {
    name:          "A",
    label:         "Aggressive Scalping",
    description:   "RSI reversal + EMA ultra-fast. Banyak sinyal, cocok market volatile",

    // EMA ultra-cepat
    emaFast:       3,
    emaSlow:       8,
    rsiPeriod:     7,        // RSI period pendek = lebih sensitif
    rsiOverbought: 70,
    rsiOversold:   30,
    atrPeriod:     14,
    atrMultiplier: 1.0,      // SL lebih ketat
    riskReward:    2,        // TP = 2x SL (lebih mudah kena)
    riskPerTrade:  0.015,    // 1.5% per trade
    leverage:      3,
    checkInterval: 30000,    // Cek setiap 30 detik

    // Signal logic: RSI crossing back from extreme (reversal)
    // + EMA trend confirmation
    signalType:    "RSI_REVERSAL",
  },

  // ─────────────────────────────────────────────
  // STRATEGI B — Momentum Breakout ⭐ RECOMMENDED
  // Balance antara frekuensi dan akurasi
  // Target: 3-8 trade/hari
  // Win rate: ~55-65%
  // ─────────────────────────────────────────────
  B: {
    name:          "B",
    label:         "Momentum Breakout",
    description:   "EMA 5/13 + RSI momentum. Balanced antara frekuensi dan akurasi",

    emaFast:       5,
    emaSlow:       13,
    rsiPeriod:     14,
    rsiOverbought: 60,       // Lebih longgar dari default
    rsiOversold:   40,       // Lebih longgar dari default
    atrPeriod:     14,
    atrMultiplier: 1.5,      // SL = 1.5x ATR
    riskReward:    3,        // TP = 3x SL
    riskPerTrade:  0.015,    // 1.5% per trade
    leverage:      3,
    checkInterval: 60000,    // Cek setiap 60 detik

    // Signal logic: EMA crossover + RSI momentum (bukan hanya crossover)
    // Long: EMA cross UP + RSI naik dari oversold (< 50 tapi trending up)
    // Short: EMA cross DOWN + RSI turun dari overbought (> 50 tapi trending down)
    signalType:    "EMA_MOMENTUM",
  },

  // ─────────────────────────────────────────────
  // STRATEGI C — Multi-Timeframe Pro
  // Paling akurat, sedikit tapi high quality trade
  // Target: 2-4 trade/hari
  // Win rate: ~65-75%
  // ─────────────────────────────────────────────
  C: {
    name:          "C",
    label:         "Multi-Timeframe Pro",
    description:   "15m trend filter + 5m entry. Akurat, trade berkualitas tinggi",

    emaFast:       5,        // 5m EMA untuk entry
    emaSlow:       13,       // 5m EMA untuk entry
    emaTrend:      20,       // 15m EMA untuk trend filter
    rsiPeriod:     14,
    rsiOverbought: 60,
    rsiOversold:   40,
    atrPeriod:     14,
    atrMultiplier: 2.0,      // SL lebih lebar karena high quality
    riskReward:    3,
    riskPerTrade:  0.02,     // 2% per trade (lebih confident)
    leverage:      3,
    checkInterval: 60000,

    // Higher timeframe untuk filter trend
    higherTf:      "15m",

    // Signal logic: 15m EMA trend filter + 5m EMA crossover + RSI confirm
    // LONG hanya jika: 15m bullish (price > EMA20) + 5m golden cross + RSI < 60
    // SHORT hanya jika: 15m bearish (price < EMA20) + 5m death cross + RSI > 40
    signalType:    "MULTI_TF",
  },
};

/**
 * Ambil strategi berdasarkan STRATEGY env variable
 * Default: B
 */
function getStrategy(overrideKey = null) {
  const key = (overrideKey || process.env.STRATEGY || "B").toUpperCase();
  const strat = STRATEGIES[key];

  if (!strat) {
    console.warn(`[WARN] Strategi "${key}" tidak ditemukan, pakai B (Momentum Breakout)`);
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
  }));
}

module.exports = { getStrategy, listStrategies, STRATEGIES };
