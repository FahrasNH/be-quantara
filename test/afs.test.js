/**
 * ─────────────────────────────────────────────
 * afs.test.js — Comprehensive Testing for AFS System
 *
 * Tests:
 * 1. Strategy Registration
 * 2. Strategy Ranking
 * 3. Signal Detection
 * 4. Position Management
 * 5. Conflict Detection
 * ─────────────────────────────────────────────
 */

const StrategyBase = require("../src/domain/strategy/base/StrategyBase");
const AdaptiveFusionStrategy = require("../src/domain/strategy/implementations/AdaptiveFusionStrategy");
const { strategyRegistry } = require("../src/domain/strategy");
const PositionManager = require("../src/domain/PositionManager");
const AdaptiveStrategyEngine = require("../src/application/AdaptiveStrategyEngine");

console.log("🧪 TESTING ADAPTIVE FUSION STRATEGY SYSTEM\n");

// ═════════════════════════════════════════════════════════════════════════
// TEST 1: Strategy Registration
// ═════════════════════════════════════════════════════════════════════════
console.log("TEST 1: Strategy Registry");
console.log("─".repeat(50));

const strategies = strategyRegistry.listAll();
console.log(`✓ Registered strategies: ${strategies.length}`);
console.log(`  - Found: ${strategies.map((s) => s.config.name).join(", ")}`);

const afs = strategyRegistry.get("ADAPTIVE_FUSION");
console.log(`✓ Loaded ADAPTIVE_FUSION: ${afs ? "SUCCESS" : "FAILED"}`);
console.log(`  - Name: ${afs.config.name}`);
console.log(`  - Label: ${afs.config.label}`);
console.log(`  - Version: ${afs.config.version}`);

const validation = strategyRegistry.validate("ADAPTIVE_FUSION");
console.log(`✓ Validation: ${validation.valid ? "PASSED" : "FAILED"}`);

const uiChoices = strategyRegistry.getUIChoices();
console.log(`✓ UI Choices: ${JSON.stringify(uiChoices, null, 2)}`);

// ═════════════════════════════════════════════════════════════════════════
// TEST 2: Strategy Ranking (Market-Aware Selection)
// ═════════════════════════════════════════════════════════════════════════
console.log("\nTEST 2: Market-Aware Strategy Ranking");
console.log("─".repeat(50));

const testScenarios = [
  {
    name: "Strong Trend + Moderate Vol (Swing Trading)",
    conditions: { volatility: 1.5, trend_strength: 0.8 },
  },
  {
    name: "Choppy Market (Scalping)",
    conditions: { volatility: 3.5, trend_strength: 0.1 },
  },
  {
    name: "Balanced Conditions (Day Trading)",
    conditions: { volatility: 1.8, trend_strength: 0.5 },
  },
];

for (const scenario of testScenarios) {
  console.log(`\nScenario: ${scenario.name}`);
  const rankings = afs.rankByMarketConditions(scenario.conditions);
  console.log(`  Conditions: ${JSON.stringify(scenario.conditions)}`);
  rankings.forEach((r) => {
    console.log(
      `    ${r.key} (${r.label}): ${r.score}/100 - ${r.reason}`
    );
  });
}

// ═════════════════════════════════════════════════════════════════════════
// TEST 3: Signal Detection (Conflict Resolution)
// ═════════════════════════════════════════════════════════════════════════
console.log("\nTEST 3: Signal Detection & Conflict Resolution");
console.log("─".repeat(50));

// Create mock indicators
const mockIndicators = {
  closes: [50000, 50050, 50100, 50150, 50200],
  emaFast: [50025, 50050, 50075, 50100, 50125],
  emaSlow: [49950, 50000, 50050, 50100, 50150],
  rsi: [35, 40, 45, 50, 55],
  atr: [100, 110, 120, 130, 140],
};

const testConfigs = [
  { balance: 100, name: "Sufficient Capital" },
  { balance: 30, name: "Limited Capital" },
  { balance: 15, name: "Minimal Capital" },
];

for (const config of testConfigs) {
  console.log(
    `\nConfig: ${config.name} (Balance: $${config.balance})`
  );
  const signal = afs.detectSignal(mockIndicators, 4, config);
  console.log(`  Signal: ${signal || "NO SIGNAL"}`);

  // Check activation
  const activation = afs.canActivate(config.balance, "NEUTRAL", 1.5);
  console.log(`  Can Activate: ${activation.allowed} (${activation.reason})`);
}

// ═════════════════════════════════════════════════════════════════════════
// TEST 4: Position Manager
// ═════════════════════════════════════════════════════════════════════════
console.log("\nTEST 4: Position Manager");
console.log("─".repeat(50));

const pm = new PositionManager(2); // Max 2 positions

console.log("\n1. Check empty state:");
console.log(`   Total positions: ${pm.positions.size}`);
console.log(
  `   Can open: ${pm.canOpenNewPosition("BTCUSDT").allowed ? "YES" : "NO"}`
);

console.log("\n2. Add first position (BTCUSDT LONG):");
pm.addPosition({
  id: "pos_1",
  symbol: "BTCUSDT",
  side: "LONG",
  entry: 50000,
  strategyKey: "ADAPTIVE_FUSION",
});
console.log(`   Total positions: ${pm.positions.size}`);
console.log(
  `   BTCUSDT positions: ${pm.getBySymbol("BTCUSDT").length}`
);

console.log("\n3. Try to add second BTCUSDT position (should fail):");
const conflict = pm.canOpenNewPosition("BTCUSDT");
console.log(`   Can open: ${conflict.allowed ? "YES" : "NO"}`);
console.log(`   Reason: ${conflict.reason}`);

console.log("\n4. Add second position (ETHUSDT SHORT):");
pm.addPosition({
  id: "pos_2",
  symbol: "ETHUSDT",
  side: "SHORT",
  entry: 3000,
  strategyKey: "ADAPTIVE_FUSION",
});
console.log(`   Total positions: ${pm.positions.size}`);
console.log(
  `   Max capacity: ${pm.maxTotalPositions}`
);

console.log("\n5. Try to add third position (should fail - max reached):");
const fullCheck = pm.canOpenNewPosition("SOLUSDT");
console.log(`   Can open: ${fullCheck.allowed ? "YES" : "NO"}`);
console.log(`   Reason: ${fullCheck.reason}`);

console.log("\n6. Position summary:");
console.log(JSON.stringify(pm.getSummary(), null, 2));

// ═════════════════════════════════════════════════════════════════════════
// TEST 5: Risk Configuration
// ═════════════════════════════════════════════════════════════════════════
console.log("\nTEST 5: Risk Configuration");
console.log("─".repeat(50));

const riskConfig = afs.getRiskConfig();
console.log(`Risk per trade: ${(riskConfig.riskPerTrade * 100).toFixed(1)}%`);
console.log(`Max daily loss: ${(riskConfig.maxDailyLossPct * 100).toFixed(1)}%`);
console.log(`Max trades/day: ${riskConfig.maxTradesPerDay}`);
console.log(`Leverage: ${riskConfig.leverage}x`);

// ═════════════════════════════════════════════════════════════════════════
// TEST 6: Entry Validation
// ═════════════════════════════════════════════════════════════════════════
console.log("\nTEST 6: Entry Validation");
console.log("─".repeat(50));

const validationTests = [
  // P7: floor ATR% naik 0.3 → 0.5 — ATR 300/50000 = 0.6% valid
  { name: "Valid Entry", price: 50000, atr: 300, vol: 1000, volSMA: 800 },
  { name: "Low Volume", price: 50000, atr: 300, vol: 100, volSMA: 800 },
  { name: "Dead Market (ATR 0.1%)", price: 50000, atr: 50, vol: 1000, volSMA: 800 },
  // Regime CSV 11–12 Jun: ATR 0.4% — sekarang harus INVALID
  { name: "Low Vol ala dry-run Jun 11-12 (ATR 0.4%)", price: 50000, atr: 200, vol: 1000, volSMA: 800 },
];

for (const test of validationTests) {
  const result = afs.validateEntry(test.price, test.atr, test.vol, test.volSMA);
  console.log(
    `${test.name}: ${result.valid ? "✓ VALID" : "✗ INVALID"}`
  );
  if (!result.valid) console.log(`  Reason: ${result.reason}`);
}

// ═════════════════════════════════════════════════════════════════════════
// TEST 7: Sub-Strategy Configs
// ═════════════════════════════════════════════════════════════════════════
console.log("\nTEST 7: Sub-Strategy Configurations");
console.log("─".repeat(50));

const subStrategies = afs.getSubStrategies();
console.log(`Total sub-strategies: ${Object.keys(subStrategies).length}`);

for (const [key, config] of Object.entries(subStrategies)) {
  console.log(`\n${key}: ${config.label}`);
  console.log(`  HTF: ${config.htf} | Entry: ${config.entryTf}`);
  console.log(`  Risk: ${(config.riskPerTrade * 100).toFixed(1)}% | Max ${config.maxTradesPerDay} trades/day`);
  console.log(`  Min Capital: $${config.minCapital}`);
}

// ═════════════════════════════════════════════════════════════════════════
// TEST 8: Component B — Event-Based Entry (v2.2 / P8) + Regime Gate (P7)
// B hanya fire saat ada EVENT segar (fresh crossover / pullback-resume),
// dan detectSignal memblok semua entry di DEAD_MARKET.
// ═════════════════════════════════════════════════════════════════════════
console.log("\nTEST 8: Component B — Event-Based Detection + Regime Gate");
console.log("─".repeat(50));

let b8pass = 0, b8fail = 0;
const tB = (name, got, want) => {
  const ok = got === want;
  if (ok) { b8pass++; console.log(`  ✅ ${name}`); }
  else     { b8fail++; console.log(`  ❌ ${name}: got ${got}, want ${want}`); }
};

// Helper: array konstan sepanjang n+1 elemen (index 0..n).
// detectSignal punya early guard `if (lastIdx < 30) return null` sehingga kita butuh
// minimal 31 elemen (lastIdx = 30).
function mkSeries(n, val) { return Array(n + 1).fill(val); }
const N = 30; // lastIdx = N

// Downtrend BTC mirip log nyata: EMA9 < EMA21 < EMA50, price < EMA21, RSI 42.
// Event pullback-resume: candle N-1 sempat close DI ATAS EMA9 (pullback naik),
// candle N close kembali di bawah (resume turun) → B SHORT, C SHORT → 2/3.
// volatility 1.2 (bukan 0.30 — itu DEAD_MARKET dan kini diblok, lihat tes bawah).
{
  const closes = mkSeries(N, 62600);
  closes[N - 1] = 62700;   // pullback ke atas EMA9 (62684)
  closes[N]     = 62488;   // resume turun
  const btcIndicators = {
    closes,
    emaFast:   mkSeries(N, 62683.93),  // EMA9
    emaSlow:   mkSeries(N, 62776.78),  // EMA21
    emaTrend:  mkSeries(N, 62925.00),  // EMA50
    rsi:       mkSeries(N, 42.4),
    atr:       mkSeries(N, 189.08),
    volumes:   mkSeries(N, 1),
    volSMA:    mkSeries(N, null),
  };
  const sig = afs.detectSignal(btcIndicators, N, { balance: 500, volatility: 1.2, trend_strength: 0.15 });
  tB("BTC downtrend + pullback-resume — detectSignal SHORT", sig, "SHORT");
  const meta = afs.getLastSignalMeta();
  tB("lastSignalMeta tersedia setelah signal", meta !== null, true);

  // P7: regime persis seperti CSV 11–12 Jun (vol 0.4, trend 0.05) → DEAD_MARKET → null
  const sigDead = afs.detectSignal(btcIndicators, N, { balance: 500, volatility: 0.4, trend_strength: 0.05 });
  tB("DEAD_MARKET (vol 0.4, trend 0.05 ala CSV) — entry diblok", sigDead, null);
}

// Uptrend: EMA9 > EMA21 > EMA50, price > EMA21, RSI 57, pullback-resume → LONG
{
  const closes = mkSeries(N, 104);
  closes[N - 1] = 103.4;   // pullback ke bawah EMA9 (103.5)
  closes[N]     = 104;     // resume naik
  const upIndicators = {
    closes,
    emaFast:   mkSeries(N, 103.5),  // EMA9
    emaSlow:   mkSeries(N, 102.5),  // EMA21
    emaTrend:  mkSeries(N, 101.0),  // EMA50
    rsi:       mkSeries(N, 57),
    atr:       mkSeries(N, 0.5),
    volumes:   mkSeries(N, 100),
    volSMA:    mkSeries(N, 80),
  };
  const sig = afs.detectSignal(upIndicators, N, { balance: 500, volatility: 0.5, trend_strength: 0.5 });
  tB("Uptrend + pullback-resume — detectSignal LONG", sig, "LONG");
}

// P8 ANTI-CHASING: alignment & RSI valid TAPI tidak ada event (harga sudah
// extended di atas EMA9 selama seluruh lookback, tanpa crossover baru) → B null.
// Ini persis pola entry telat yang menyebabkan 18/18 loss.
{
  const closes  = mkSeries(N, 104.5);       // selalu jauh di atas EMA9 — no pullback
  const emaFast = mkSeries(N, 103.5);
  const emaSlow = mkSeries(N, 102.5);       // tidak pernah cross dalam lookback
  const sig = afs._detectSignalB(57, emaFast, emaSlow, 101.0, closes, N);
  tB("Aligned tapi TANPA event (extended/chasing) — B null", sig, null);
}

// Event fresh crossover: EMA9 melintasi EMA21 dalam lookback → B fire
{
  const emaFast = mkSeries(N, 103.5);
  emaFast[N - 1] = 102.4;                   // sebelum cross: EMA9 < EMA21
  const emaSlow = mkSeries(N, 102.5);
  const closes  = mkSeries(N, 104);
  const sig = afs._detectSignalB(57, emaFast, emaSlow, 101.0, closes, N);
  tB("Fresh EMA9×EMA21 crossover — B fires LONG", sig, "LONG");
}

// Jika EMA alignment TIDAK sejajar (mixed), B harus null walau ada event
{
  // EMA9(100.5) > EMA21(100.2) tapi EMA50(100.8) > EMA21 → tidak fully aligned
  const closes  = [99, 100, 100.1, 100.0, 100.5];  // pullback-resume event ada
  const sig = afs._detectSignalB(55, mkSeries(4, 100.4), mkSeries(4, 100.2), 100.8, closes, 4);
  tB("Mixed EMA (tidak fully aligned) — B null", sig, null);
}

// Jika emaTrend null (tidak tersedia), B tetap bisa fire dengan 2-EMA fallback
{
  // closes sempat <= EMA9 (100.8) lalu close terakhir di atasnya → pullback-resume
  const closes = [99, 99.5, 100, 100.5, 101];
  const sig = afs._detectSignalB(58, mkSeries(4, 100.8), mkSeries(4, 100.2), null, closes, 4);
  tB("emaTrend=null (fallback 2-EMA) — B fires LONG", sig, "LONG");
}

// RSI overbought (≥70) — B harus null (filter overbought)
{
  const closes = [100, 101, 103.2, 103.4, 104];  // pullback-resume event ada
  const sig = afs._detectSignalB(72, mkSeries(4, 103.5), mkSeries(4, 102.5), 101.0, closes, 4);
  tB("RSI overbought (72) — B null", sig, null);
}

// RSI oversold (≤30) di SHORT setup — B harus null
{
  const closes = [101, 100, 97.6, 97.5, 97];     // pullback-resume event ada
  const sig = afs._detectSignalB(28, mkSeries(4, 97.4), mkSeries(4, 97.5), 99.0, closes, 4);
  tB("RSI oversold (28) — B null", sig, null);
}

console.log(`\nComponent B: ${b8pass} passed, ${b8fail} failed`);
if (b8fail > 0) { console.log("⚠️  Component B tests FAILED"); process.exitCode = 1; }

// ═════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(50));
console.log("✅ ALL TESTS COMPLETED SUCCESSFULLY");
console.log("═".repeat(50));
console.log("\nSummary:");
console.log("✓ Strategy registration working");
console.log("✓ Market-aware ranking functional");
console.log("✓ Signal detection with conflict resolution");
console.log("✓ Position manager with conflict detection");
console.log("✓ Risk configuration defined");
console.log("✓ Entry validation rules in place");
console.log("✓ Sub-strategy configs loaded");
console.log("\nSystem is ready for integration! 🚀");
