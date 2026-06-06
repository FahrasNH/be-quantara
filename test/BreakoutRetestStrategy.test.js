/**
 * BreakoutRetestStrategy.test.js — Unit Tests
 *
 * Tests for:
 * - Level detection (support/resistance)
 * - Breakout detection (LONG/SHORT)
 * - Retest entry validation
 * - Risk configuration
 * - LONG & SHORT signal handling
 */

const assert = require("assert");
const BreakoutRetestStrategy = require("../src/domain/strategy/implementations/BreakoutRetestStrategy");

describe("BreakoutRetestStrategy", () => {
  let strategy;

  beforeEach(() => {
    strategy = new BreakoutRetestStrategy();
  });

  // ── Level Detection Tests ──────────────────────────────────────────────

  describe("detectLevels()", () => {
    it("should detect resistance (highest close in lookback)", () => {
      const closes = [
        100, 101, 102, 103, 104, 105, 104, 103, 102, 101,
        100, 101, 102, 103, 104, 105, 106, 105, 104, 103,
      ];
      const levels = strategy.detectLevels(closes);

      assert.strictEqual(levels.resistance, 106, "Resistance should be 106");
      assert.strictEqual(levels.support, 100, "Support should be 100");
    });

    it("should calculate midpoint correctly", () => {
      const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
                      100, 100, 100, 100, 100, 100, 100, 100, 100, 200];
      const levels = strategy.detectLevels(closes);

      assert.strictEqual(levels.midpoint, 150, "Midpoint should be (200+100)/2 = 150");
    });

    it("should return null if not enough bars", () => {
      const closes = [100, 101, 102];
      const levels = strategy.detectLevels(closes);

      assert.strictEqual(levels, null, "Should return null for insufficient bars");
    });
  });

  // ── Breakout Detection Tests ───────────────────────────────────────────

  describe("checkLongBreakout()", () => {
    it("should detect LONG breakout above resistance with volume", () => {
      const closes = [100, 100, 100, 100, 100, 105, 110];  // Close prev=105, curr=110
      const volumes = [1000, 1000, 1000, 1000, 1000, 1000, 1500];  // Volume spike
      const volSMA = 1000;
      const resistance = 105;

      const result = strategy.checkLongBreakout(closes, volumes, volSMA, resistance);

      assert.strictEqual(result.valid, true, "Should detect LONG breakout");
      assert.strictEqual(result.level, 105, "Level should be 105");
    });

    it("should reject LONG breakout without volume", () => {
      const closes = [100, 100, 100, 100, 100, 105, 110];
      const volumes = [1000, 1000, 1000, 1000, 1000, 1000, 1050];  // No spike (< 1.1x)
      const volSMA = 1000;
      const resistance = 105;

      const result = strategy.checkLongBreakout(closes, volumes, volSMA, resistance);

      assert.strictEqual(result.valid, false, "Should reject without sufficient volume");
    });

    it("should reject false LONG signal (no actual break)", () => {
      const closes = [100, 100, 100, 100, 100, 100, 102];  // No break above 105
      const volumes = [1000, 1000, 1000, 1000, 1000, 1000, 1500];
      const volSMA = 1000;
      const resistance = 105;

      const result = strategy.checkLongBreakout(closes, volumes, volSMA, resistance);

      assert.strictEqual(result.valid, false, "Should reject if no actual breakout");
    });
  });

  describe("checkShortBreakout()", () => {
    it("should detect SHORT breakout below support with volume", () => {
      const closes = [100, 100, 100, 100, 100, 95, 90];  // Close prev=95, curr=90
      const volumes = [1000, 1000, 1000, 1000, 1000, 1000, 1500];
      const volSMA = 1000;
      const support = 95;

      const result = strategy.checkShortBreakout(closes, volumes, volSMA, support);

      assert.strictEqual(result.valid, true, "Should detect SHORT breakout");
      assert.strictEqual(result.level, 95, "Level should be 95");
    });

    it("should reject SHORT breakout without volume", () => {
      const closes = [100, 100, 100, 100, 100, 95, 90];
      const volumes = [1000, 1000, 1000, 1000, 1000, 1000, 1050];  // No spike
      const volSMA = 1000;
      const support = 95;

      const result = strategy.checkShortBreakout(closes, volumes, volSMA, support);

      assert.strictEqual(result.valid, false, "Should reject without sufficient volume");
    });
  });

  // ── Retest Entry Tests ─────────────────────────────────────────────

  describe("checkRetestEntry()", () => {
    it("should detect LONG retest entry", () => {
      const closes = [100, 105, 110, 109, 108, 105, 106];  // Pull back to 105, close above
      const direction = "LONG";
      const breakoutLevel = 105;

      const result = strategy.checkRetestEntry(closes, direction, breakoutLevel);

      assert.strictEqual(result.valid, true, "Should detect LONG retest");
    });

    it("should detect SHORT retest entry", () => {
      const closes = [100, 95, 90, 91, 92, 95, 94];  // Pull back to 95, close below
      const direction = "SHORT";
      const breakoutLevel = 95;

      const result = strategy.checkRetestEntry(closes, direction, breakoutLevel);

      assert.strictEqual(result.valid, true, "Should detect SHORT retest");
    });

    it("should reject retest if no pullback (trending away)", () => {
      const closes = [100, 105, 110, 111, 112, 113, 114];  // No pullback
      const direction = "LONG";
      const breakoutLevel = 105;

      const result = strategy.checkRetestEntry(closes, direction, breakoutLevel);

      assert.strictEqual(result.valid, false, "Should reject if trending away");
    });
  });

  // ── Risk Configuration Tests ──────────────────────────────────────

  describe("calculateRiskConfig()", () => {
    it("should calculate LONG SL & TP correctly", () => {
      const entryPrice = 100;
      const atr = 2;
      const signal = "LONG";

      const riskCfg = strategy.calculateRiskConfig(entryPrice, atr, signal);

      // SL = 100 - (2 × 1.5) = 97  |  TP = 100 + (2 × 6) = 112  |  RR = 6/1.5 = 4
      assert.strictEqual(riskCfg.stopLoss, 97, "SL should be 100 - (2 × 1.5) = 97");
      assert.strictEqual(riskCfg.takeProfit, 112, "TP should be 100 + (2 × 6) = 112");
      assert.strictEqual(riskCfg.riskReward, 4, "RR should be (6.0 / 1.5) = 4.0");
    });

    it("should calculate SHORT SL & TP correctly", () => {
      const entryPrice = 100;
      const atr = 2;
      const signal = "SHORT";

      const riskCfg = strategy.calculateRiskConfig(entryPrice, atr, signal);

      // SL = 100 + (2 × 1.5) = 103  |  TP = 100 - (2 × 6) = 88  |  RR = 6/1.5 = 4
      assert.strictEqual(riskCfg.stopLoss, 103, "SL should be 100 + (2 × 1.5) = 103");
      assert.strictEqual(riskCfg.takeProfit, 88, "TP should be 100 - (2 × 6) = 88");
      assert.strictEqual(riskCfg.riskReward, 4, "RR should be (6.0 / 1.5) = 4.0");
    });

    it("should handle decimal prices correctly", () => {
      const entryPrice = 42350.50;
      const atr = 150.25;
      const signal = "LONG";

      const riskCfg = strategy.calculateRiskConfig(entryPrice, atr, signal);

      // SL = 42350.50 - (150.25 × 1.5) = 42350.50 - 225.375 = 42125.125
      // TP = 42350.50 + (150.25 × 6.0) = 42350.50 + 901.5   = 43252.00
      assert(Math.abs(riskCfg.stopLoss - 42125.125) < 0.01, "SL calculation should be precise");
      assert(Math.abs(riskCfg.takeProfit - 43252.00) < 0.01, "TP calculation should be precise");
    });
  });

  // ── LONG & SHORT Signal Handling Tests ──────────────────────────────

  describe("LONG & SHORT handling", () => {
    it("should track LONG breakout state", () => {
      strategy._breakoutState.direction = "LONG";
      strategy._breakoutState.breakoutLevel = 105;
      strategy._breakoutState.confirmed = false;

      const state = strategy.getBreakoutState();

      assert.strictEqual(state.direction, "LONG", "Should track LONG direction");
      assert.strictEqual(state.breakoutLevel, 105, "Should track breakout level");
    });

    it("should track SHORT breakout state", () => {
      strategy._breakoutState.direction = "SHORT";
      strategy._breakoutState.breakoutLevel = 95;
      strategy._breakoutState.confirmed = false;

      const state = strategy.getBreakoutState();

      assert.strictEqual(state.direction, "SHORT", "Should track SHORT direction");
    });

    it("should reset breakout state after trade", () => {
      strategy._breakoutState.direction = "LONG";
      strategy._breakoutState.confirmed = true;

      strategy.resetBreakoutState();
      const state = strategy.getBreakoutState();

      assert.strictEqual(state.direction, null, "Should reset direction");
      assert.strictEqual(state.confirmed, false, "Should reset confirmed flag");
    });
  });

  // ── Configuration Tests ────────────────────────────────────────────

  describe("Configuration (FOUNDRY tier)", () => {
    it("should have correct FOUNDRY tier settings", () => {
      assert.strictEqual(strategy.config.riskPerTrade, 0.03, "Risk should be 3%");
      assert.strictEqual(strategy.config.slMultiplier, 1.5, "SL should be 1.5x ATR (above noise floor)");
      assert.strictEqual(strategy.config.tpMultiplier, 6.0, "TP should be 6.0x ATR → RR 1:4");
      assert.strictEqual(strategy.config.leverage, 2, "Leverage should be 2x");
    });

    it("should allow config updates", () => {
      strategy.setConfig({ riskPerTrade: 0.02, leverage: 3 });

      assert.strictEqual(strategy.config.riskPerTrade, 0.02, "Risk should be updated");
      assert.strictEqual(strategy.config.leverage, 3, "Leverage should be updated");
      assert.strictEqual(strategy.config.tpMultiplier, 6.0, "Other settings should remain");
    });
  });

  // ── Entry Validation Tests ─────────────────────────────────────────

  describe("validateEntry()", () => {
    it("should accept healthy ATR range", () => {
      const result = strategy.validateEntry(1000, 5, 2000, 1500);  // ATR% = 0.5%

      assert.strictEqual(result.valid, true, "ATR 0.5% is healthy");
    });

    it("should reject dead market (ATR too low)", () => {
      const result = strategy.validateEntry(1000, 1, 2000, 1500);  // ATR% = 0.1%

      assert.strictEqual(result.valid, false, "ATR 0.1% is too low (< 0.2%)");
    });

    it("should reject spike market (ATR too high)", () => {
      const result = strategy.validateEntry(1000, 60, 2000, 1500);  // ATR% = 6%

      assert.strictEqual(result.valid, false, "ATR 6% is too high (> 5%)");
    });

    it("should reject low volume", () => {
      const result = strategy.validateEntry(1000, 5, 500, 1500);  // Vol ratio = 0.33x

      assert.strictEqual(result.valid, false, "Volume 0.33x is below 0.8x threshold");
    });
  });
});

// ── Test Summary ───────────────────────────────────────────────────────
console.log("\n✅ BreakoutRetestStrategy Unit Tests");
console.log("   - Level detection: 3 tests");
console.log("   - Breakout detection: 5 tests");
console.log("   - Retest entry: 3 tests");
console.log("   - Risk configuration: 3 tests");
console.log("   - LONG & SHORT handling: 3 tests");
console.log("   - Configuration: 2 tests");
console.log("   - Entry validation: 4 tests");
console.log("   Total: 23 tests\n");
