/**
 * TrendFollowingStrategy.test.js
 * Minimal smoke tests for Trend Following strategy (TS_TF)
 */

const TrendFollowingStrategy = require("../src/domain/strategy/implementations/TrendFollowingStrategy");

describe("TrendFollowingStrategy", () => {
  let strategy;

  beforeEach(() => {
    strategy = new TrendFollowingStrategy();
  });

  describe("Initialization", () => {
    test("Strategy instantiates with correct name", () => {
      expect(strategy.config.name).toBe("TREND_FOLLOWING");
    });

    test("Strategy has required config properties", () => {
      expect(strategy.config.htfInterval).toBe("1h");
      expect(strategy.config.mtfInterval).toBe("15m");
      expect(strategy.config.entryInterval).toBe("5m");
      expect(strategy.config.adxPeriod).toBe(14);
      expect(strategy.config.donchianPeriod).toBe(20);
    });

    test("Strategy has required methods", () => {
      expect(typeof strategy.detectSignal).toBe("function");
      expect(typeof strategy.calculateRiskConfig).toBe("function");
      expect(typeof strategy.calculatePositionSize).toBe("function");
      expect(typeof strategy.getLastSignalMeta).toBe("function");
    });
  });

  describe("HTF Trend Detection", () => {
    test("LONG: detects uptrend with aligned EMAs", () => {
      const trend = strategy.detectHTFTrend(
        42500,  // close
        42400,  // emaFastHTF (9)
        42200,  // emaMidHTF (21)
        41800,  // emaSlowHTF (50)
        30      // adxHTF (strong)
      );
      expect(trend).toBe("LONG");
    });

    test("SHORT: detects downtrend with aligned EMAs", () => {
      const trend = strategy.detectHTFTrend(
        40500,  // close
        40300,  // emaFastHTF
        40600,  // emaMidHTF
        41000,  // emaSlowHTF
        32      // adxHTF (strong)
      );
      expect(trend).toBe("SHORT");
    });

    test("No trend: returns null when ADX too low", () => {
      const trend = strategy.detectHTFTrend(
        42500,  // close
        42400,  // emaFastHTF
        42200,  // emaMidHTF
        41800,  // emaSlowHTF
        18      // adxHTF (weak, < 25)
      );
      expect(trend).toBeNull();
    });

    test("No trend: returns null when structure broken", () => {
      const trend = strategy.detectHTFTrend(
        42500,  // close
        42100,  // emaFastHTF (broken alignment)
        42200,  // emaMidHTF
        41800,  // emaSlowHTF
        30      // adxHTF
      );
      expect(trend).toBeNull();
    });
  });

  describe("Risk Configuration", () => {
    test("calculateRiskConfig returns correct SL/TP distances", () => {
      const risk = strategy.calculateRiskConfig(42000, 100, "LONG");
      // SL = 100 × 1.5 = 150, TP = 100 × 3.0 = 300
      expect(risk.slDistance).toBe(150);
      expect(risk.tpDistance).toBe(300);
      expect(risk.riskReward).toBeCloseTo(2.0, 1);
    });

    test("LONG: SL below entry, TP above entry", () => {
      const risk = strategy.calculateRiskConfig(42000, 100, "LONG");
      expect(risk.stopLoss).toBe(41850);  // 42000 - 150
      expect(risk.takeProfit).toBe(42300); // 42000 + 300
    });

    test("SHORT: SL above entry, TP below entry", () => {
      const risk = strategy.calculateRiskConfig(42000, 100, "SHORT");
      expect(risk.stopLoss).toBe(42150);  // 42000 + 150
      expect(risk.takeProfit).toBe(41700); // 42000 - 300
    });
  });

  describe("Position Sizing", () => {
    test("calculates position size from balance and SL distance", () => {
      const size = strategy.calculatePositionSize(
        50000,      // balance
        42000,      // entryPrice
        41850,      // stopLoss (SL distance = 150)
        0.015,      // riskPercentage (1.5%)
        2.0         // leverage
      );
      expect(size).toBeGreaterThan(0);
    });

    test("position size respects leverage limit", () => {
      const size = strategy.calculatePositionSize(
        1000,      // small balance
        42000,     // entryPrice
        41900,     // stopLoss
        0.015,     // riskPercentage
        2.0        // leverage
      );
      const notional = size * 42000;
      expect(notional).toBeLessThanOrEqual(1000 * 2.0 + 1); // Allow 1 unit floating point error
    });
  });

  describe("Config Management", () => {
    test("getConfig returns current strategy config", () => {
      const config = strategy.getConfig();
      expect(config).toBeDefined();
      expect(config.name).toBe("TREND_FOLLOWING");
    });

    test("setConfig updates strategy parameters", () => {
      strategy.setConfig({ riskPerTrade: 0.02 });
      expect(strategy.config.riskPerTrade).toBe(0.02);
    });

    test("risk config and timeframe config methods work", () => {
      const riskCfg = strategy.getRiskConfig();
      expect(riskCfg.maxRiskPerTrade).toBe(0.03);
      expect(riskCfg.leverage).toBe(2.0);

      const tfCfg = strategy.getTimeframeConfig();
      expect(tfCfg.interval).toBe("5m");
      expect(tfCfg.higherTf).toBe("15m");
    });
  });

  describe("Market Validation", () => {
    test("validateMarketCondition rejects dead market (low ATR)", () => {
      const result = strategy.validateMarketCondition(0.3, 30);
      expect(result.valid).toBe(false);
    });

    test("validateMarketCondition rejects weak trend (low ADX)", () => {
      const result = strategy.validateMarketCondition(1.5, 18);
      expect(result.valid).toBe(false);
    });

    test("validateMarketCondition accepts healthy conditions", () => {
      const result = strategy.validateMarketCondition(1.5, 30);
      expect(result.valid).toBe(true);
    });
  });

  describe("Signal Metadata", () => {
    test("getLastSignalMeta returns trend state", () => {
      const meta = strategy.getLastSignalMeta();
      expect(meta.direction).toBeNull();
      expect(meta.htfTrendConfirmed).toBe(false);
      expect(meta.adxStrength).toBe(0);
      expect(meta.donchianBroken).toBe(false);
    });
  });
});
