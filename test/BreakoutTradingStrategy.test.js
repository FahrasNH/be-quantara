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

    it("should detect a healthy-width range (volatility floor passes)", () => {
      // Moderate expansion: width stays above minBbWidthPct (0.0076)
      const closes = [];
      for (let i = 0; i < 40; i++) {
        closes.push(100 + Math.sin(i / 3) * 2.5); // ~5% peak-peak swings → healthy BB
      }
      const atr = 0.4; // 0.4% of ~100
      const res = strategy.checkConsolidation(closes, atr, 100);

      assert.strictEqual(res.volatilityOk, true, "Healthy width + ATR should pass volatility floor");
      assert.ok(res.widthPct != null && res.widthPct >= 0.0076, "widthPct should clear minBbWidthPct");
    });

    it("should reject dry / super-tight BB width (v2.6 reverse gate)", () => {
      // Near-flat closes → BB width collapses below 0.0076
      const closes = new Array(40).fill(100.01);
      closes[39] = 100.02;
      const atr = 0.5;
      const res = strategy.checkConsolidation(closes, atr, 100);

      assert.strictEqual(res.volatilityOk, false, "Super-tight BB should fail volatility floor");
    });

    it("should reject low ATR% even with adequate BB width", () => {
      const closes = [];
      for (let i = 0; i < 40; i++) closes.push(100 + Math.sin(i / 3) * 2.5);
      const atr = 0.1; // 0.1% of price — below minAtrPct 0.25
      const res = strategy.checkConsolidation(closes, atr, 100);
      assert.strictEqual(res.volatilityOk, false, "ATR% below floor should fail");
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
      // Retest valid: low touches level + rejection lower wick ≥50% of range + close above.
      const closes = [100, 105, 110, 109, 108, 107, 106.5];
      const opens  = [100, 105, 109, 108, 107, 108, 108];
      const lows   = [ 99, 104, 108, 107, 106, 106, 104];  // wick pierces below 105
      const highs  = [101, 106, 111, 110, 109, 109, 108.5];
      const direction = "LONG";
      const breakoutLevel = 105;

      const result = strategy.checkRetestEntry(closes, direction, breakoutLevel, lows, highs, opens);

      assert.strictEqual(result.valid, true, "Should detect LONG retest");
      assert.ok(result.rejectionWickPct >= 0.5, "Should report rejection wick ≥50% (Sprint 14)");
      assert.ok(strategy._scoreConfidence({
        squeezeWidthPct: 0.02, avgPriorWidthPct: 0.04, volumeRatio: 1.8,
        rejectionWickPct: result.rejectionWickPct, barsSinceBreakout: 3, retestDepthAtr: 0.3,
      }) !== 65, "Confidence must not be flat 65");
    });

    it("should detect SHORT retest entry", () => {
      const closes = [100, 95, 90, 91, 92, 93, 93.5];
      const opens  = [100, 95, 91, 92, 93, 92, 92];
      const highs  = [101, 96, 91, 92, 93, 94, 96];  // wick pierces above 95
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
      assert.strictEqual(strategy.config.minSlAtrFloor, 1.5, "Sprint 14 P0.1-REVISI: SL floor 1.5×ATR");
      assert.strictEqual(strategy.config.maxPlannedRR, 2.5, "Sprint 14 P0.6: planned R:R hard cap 2.5");
      assert.strictEqual(strategy.config.leverage, 1, "Leverage should be 1x (conservative for VAULT)");
    });

    it("should expose Bollinger volatility-floor settings (v2.6)", () => {
      assert.strictEqual(strategy.config.bbPeriod, 20, "BB period 20");
      assert.strictEqual(strategy.config.bbStdDev, 2.0, "BB std dev 2.0");
      assert.strictEqual(strategy.config.minBbWidthPct, 0.0076, "Sprint 14 QA reverse: min BB width");
      assert.strictEqual(strategy.config.minAtrPct, 0.25, "Sprint 14 QA reverse: min ATR%");
      assert.strictEqual(strategy.config.volumeMultiplier, 1.5, "Sprint 14 volume gate");
      assert.strictEqual(strategy.config.maxVolumeRatio, 3.55, "Exhaustion volume cap");
      assert.strictEqual(strategy.config.minRetestBars, 16, "Sprint 14 QA: ≥4h wait @15m");
      assert.strictEqual(strategy.config.retestWindow, 96, "Sprint 14 QA: 24h retest window");
      assert.strictEqual(strategy.config.preferredTpMode, "full", "Prefer full TP for RR integrity");
      assert.strictEqual(strategy.config.slPlusPartial1Pct, 0.33, "Partial first take capped at 33%");
      assert.strictEqual(strategy.config.requireConsolidation, true, "Volatility floor on by default");
    });

    it("should expose Sprint 14 retest-quality + regime gates", () => {
      assert.strictEqual(strategy.config.minRejectionWickRatio, 0.5, "Sprint 14 P0.4: wick ≥0.5");
      assert.strictEqual(strategy.config.minRetestDepthAtr, 0.17, "Sprint 14 P0.3: retest depth lower band");
      assert.strictEqual(strategy.config.maxRetestDepthAtr, 0.72, "Sprint 14 P0.3: retest depth upper band");
      assert.deepStrictEqual(
        strategy.config.blockedMarketConds,
        ["COILED_BREAKOUT", "SQUEEZE_BREAKOUT", "DRY_SQUEEZE"],
        "Sprint 14 P0.2: block tightest-squeeze regimes",
      );
    });

    it("should classify SQUEEZE_BREAKOUT for mild compression (0.75–0.90×)", () => {
      // ratio = 0.008 / 0.01 = 0.80 (in the 0.75–0.90 band) with width ≥ 0.0076
      assert.strictEqual(
        strategy._classifyMarketCond(0.008, 0.01, 1.0),
        "SQUEEZE_BREAKOUT",
        "Mild compression band should be SQUEEZE_BREAKOUT",
      );
      // ratio = 0.007/0.02 = 0.35 (≤0.75) → COILED
      assert.strictEqual(
        strategy._classifyMarketCond(0.008, 0.02, 1.0),
        "COILED_BREAKOUT",
        "Tight compression should stay COILED_BREAKOUT",
      );
    });

    it("P0.1-REVISI: structure must NOT tighten SL inside the wide ATR stop", () => {
      const riskCfg = strategy.calculateRiskConfig(106.5, 2, "LONG", {
        breakoutLevel: 105,
        retestExtreme: 104.8,
      });
      // Structure would be 104.8 - 0.4 = 104.4 (dist 2.1×) — TIGHTER than the wide
      // ATR stop 106.5 - 3.4 = 103.1 (1.7×ATR). The old code snapped to the tight
      // 104.4; the revision keeps the wide 1.7×ATR stop so noise wicks can't clip it.
      assert.strictEqual(riskCfg.stopLoss, 103.1, "Should keep the wide 1.7×ATR stop, not the tight structure stop");
      assert.ok(Math.abs(riskCfg.slDistance - 3.4) < 1e-6, "SL distance = 1.7×ATR = 3.4");
      assert.ok(riskCfg.slDistance >= 2 * 1.5, "SL distance must be ≥ 1.5×ATR floor");
    });

    it("P0.1-REVISI: structure WIDER than the ATR stop is allowed to widen SL", () => {
      // retestExtreme far below entry → structure stop sits beyond the 1.7×ATR stop.
      const riskCfg = strategy.calculateRiskConfig(110, 2, "LONG", {
        retestExtreme: 105, // structure = 105 - 0.4 = 104.6, dist 5.4 > ATR stop dist 3.4
      });
      assert.strictEqual(riskCfg.stopLoss, 104.6, "Wider structure stop should widen the SL");
      assert.ok(riskCfg.slDistance > 3.4, "Widened SL distance exceeds the 1.7×ATR baseline");
    });

    it("P0.1-REVISI: SL never tighter than the 1.5×ATR floor", () => {
      const riskCfg = strategy.calculateRiskConfig(100, 2, "LONG");
      assert.ok(riskCfg.slDistance >= 2 * 1.5, "Floor guarantees ≥1.5×ATR");
      assert.ok(Math.abs(riskCfg.slDistance - 3.4) < 1e-6, "Default SL = 1.7×ATR = 3.4 (≥ floor)");
    });

    it("P0.6: planned R:R is hard-capped at 2.5 even for a far structural target", () => {
      // A very distant target would imply RR ≫ 2.5; the cap clamps TP to 2.5×SL.
      const riskCfg = strategy.calculateRiskConfig(100, 2, "LONG", { structuralTarget: 200 });
      assert.ok(riskCfg.riskReward <= 2.5, `RR ${riskCfg.riskReward} must be ≤ 2.5`);
      // SL = 1.7×ATR = 3.4 → TP dist capped at 3.4 × 2.5 = 8.5 → TP = 108.5
      assert.strictEqual(riskCfg.takeProfit, 108.5, "TP clamped to RR 2.5 boundary");
    });

    it("P0.6: TP anchors to a structural target within the RR cap", () => {
      // entry 103.5, atr 1 → SL 1.7; target 106 (measured move) → TP dist 2.5, RR ≈ 1.47
      const riskCfg = strategy.calculateRiskConfig(103.5, 1, "LONG", {
        breakoutLevel: 103,
        retestExtreme: 102.5,
        structuralTarget: 106,
      });
      assert.strictEqual(riskCfg.takeProfit, 106, "TP should sit at the structural target");
      assert.ok(riskCfg.slDistance >= 1.5, "SL ≥ 1.5×ATR floor");
      assert.ok(riskCfg.riskReward <= 2.5, "Structural RR within cap");
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

  // ── Confidence grading (Sprint 14 Bug 3) ───────────────────────────
  describe("_scoreConfidence() grading (Bug 3 — no flat 95)", () => {
    it("should return DIFFERENT scores for different-quality gate survivors", () => {
      // Both inputs would pass the P0.2–P0.4 gates, but differ in quality.
      const strong = strategy._scoreConfidence({
        squeezeWidthPct: 0.012, volumeRatio: 3.0, rejectionWickPct: 0.72,
        barsSinceBreakout: 20, retestDepthAtr: 0.4,
      });
      const weak = strategy._scoreConfidence({
        squeezeWidthPct: 0.0078, volumeRatio: 1.5, rejectionWickPct: 0.5,
        barsSinceBreakout: 60, retestDepthAtr: 0.2,
      });
      assert.notStrictEqual(strong, weak, "Different quality must yield different confidence");
      assert.ok(strong > weak, "Higher-quality setup should score higher");
    });

    it("should produce a spread (non-zero std) across a population of survivors", () => {
      const samples = [
        { squeezeWidthPct: 0.012, volumeRatio: 3.0, rejectionWickPct: 0.72, barsSinceBreakout: 20, retestDepthAtr: 0.40 },
        { squeezeWidthPct: 0.010, volumeRatio: 2.2, rejectionWickPct: 0.60, barsSinceBreakout: 24, retestDepthAtr: 0.45 },
        { squeezeWidthPct: 0.0085, volumeRatio: 1.8, rejectionWickPct: 0.55, barsSinceBreakout: 40, retestDepthAtr: 0.30 },
        { squeezeWidthPct: 0.0078, volumeRatio: 1.5, rejectionWickPct: 0.50, barsSinceBreakout: 60, retestDepthAtr: 0.20 },
      ].map((s) => strategy._scoreConfidence(s));

      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const std = Math.sqrt(samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length);
      assert.ok(std > 0, `Confidence std must be > 0 (got ${std.toFixed(2)} from ${samples.join(",")})`);
      assert.ok(Math.max(...samples) <= 95, "Score never exceeds 95");
      assert.ok(Math.min(...samples) >= 50, "Score never below floor 50");
      // Typical survivors should land in the 80–95 window, not pin the ceiling.
      assert.ok(new Set(samples).size >= 3, "At least 3 distinct confidence values across the population");
    });
  });

  // ── detectSignal integration (Sprint 14 Bug 1 + Bug 2) ─────────────
  describe("detectSignal() SL/TP + structural-target skip (Bug 1/2)", () => {
    const cfg = { symbol: "SYNTHBR" };

    // Synthetic LONG breakout → displacement → true retest. `support` controls the
    // consolidation range height (= measured-move target distance) so we can drive
    // the P0.6 skip-if-target-unreachable branch on/off.
    function makeBreakoutRetestSeries({ support = 100 } = {}) {
      const opens = [], highs = [], lows = [], closes = [], volumes = [], volSMA = [], atr = [];
      const push = (o, h, l, c, v) => {
        opens.push(o); highs.push(h); lows.push(l); closes.push(c);
        volumes.push(v); volSMA.push(1000); atr.push(1);
      };
      // 40-bar consolidation inside [support, 103]
      for (let i = 0; i < 40; i++) {
        if (i % 2 === 0) push(102, 103, support, 101, 1000);
        else push(101, 102.5, support + 0.5, 102, 1000);
      }
      push(103, 104.2, 102.8, 104, 2000);            // idx40: breakout close 104 > 103, 2.0× vol
      for (let i = 41; i <= 55; i++) push(104.5, 105.0, 104.2, 104.8, 1000); // displacement up
      push(103.4, 103.6, 102.5, 103.5, 1200);        // idx56: retest (16 bars later), big lower wick
      for (let i = 57; i < 60; i++) push(103.5, 104, 103, 103.6, 1000);
      return { opens, highs, lows, closes, volumes, volSMA, atr };
    }

    function runLoop(strat, ind, config) {
      const signals = [];
      for (let i = 30; i < ind.closes.length; i++) {
        const sig = strat.detectSignal(ind, i, config);
        if (sig) signals.push({ i, sig, meta: strat.getLastSignalMeta() });
      }
      return signals;
    }

    it("emits a LONG signal on a normal expansion breakout + retest (sanity)", () => {
      const ind = makeBreakoutRetestSeries({ support: 100 }); // range 3 → target within cap
      const signals = runLoop(strategy, ind, cfg);
      assert.ok(signals.length >= 1, `Strategy must still emit signals (got ${signals.length})`);
      assert.strictEqual(signals[0].sig, "LONG", "Should be a LONG breakout signal");
      const meta = signals[0].meta;
      assert.ok(meta.structuralTarget != null, "Signal meta carries a structural target");
      assert.ok(meta.plannedRR <= 2.5, `Planned RR ${meta.plannedRR} must be ≤ 2.5`);
    });

    it("produces a wide (≥1.5×ATR) SL and RR ≤ 2.5 for the emitted signal", () => {
      const ind = makeBreakoutRetestSeries({ support: 100 });
      const signals = runLoop(strategy, ind, cfg);
      assert.ok(signals.length >= 1, "Need a signal to size risk");
      const { meta } = signals[0];
      const entry = ind.closes[signals[0].i];
      const atr = ind.atr[signals[0].i];
      const rc = strategy.calculateRiskConfig(entry, atr, "LONG", {
        breakoutLevel: meta.breakoutLevel,
        retestExtreme: meta.retestExtreme,
        structuralTarget: meta.structuralTarget,
      });
      assert.ok(rc.slDistance >= atr * 1.5, `SL distance ${rc.slDistance} must be ≥ 1.5×ATR`);
      assert.ok(Math.abs(rc.slDistance - atr * 1.7) < 1e-9, "SL distance should be ~1.7×ATR");
      assert.ok(rc.riskReward <= 2.5, `RR ${rc.riskReward} must be ≤ 2.5`);
    });

    it("P0.6: skips the trade when no structural target sits within the RR cap", () => {
      // support 95 → range 8 → measured-move target ~7.5×ATR away → RR would exceed 2.5.
      const ind = makeBreakoutRetestSeries({ support: 95 });
      const signals = runLoop(strategy, ind, { symbol: "SYNTHBR_FAR" });
      assert.strictEqual(signals.length, 0, "Unreachable structural target must skip (return null)");
    });
  });
});

// ── Test Summary ───────────────────────────────────────────────────────
console.log("\n✅ BreakoutTradingStrategy Unit Tests");
console.log("   - Level detection: 3 tests");
console.log("   - Consolidation / volatility floor: 4 tests");
console.log("   - Breakout detection: 5 tests");
console.log("   - Retest entry: 4 tests");
console.log("   - Risk configuration: 3 tests");
console.log("   - LONG & SHORT handling: 3 tests");
console.log("   - Configuration + SL/TP geometry: 10 tests");
console.log("   - Entry validation: 4 tests");
console.log("   - Confidence grading (Bug 3): 2 tests");
console.log("   - detectSignal SL/TP + skip (Bug 1/2): 3 tests");
console.log("   Total: 41 tests\n");
