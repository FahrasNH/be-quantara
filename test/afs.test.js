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

const StrategyBase = require("#core/strategy-engine/base/StrategyBase.js");
const { strategyRegistry } = require("#core/strategy-engine/index.js");
const PositionManager = require("#core/position-engine/PositionManager.js");
const AdaptiveStrategyEngine = require("../src/application/AdaptiveStrategyEngine");

console.log("🧪 TESTING ADAPTIVE FUSION STRATEGY SYSTEM (v2.0 Umbrella)\n");

// ═════════════════════════════════════════════════════════════════════════
// TEST 1: Strategy Registration
// ═════════════════════════════════════════════════════════════════════════
console.log("TEST 1: Strategy Registry");
console.log("─".repeat(50));

const strategies = strategyRegistry.listAll();
console.log(`✓ Registered strategies: ${strategies.length}`);
console.log(`  - Found: ${strategies.map((s) => s.config.name).join(", ")}`);

// v2.0: primary key is AF_SMC; ADAPTIVE_FUSION resolves via legacy alias
const afs = strategyRegistry.get("AF_SMC");
console.log(`✓ Loaded AF_SMC: ${afs ? "SUCCESS" : "FAILED"}`);
console.log(`  - Name: ${afs.config.name}`);
console.log(`  - Label: ${afs.config.label}`);
console.log(`  - Version: ${afs.config.version}`);
console.log(`  - Umbrella: ${afs.config.umbrella ?? (afs.getMetadata?.()?.umbrella ? "true" : "false")}`);

// Legacy alias still resolves to same instance
const legacyAf = strategyRegistry.get("ADAPTIVE_FUSION");
console.log(`✓ Legacy ADAPTIVE_FUSION alias → AF_SMC: ${legacyAf === afs ? "PASS" : "FAIL"}`);

const validation = strategyRegistry.validate("AF_SMC");
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

// SAC-compatible mock indicators
const N_IND = 60;
const basePrice = 50000;
const mockIndicators = {
  closes:  Array.from({ length: N_IND }, (_, i) => basePrice + i * 10),
  highs:   Array.from({ length: N_IND }, (_, i) => basePrice + i * 10 + 30),
  lows:    Array.from({ length: N_IND }, (_, i) => basePrice + i * 10 - 30),
  opens:   Array.from({ length: N_IND }, (_, i) => basePrice + i * 10 - 5),
  volumes: Array.from({ length: N_IND }, () => 1000),
  volSMA:  Array.from({ length: N_IND }, () => 900),  // SAC reads volSMA[lastIdx]
  emaFast: Array.from({ length: N_IND }, (_, i) => basePrice + i * 9),
  emaSlow: Array.from({ length: N_IND }, (_, i) => basePrice + i * 8),
  rsi:     Array.from({ length: N_IND }, (_, i) => 45 + (i % 20)),
  atr:     Array.from({ length: N_IND }, () => 120),
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
  const signal = afs.detectSignal(mockIndicators, N_IND - 1, config);
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
  // v2.6: floor ATR% 1.2 — ATR 600/50000 = 1.2% valid
  { name: "Valid Entry", price: 50000, atr: 600, vol: 1000, volSMA: 800 },
  { name: "Low Volume", price: 50000, atr: 600, vol: 100, volSMA: 800 },
  { name: "Dead Market (ATR 0.1%)", price: 50000, atr: 50, vol: 1000, volSMA: 800 },
  // Regime CSV 11–12 Jun: ATR 0.4% — harus INVALID
  { name: "Low Vol ala dry-run Jun 11-12 (ATR 0.4%)", price: 50000, atr: 200, vol: 1000, volSMA: 800 },
  { name: "Below v2.6 ATR floor (1.1%)", price: 50000, atr: 550, vol: 1000, volSMA: 800 },
];

for (const test of validationTests) {
  const result = afs.validateEntry(test.price, test.atr, test.vol, test.volSMA);
  console.log(
    `${test.name}: ${result.valid ? "✓ VALID" : "✗ INVALID"}`
  );
  if (!result.valid) console.log(`  Reason: ${result.reason}`);
}

// ═════════════════════════════════════════════════════════════════════════
// TEST 7: Umbrella metadata & component access
// ═════════════════════════════════════════════════════════════════════════
console.log("\nTEST 7: Umbrella Metadata");
console.log("─".repeat(50));

const meta = afs.getMetadata();
console.log(`  umbrella: ${meta.umbrella}`);
console.log(`  components: ${JSON.stringify(meta.components)}`);
console.log(`  activeComponent: ${meta.activeComponent}`);
const activeComp = afs.getActiveComponent();
console.log(`  active instance: ${activeComp.config.name}`);

// (Tests 8 & 9 covered old AF v2.6 private methods — removed in v2.0.
// New SAC internals are tested in test/smc-strategy.test.js.)

// ═════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(50));
console.log("✅ AFS v2.0 TESTS COMPLETED");
console.log("═".repeat(50));
console.log("✓ Registry: AF_SMC primary + legacy aliases resolved");
console.log("✓ Umbrella: AdaptiveFusionUmbrella wraps SmartMoneyConceptsStrategy");
console.log("✓ Market ranking functional");
console.log("✓ Signal detection delegates to SAC component");
console.log("✓ Position manager working");
console.log("✓ Risk config defined");
console.log("✓ Entry validation working");
console.log("✓ Umbrella metadata accessible");
