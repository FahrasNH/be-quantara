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
      // Retest valid: low bar terakhir MENYENTUH level 105 (wick), close di atas (106).
      const closes = [100, 105, 110, 109, 108, 105, 106];
      const lows   = [ 99, 104, 108, 107, 106, 104, 105];  // wick turun menyentuh 105
      const highs  = [101, 106, 111, 110, 109, 106, 107];
      const direction = "LONG";
      const breakoutLevel = 105;

      const result = strategy.checkRetestEntry(closes, direction, breakoutLevel, lows, highs);

      assert.strictEqual(result.valid, true, "Should detect LONG retest");
    });

    it("should detect SHORT retest entry", () => {
      // Retest valid: high bar terakhir MENYENTUH level 95 (wick), close di bawah (94).
      const closes = [100, 95, 90, 91, 92, 95, 94];
      const highs  = [101, 96, 91, 92, 93, 96, 95];  // wick naik menyentuh 95
      const lows   = [ 99, 94, 89, 90, 91, 94, 93];
      const direction = "SHORT";
      const breakoutLevel = 95;

      const result = strategy.checkRetestEntry(closes, direction, breakoutLevel, lows, highs);

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

      // v2.3: SL = 100 - (2 × 1.4) = 97.2 | TP = 100 + (2 × 5.5) = 111 | RR = 5.5/1.4 ≈ 3.93
      assert.strictEqual(riskCfg.stopLoss, 97.2, "SL should be 100 - (2 × 1.4) = 97.2");
      assert.strictEqual(riskCfg.takeProfit, 111, "TP should be 100 + (2 × 5.5) = 111");
      assert.strictEqual(riskCfg.riskReward, 3.93, "RR should be (5.5 / 1.4) ≈ 3.93");
    });

    it("should calculate SHORT SL & TP correctly", () => {
      const entryPrice = 100;
      const atr = 2;
      const signal = "SHORT";

      const riskCfg = strategy.calculateRiskConfig(entryPrice, atr, signal);

      // v2.3: SL = 100 + (2 × 1.4) = 102.8 | TP = 100 - (2 × 5.5) = 89 | RR = 5.5/1.4 ≈ 3.93
      assert.strictEqual(riskCfg.stopLoss, 102.8, "SL should be 100 + (2 × 1.4) = 102.8");
      assert.strictEqual(riskCfg.takeProfit, 89, "TP should be 100 - (2 × 5.5) = 89");
      assert.strictEqual(riskCfg.riskReward, 3.93, "RR should be (5.5 / 1.4) ≈ 3.93");
    });

    it("should handle decimal prices correctly", () => {
      const entryPrice = 42350.50;
      const atr = 150.25;
      const signal = "LONG";

      const riskCfg = strategy.calculateRiskConfig(entryPrice, atr, signal);

      // v2.3: SL = 42350.50 - (150.25 × 1.4) = 42350.50 - 210.35  = 42140.15
      //       TP = 42350.50 + (150.25 × 5.5) = 42350.50 + 826.375 = 43176.875
      assert(Math.abs(riskCfg.stopLoss - 42140.15) < 0.01, "SL calculation should be precise");
      assert(Math.abs(riskCfg.takeProfit - 43176.875) < 0.01, "TP calculation should be precise");
    });
  });

  // ── LONG & SHORT Signal Handling Tests ──────────────────────────────

  describe("LONG & SHORT handling", () => {
    // State breakout per-symbol (Map): akses via _getBreakoutState(config),
    // getBreakoutState(config), resetBreakoutState(config).
    const cfg = { symbol: "BTCUSDT" };

    it("should track LONG breakout state", () => {
      const bs = strategy._getBreakoutState(cfg);
      bs.direction = "LONG";
      bs.breakoutLevel = 105;
      bs.confirmed = false;

      const state = strategy.getBreakoutState(cfg);

      assert.strictEqual(state.direction, "LONG", "Should track LONG direction");
      assert.strictEqual(state.breakoutLevel, 105, "Should track breakout level");
    });

    it("should track SHORT breakout state", () => {
      const bs = strategy._getBreakoutState(cfg);
      bs.direction = "SHORT";
      bs.breakoutLevel = 95;
      bs.confirmed = false;

      const state = strategy.getBreakoutState(cfg);

      assert.strictEqual(state.direction, "SHORT", "Should track SHORT direction");
    });

    it("should reset breakout state after trade", () => {
      const bs = strategy._getBreakoutState(cfg);
      bs.direction = "LONG";
      bs.confirmed = true;

      strategy.resetBreakoutState(cfg);
      const state = strategy.getBreakoutState(cfg);

      assert.strictEqual(state.direction, null, "Should reset direction");
      assert.strictEqual(state.confirmed, false, "Should reset confirmed flag");
    });
  });

  // ── Configuration Tests ────────────────────────────────────────────

  describe("Configuration (VAULT tier)", () => {
    it("should have correct VAULT tier settings", () => {
      assert.strictEqual(strategy.config.riskPerTrade, 0.02, "v2.3: Risk should be 2%");
      assert.strictEqual(strategy.config.slMultiplier, 1.4, "v2.3: SL should be 1.4x ATR");
      assert.strictEqual(strategy.config.tpMultiplier, 5.5, "v2.3: TP should be 5.5x ATR → RR ~1:4");
      assert.strictEqual(strategy.config.leverage, 1, "Leverage should be 1x (conservative for VAULT)");
    });

    it("should allow config updates", () => {
      strategy.setConfig({ riskPerTrade: 0.02, leverage: 3 });

      assert.strictEqual(strategy.config.riskPerTrade, 0.02, "Risk should be updated");
      assert.strictEqual(strategy.config.leverage, 3, "Leverage should be updated");
      assert.strictEqual(strategy.config.tpMultiplier, 5.5, "Other settings should remain (v2.3)");
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
