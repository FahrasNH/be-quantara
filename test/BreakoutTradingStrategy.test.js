/**
 * BreakoutTradingStrategy.test.js — Unit Tests
 *
 * Tests for:
 * - Level detection (support/resistance)
 * - Consolidation detection (Bollinger Band Width squeeze)
 * - Breakout detection (LONG/SHORT)
 * - Retest entry validation
 * - Risk configuration
 * - LONG & SHORT signal handling
 */

const assert = require("assert");
const BreakoutTradingStrategy = require("../src/domain/strategy/implementations/BreakoutTradingStrategy");

describe("BreakoutTradingStrategy", () => {
  let strategy;

  beforeEach(() => {
    strategy = new BreakoutTradingStrategy();
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

  // ── Consolidation (Bollinger Band Width squeeze) Tests ─────────────────

  describe("checkConsolidation()", () => {
    it("should return squeeze=false with insufficient data", () => {
      const closes = [100, 101, 102]; // < bbPeriod + squeezeLookback
      const res = strategy.checkConsolidation(closes);

      assert.strictEqual(res.squeeze, false, "Not enough bars → no squeeze");
      assert.strictEqual(res.widthPct, null, "widthPct should be null");
    });

    it("should detect a squeeze when volatility contracts", () => {
      // Wide swings early (high BB width), then a flat tail (contracted width).
      // Need deeper contraction to clear Sprint 14 threshold 0.75×.
      const wide = [];
      for (let i = 0; i < 25; i++) wide.push(100 + (i % 2 === 0 ? 12 : -12)); // ±12 zig-zag
      const flat = new Array(15).fill(100.05); // near-flat → width collapses hard
      const closes = [...wide, ...flat];

      const res = strategy.checkConsolidation(closes);

      assert.strictEqual(res.squeeze, true, "Contracted tail should register as squeeze");
      assert(res.widthPct < res.avgPriorWidthPct, "Current width below prior average");
    });

    it("should NOT detect a squeeze when volatility is expanding", () => {
      // Flat early (tight width), then widening swings (expanding width).
      const flat = new Array(20).fill(100);
      const widening = [];
      for (let i = 0; i < 12; i++) widening.push(100 + (i % 2 === 0 ? i : -i)); // growing ±
      const closes = [...flat, ...widening];

      const res = strategy.checkConsolidation(closes);

      assert.strictEqual(res.squeeze, false, "Expanding width should NOT be a squeeze");
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
      const volumes = [1000, 1000, 1000, 1000, 1000, 1000, 1050];  // No spike (< 1.3x)
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
      // Retest valid: low touches level + rejection lower wick ≥35% of range + close above.
      const closes = [100, 105, 110, 109, 108, 107, 106.5];
      const opens  = [100, 105, 109, 108, 107, 108, 108];
      const lows   = [ 99, 104, 108, 107, 106, 106, 105];  // wick touches 105
      const highs  = [101, 106, 111, 110, 109, 109, 108.5];
      const direction = "LONG";
      const breakoutLevel = 105;

      const result = strategy.checkRetestEntry(closes, direction, breakoutLevel, lows, highs, opens);

      assert.strictEqual(result.valid, true, "Should detect LONG retest");
      assert.ok(result.rejectionWickPct >= 0.35, "Should report rejection wick");
      assert.ok(strategy._scoreConfidence({
        squeezeWidthPct: 0.02, avgPriorWidthPct: 0.04, volumeRatio: 1.8,
        rejectionWickPct: result.rejectionWickPct, barsSinceBreakout: 3, retestDepthAtr: 0.3,
      }) !== 65, "Confidence must not be flat 65");
    });

    it("should detect SHORT retest entry", () => {
      const closes = [100, 95, 90, 91, 92, 93, 93.5];
      const opens  = [100, 95, 91, 92, 93, 92, 92];
      const highs  = [101, 96, 91, 92, 93, 94, 95];  // wick touches 95
      const lows   = [ 99, 94, 89, 90, 91, 91, 91.5];
      const direction = "SHORT";
      const breakoutLevel = 95;

      const result = strategy.checkRetestEntry(closes, direction, breakoutLevel, lows, highs, opens);

      assert.strictEqual(result.valid, true, "Should detect SHORT retest");
    });

    it("should reject retest without rejection wick", () => {
      // Touches level but tiny lower wick (doji near close) — chase quality
      const closes = [100, 105, 110, 109, 108, 105, 105.1];
      const opens  = [100, 105, 109, 108, 107, 106, 105.05];
      const lows   = [ 99, 104, 108, 107, 106, 104, 105];
      const highs  = [101, 106, 111, 110, 109, 106, 105.2];
      const result = strategy.checkRetestEntry(closes, "LONG", 105, lows, highs, opens);
      assert.strictEqual(result.valid, false, "Should reject superficial wick");
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

      // v2.4: SL = 100 - (2 × 1.7) = 96.6 | TP = 100 + (2 × 3.2) = 106.4 | RR = 3.2/1.7 ≈ 1.88
      assert.strictEqual(riskCfg.stopLoss, 96.6, "SL should be 100 - (2 × 1.7) = 96.6");
      assert.strictEqual(riskCfg.takeProfit, 106.4, "TP should be 100 + (2 × 3.2) = 106.4");
      assert.strictEqual(riskCfg.riskReward, 1.88, "RR should be (3.2 / 1.7) ≈ 1.88");
    });

    it("should calculate SHORT SL & TP correctly", () => {
      const entryPrice = 100;
      const atr = 2;
      const signal = "SHORT";

      const riskCfg = strategy.calculateRiskConfig(entryPrice, atr, signal);

      // v2.4: SL = 100 + (2 × 1.7) = 103.4 | TP = 100 - (2 × 3.2) = 93.6 | RR = 3.2/1.7 ≈ 1.88
      assert.strictEqual(riskCfg.stopLoss, 103.4, "SL should be 100 + (2 × 1.7) = 103.4");
      assert.strictEqual(riskCfg.takeProfit, 93.6, "TP should be 100 - (2 × 3.2) = 93.6");
      assert.strictEqual(riskCfg.riskReward, 1.88, "RR should be (3.2 / 1.7) ≈ 1.88");
    });

    it("should handle decimal prices correctly", () => {
      const entryPrice = 42350.50;
      const atr = 150.25;
      const signal = "LONG";

      const riskCfg = strategy.calculateRiskConfig(entryPrice, atr, signal);

      // v2.4: SL = 42350.50 - (150.25 × 1.7) = 42350.50 - 255.425 = 42095.075
      //       TP = 42350.50 + (150.25 × 3.2) = 42350.50 + 480.8   = 42831.30
      assert(Math.abs(riskCfg.stopLoss - 42095.075) < 0.01, "SL calculation should be precise");
      assert(Math.abs(riskCfg.takeProfit - 42831.30) < 0.01, "TP calculation should be precise");
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
      assert.strictEqual(strategy.config.slMultiplier, 1.7, "v2.4: SL should be 1.7x ATR");
      assert.strictEqual(strategy.config.tpMultiplier, 3.2, "v2.4: TP should be 3.2x ATR → RR ~1:1.9");
      assert.strictEqual(strategy.config.leverage, 1, "Leverage should be 1x (conservative for VAULT)");
    });

    it("should expose Bollinger Band Width squeeze settings (v2.5)", () => {
      assert.strictEqual(strategy.config.bbPeriod, 20, "BB period 20");
      assert.strictEqual(strategy.config.bbStdDev, 2.0, "BB std dev 2.0");
      assert.strictEqual(strategy.config.squeezeThreshold, 0.75, "Sprint 14 tighter squeeze");
      assert.strictEqual(strategy.config.volumeMultiplier, 1.5, "Sprint 14 volume gate");
      assert.strictEqual(strategy.config.minRetestBars, 2, "Sprint 14 min retest wait");
      assert.strictEqual(strategy.config.requireConsolidation, true, "Consolidation gate on by default");
    });

    it("should allow config updates", () => {
      strategy.setConfig({ riskPerTrade: 0.02, leverage: 3 });

      assert.strictEqual(strategy.config.riskPerTrade, 0.02, "Risk should be updated");
      assert.strictEqual(strategy.config.leverage, 3, "Leverage should be updated");
      assert.strictEqual(strategy.config.tpMultiplier, 3.2, "Other settings should remain (v2.4)");
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
console.log("\n✅ BreakoutTradingStrategy Unit Tests");
console.log("   - Level detection: 3 tests");
console.log("   - Consolidation (BB Width squeeze): 3 tests");
console.log("   - Breakout detection: 5 tests");
console.log("   - Retest entry: 3 tests");
console.log("   - Risk configuration: 3 tests");
console.log("   - LONG & SHORT handling: 3 tests");
console.log("   - Configuration: 3 tests");
console.log("   - Entry validation: 4 tests");
console.log("   Total: 27 tests\n");
