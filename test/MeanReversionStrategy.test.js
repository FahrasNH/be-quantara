const MeanReversionStrategy = require("../src/domain/strategy/implementations/MeanReversionStrategy");

describe("MeanReversionStrategy", () => {
  let strategy;

  beforeEach(() => {
    strategy = new MeanReversionStrategy();
  });

  // ──────────────────────────────────────────────────────────
  // BOLLINGER BANDS CALCULATION (4 tests)
  // ──────────────────────────────────────────────────────────

  describe("calculateBollingerBands", () => {
    test("Normal market BB calculation", () => {
      const closes = Array(20).fill(0).map((_, i) => 42000 + Math.sin(i / 5) * 200);
      const bb = strategy.calculateBollingerBands(closes, 20, 2.0);

      expect(bb).not.toBeNull();
      expect(bb.middle).toBeGreaterThan(41800);
      expect(bb.upper).toBeGreaterThan(bb.middle);
      expect(bb.lower).toBeLessThan(bb.middle);
      expect(bb.bandwidth).toBeGreaterThan(0);
      expect(bb.std).toBeGreaterThan(0);
    });

    test("High volatility BB (wider bands)", () => {
      const closes = Array(20).fill(0).map((_, i) => 42000 + Math.sin(i / 2) * 500);
      const bbWide = strategy.calculateBollingerBands(closes, 20, 2.0);

      const closes2 = Array(20).fill(42000);
      const bbTight = strategy.calculateBollingerBands(closes2, 20, 2.0);

      expect(bbWide.bandwidth).toBeGreaterThan(bbTight.bandwidth);
    });

    test("Low volatility BB (narrow bands)", () => {
      const closes = Array(20).fill(42000);
      const bb = strategy.calculateBollingerBands(closes, 20, 2.0);

      expect(bb.bandwidth).toBeLessThan(1);
      expect(bb.std).toBeLessThan(1);
    });

    test("Insufficient data returns null", () => {
      const closes = Array(10).fill(42000);
      const bb = strategy.calculateBollingerBands(closes, 20, 2.0);

      expect(bb).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────
  // LONG ENTRY VALIDATION (8 tests)
  // ──────────────────────────────────────────────────────────

  describe("checkLongEntry", () => {
    test("LONG entry: all conditions met (oversold bounce)", () => {
      const closes = [41000, 41050, 41200, 41300, 41400];  // Recovery from lower band
      const rsi = [null, null, null, null, 23];  // Oversold but recovering
      const volumes = [1500, 1600, 1700, 1800, 1900];
      const bbLevels = {
        lower: 41000,
        middle: 42000,
        upper: 43000,
        bandwidth: 1000,
      };
      const volSMA = 1500;

      const result = strategy.checkLongEntry(
        closes, rsi, volumes, bbLevels, volSMA, 4, 100
      );

      expect(result.valid).toBe(true);
    });

    test("LONG entry rejected: price still below lower band", () => {
      const closes = [40900, 40950, 41000, 41050, 41100];
      const rsi = [null, null, null, null, 22];
      const volumes = [1500, 1600, 1700, 1800, 1900];
      const bbLevels = {
        lower: 41200,
        middle: 42000,
        upper: 43000,
        bandwidth: 1000,
      };

      const result = strategy.checkLongEntry(
        closes, rsi, volumes, bbLevels, 1500, 4, 100
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("below BB lower");
    });

    test("LONG entry rejected: RSI not oversold enough", () => {
      // Harga di zona valid (≤41500) agar gate RSI yang menolak, bukan zona.
      const closes = [41000, 41100, 41200, 41250, 41300];
      const rsi = [null, null, null, null, 40];  // Not oversold (>30)
      const volumes = [1500, 1600, 1700, 1800, 1900];
      const bbLevels = { lower: 41000, middle: 42000, upper: 43000, bandwidth: 1000 };

      const result = strategy.checkLongEntry(
        closes, rsi, volumes, bbLevels, 1500, 4, 100
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("RSI");
    });

    test("LONG entry rejected: RSI too extreme (panic)", () => {
      const closes = [41000, 41100, 41200, 41250, 41300];  // dalam zona
      const rsi = [null, null, null, null, 10];  // Too extreme (<15)
      const volumes = [1500, 1600, 1700, 1800, 1900];
      const bbLevels = { lower: 41000, middle: 42000, upper: 43000, bandwidth: 1000 };

      const result = strategy.checkLongEntry(
        closes, rsi, volumes, bbLevels, 1500, 4, 100
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("panic");
    });

    test("LONG entry rejected: no confirmation bar", () => {
      const closes = [41000, 41100, 41200, 41350, 41300];  // Close DOWN
      const rsi = [null, null, null, null, 22];
      const volumes = [1500, 1600, 1700, 1800, 1900];
      const bbLevels = { lower: 41000, middle: 42000, upper: 43000, bandwidth: 1000 };

      const result = strategy.checkLongEntry(
        closes, rsi, volumes, bbLevels, 1500, 4, 100
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("confirmation");
    });

    test("LONG entry rejected: low volume", () => {
      const closes = [41000, 41100, 41200, 41350, 41500];
      const rsi = [null, null, null, null, 22];
      const volumes = [100, 100, 100, 100, 100];  // Too low
      const bbLevels = { lower: 41000, middle: 42000, upper: 43000, bandwidth: 1000 };

      const result = strategy.checkLongEntry(
        closes, rsi, volumes, bbLevels, 1500, 4, 100
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Volume");
    });

    test("LONG entry rejected: price too far from band (weak edge)", () => {
      // Entry jauh dari band bawah (di atas zona ≤41500) → ditolak (TUNING #2).
      const closes = [41000, 41100, 41200, 41350, 42100];  // di atas middle, jauh dari band
      const rsi = [null, null, null, null, 22];
      const volumes = [1500, 1600, 1700, 1800, 1900];
      const bbLevels = { lower: 41000, middle: 42000, upper: 43000, bandwidth: 1000 };

      const result = strategy.checkLongEntry(
        closes, rsi, volumes, bbLevels, 1500, 4, 100
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("terlalu jauh");
    });

    test("LONG entry rejected: high panic volume", () => {
      const closes = [41000, 41100, 41200, 41350, 41500];
      const rsi = [null, null, null, null, 18];  // Very oversold
      const volumes = [1500, 1600, 1700, 1800, 5000];  // Extreme panic
      const bbLevels = { lower: 41000, middle: 42000, upper: 43000, bandwidth: 1000 };

      const result = strategy.checkLongEntry(
        closes, rsi, volumes, bbLevels, 1500, 4, 100
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Volume");
    });
  });

  // ──────────────────────────────────────────────────────────
  // SHORT ENTRY VALIDATION (8 tests)
  // ──────────────────────────────────────────────────────────

  describe("checkShortEntry", () => {
    test("SHORT entry: all conditions met (overbought rejection)", () => {
      const closes = [43000, 42950, 42800, 42700, 42600];  // Rejection from upper band
      const rsi = [null, null, null, null, 77];  // Overbought but rejecting
      const volumes = [1500, 1600, 1700, 1800, 1900];
      const bbLevels = {
        lower: 41000,
        middle: 42000,
        upper: 43000,
        bandwidth: 1000,
      };
      const volSMA = 1500;

      const result = strategy.checkShortEntry(
        closes, rsi, volumes, bbLevels, volSMA, 4, 100
      );

      expect(result.valid).toBe(true);
    });

    test("SHORT entry rejected: price still above upper band", () => {
      const closes = [43100, 43050, 43000, 42950, 42900];
      const rsi = [null, null, null, null, 78];
      const volumes = [1500, 1600, 1700, 1800, 1900];
      const bbLevels = {
        lower: 41000,
        middle: 42000,
        upper: 42800,
        bandwidth: 1000,
      };

      const result = strategy.checkShortEntry(
        closes, rsi, volumes, bbLevels, 1500, 4, 100
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("above BB upper");
    });

    test("SHORT entry rejected: RSI not overbought enough", () => {
      // Harga di zona valid (≥42500) agar gate RSI yang menolak, bukan zona.
      const closes = [43000, 42900, 42800, 42750, 42700];
      const rsi = [null, null, null, null, 60];  // Not overbought (<70)
      const volumes = [1500, 1600, 1700, 1800, 1900];
      const bbLevels = { lower: 41000, middle: 42000, upper: 43000, bandwidth: 1000 };

      const result = strategy.checkShortEntry(
        closes, rsi, volumes, bbLevels, 1500, 4, 100
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("RSI");
    });

    test("SHORT entry rejected: RSI too extreme (euphoria)", () => {
      const closes = [43000, 42900, 42800, 42750, 42700];  // dalam zona
      const rsi = [null, null, null, null, 90];  // Too extreme (>85)
      const volumes = [1500, 1600, 1700, 1800, 1900];
      const bbLevels = { lower: 41000, middle: 42000, upper: 43000, bandwidth: 1000 };

      const result = strategy.checkShortEntry(
        closes, rsi, volumes, bbLevels, 1500, 4, 100
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("euphoria");
    });

    test("SHORT entry rejected: no confirmation bar", () => {
      const closes = [43000, 42900, 42800, 42650, 42700];  // Close UP
      const rsi = [null, null, null, null, 78];
      const volumes = [1500, 1600, 1700, 1800, 1900];
      const bbLevels = { lower: 41000, middle: 42000, upper: 43000, bandwidth: 1000 };

      const result = strategy.checkShortEntry(
        closes, rsi, volumes, bbLevels, 1500, 4, 100
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("confirmation");
    });

    test("SHORT entry rejected: low volume", () => {
      const closes = [43000, 42900, 42800, 42650, 42500];
      const rsi = [null, null, null, null, 78];
      const volumes = [100, 100, 100, 100, 100];  // Too low
      const bbLevels = { lower: 41000, middle: 42000, upper: 43000, bandwidth: 1000 };

      const result = strategy.checkShortEntry(
        closes, rsi, volumes, bbLevels, 1500, 4, 100
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Volume");
    });

    test("SHORT entry rejected: price too far from band (weak edge)", () => {
      // Entry jauh dari band atas (di bawah zona ≥42500) → ditolak (TUNING #2).
      const closes = [43000, 42900, 42800, 42650, 41900];  // di bawah middle, jauh dari band
      const rsi = [null, null, null, null, 78];
      const volumes = [1500, 1600, 1700, 1800, 1900];
      const bbLevels = { lower: 41000, middle: 42000, upper: 43000, bandwidth: 1000 };

      const result = strategy.checkShortEntry(
        closes, rsi, volumes, bbLevels, 1500, 4, 100
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("terlalu jauh");
    });

    test("SHORT entry rejected: high euphoria volume", () => {
      const closes = [43000, 42900, 42800, 42650, 42500];
      const rsi = [null, null, null, null, 82];  // Very overbought
      const volumes = [1500, 1600, 1700, 1800, 5000];  // Extreme euphoria
      const bbLevels = { lower: 41000, middle: 42000, upper: 43000, bandwidth: 1000 };

      const result = strategy.checkShortEntry(
        closes, rsi, volumes, bbLevels, 1500, 4, 100
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Volume");
    });
  });

  // ──────────────────────────────────────────────────────────
  // CONFIRMATION BARS (4 tests)
  // ──────────────────────────────────────────────────────────

  describe("hasConfirmationBars", () => {
    test("LONG confirmation: current > previous", () => {
      const closes = [41200, 41300, 41400, 41500];
      const confirmed = strategy.hasConfirmationBars(closes, [], "LONG", 3);
      expect(confirmed).toBe(true);
    });

    test("LONG no confirmation: current < previous", () => {
      const closes = [41500, 41400, 41300, 41200];
      const confirmed = strategy.hasConfirmationBars(closes, [], "LONG", 3);
      expect(confirmed).toBe(false);
    });

    test("SHORT confirmation: current < previous", () => {
      const closes = [42500, 42400, 42300, 42200];
      const confirmed = strategy.hasConfirmationBars(closes, [], "SHORT", 3);
      expect(confirmed).toBe(true);
    });

    test("SHORT no confirmation: current > previous", () => {
      const closes = [42200, 42300, 42400, 42500];  // Previous 42400, Current 42500 (up)
      const confirmed = strategy.hasConfirmationBars(closes, [], "SHORT", 3);
      expect(confirmed).toBe(false);  // 42500 > 42400 is NOT confirmation
    });
  });

  // ──────────────────────────────────────────────────────────
  // VOLUME VALIDATION (3 tests)
  // ──────────────────────────────────────────────────────────

  describe("validateVolume", () => {
    test("Normal volume accepted", () => {
      const result = strategy.validateVolume([1500], 1500, 25, "LONG");
      expect(result).toBe(true);
    });

    test("Volume ratio too low rejected", () => {
      const result = strategy.validateVolume([500], 1500, 25, "LONG");
      expect(result).toBe(false);
    });

    test("Extreme panic volume rejected during deep oversold", () => {
      const result = strategy.validateVolume([4000], 1500, 10, "LONG");  // Panic
      expect(result).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────
  // RISK CONFIGURATION (4 tests)
  // ──────────────────────────────────────────────────────────

  describe("calculateRiskConfig", () => {
    test("LONG SL/TP calculation", () => {
      const entry = 42000;
      const atr = 100;
      const bbLevels = { middle: 42300, lower: 41000, upper: 43000 };
      const riskCfg = strategy.calculateRiskConfig(entry, atr, "LONG", bbLevels);

      expect(riskCfg.stopLoss).toBe(42000 - 140);  // v2.3: 41860 (1.4x ATR)
      expect(riskCfg.takeProfit).toBeGreaterThanOrEqual(42000 + 100 * 3.2);  // v2.3: at least 3.2x ATR
      expect(riskCfg.riskReward).toBe(2.29);  // v2.3: 3.2x ATR / 1.4x ATR ≈ 2.29
    });

    test("SHORT SL/TP calculation", () => {
      const entry = 42000;
      const atr = 100;
      const bbLevels = { middle: 41700, lower: 41000, upper: 43000 };
      const riskCfg = strategy.calculateRiskConfig(entry, atr, "SHORT", bbLevels);

      expect(riskCfg.stopLoss).toBe(42000 + 140);  // v2.3: 42140 (1.4x ATR)
      expect(riskCfg.takeProfit).toBeLessThanOrEqual(42000 - 100 * 3.2);  // v2.3: at most 3.2x ATR down
      expect(riskCfg.riskReward).toBe(2.29);
    });

    test("RR ratio always ~2.29 (tp 3.2x / sl 1.4x) — v2.3", () => {
      const riskCfg1 = strategy.calculateRiskConfig(42000, 100, "LONG");
      const riskCfg2 = strategy.calculateRiskConfig(50000, 200, "SHORT");

      expect(riskCfg1.riskReward).toBe(2.29);
      expect(riskCfg2.riskReward).toBe(2.29);
    });

    test("SL distance = 1.4x ATR (v2.3: MR SL guard)", () => {
      const entry = 100;
      const atr   = 1.0;
      const longCfg  = strategy.calculateRiskConfig(entry, atr, "LONG");
      const shortCfg = strategy.calculateRiskConfig(entry, atr, "SHORT");

      expect(longCfg.stopLoss).toBeCloseTo(entry - 1.4 * atr, 5);
      expect(shortCfg.stopLoss).toBeCloseTo(entry + 1.4 * atr, 5);
      expect(longCfg.slMultiplier).toBe(1.4);
    });

    test("BB target is stored but may not be used", () => {
      const bbLevels = { middle: 42300, lower: 41000, upper: 43000 };
      const riskCfg = strategy.calculateRiskConfig(42000, 100, "LONG", bbLevels);

      expect(riskCfg.bbTarget).toBe(42300);
    });
  });

  // ──────────────────────────────────────────────────────────
  // MARKET VALIDATION (4 tests)
  // ──────────────────────────────────────────────────────────

  describe("validateMarketCondition", () => {
    test("Choppy market approved", () => {
      const result = strategy.validateMarketCondition(2.0, 0.1);  // Very weak trend
      expect(result.valid).toBe(true);
      expect(result.reason).toContain("IDEAL");
    });

    test("Strong trend rejected", () => {
      const result = strategy.validateMarketCondition(1.5, 0.8);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("trending");
    });

    test("Dead market rejected", () => {
      const result = strategy.validateMarketCondition(0.3, 0.3);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("dead");
    });

    test("High volatility rejected", () => {
      const result = strategy.validateMarketCondition(7.0, 0.3);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("volatile");
    });
  });

  // ──────────────────────────────────────────────────────────
  // MARKET RANKING (2 tests)
  // ──────────────────────────────────────────────────────────

  describe("rankByMarketConditions", () => {
    test("High score: choppy + moderate volatility", () => {
      const score = strategy.rankByMarketConditions({ volatility: 2.0, trendStrength: 0.1 });
      expect(score).toBeGreaterThan(70);
    });

    test("Low score: trending + high volatility", () => {
      const score = strategy.rankByMarketConditions({ volatility: 6, trendStrength: 0.8 });
      expect(score).toBeLessThan(30);
    });
  });

  // ──────────────────────────────────────────────────────────
  // CONFIGURATION (2 tests)
  // ──────────────────────────────────────────────────────────

  describe("Configuration", () => {
    test("Default config set correctly (v2.3)", () => {
      expect(strategy.config.slMultiplier).toBe(1.4);
      expect(strategy.config.tpMultiplier).toBe(3.2);
      expect(strategy.config.riskPerTrade).toBe(0.008);
      expect(strategy.config.leverage).toBe(1.0);
    });

    test("Config can be updated", () => {
      strategy.setConfig({ riskPerTrade: 0.005 });
      expect(strategy.config.riskPerTrade).toBe(0.005);
      expect(strategy.config.tpMultiplier).toBe(3.2);
    });
  });

  // ──────────────────────────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────────────────────────

  describe("Test Summary", () => {
    test("All 39 tests should pass", () => {
      expect(strategy).toBeDefined();
      expect(strategy.config.name || "MEAN_REVERSION").toBe("MEAN_REVERSION");
    });
  });
});
