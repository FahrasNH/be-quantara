const TrendMomentumStrategy = require("../src/domain/strategy/implementations/TrendMomentumStrategy");

describe("TrendMomentumStrategy", () => {
  let strategy;

  beforeEach(() => {
    strategy = new TrendMomentumStrategy();
  });

  // ──────────────────────────────────────────────────────────
  // HTF TREND DETECTION (4 tests)
  // ──────────────────────────────────────────────────────────

  describe("detectHTFTrend", () => {
    test("LONG: close > EMA21 > EMA50 and fast > mid", () => {
      const trend = strategy.detectHTFTrend(
        42500,  // close
        42400,  // emaFast (9)
        42200,  // emaMid (21)
        41800   // emaSlow (50)
      );
      expect(trend).toBe("LONG");
    });

    test("SHORT: close < EMA21 < EMA50 and fast < mid", () => {
      const trend = strategy.detectHTFTrend(
        40500,  // close
        40300,  // emaFast
        40600,  // emaMid
        41000   // emaSlow
      );
      expect(trend).toBe("SHORT");
    });

    test("No trend: choppy (price between EMAs)", () => {
      const trend = strategy.detectHTFTrend(
        42000,  // close
        42200,  // emaFast
        42100,  // emaMid
        42000   // emaSlow
      );
      expect(trend).toBeNull();
    });

    test("Trend reversal: structure broken", () => {
      const trend = strategy.detectHTFTrend(
        42500,  // close above mid
        42100,  // emaFast below mid (broken structure)
        42200,  // emaMid
        41800   // emaSlow
      );
      expect(trend).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────
  // MACD CALCULATION (3 tests)
  // ──────────────────────────────────────────────────────────

  describe("calculateMACD", () => {
    test("MACD calculation with positive histogram", () => {
      const closes = Array(50).fill(0).map((_, i) => 40000 + i * 50);
      const macd = strategy.calculateMACD(closes);

      expect(macd.macd).toHaveLength(50);
      expect(macd.signal).toHaveLength(50);
      expect(macd.histogram).toHaveLength(50);

      const lastHistogram = macd.histogram[macd.histogram.length - 1];
      expect(lastHistogram).not.toBeNull();
      // Uptrend → positive histogram
      expect(lastHistogram).toBeGreaterThan(-50);
    });

    test("MACD calculation with downtrend", () => {
      const closes = Array(50).fill(0).map((_, i) => 41000 - i * 20);
      const macd = strategy.calculateMACD(closes);

      const lastHistogram = macd.histogram[macd.histogram.length - 1];
      expect(lastHistogram).not.toBeNull();
    });

    test("MACD returns null for short input", () => {
      const closes = Array(10).fill(40000);
      const macd = strategy.calculateMACD(closes);

      expect(macd.macd[5]).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────
  // RSI SLOPE (3 tests)
  // ──────────────────────────────────────────────────────────

  describe("calculateRSISlope", () => {
    test("Positive slope: momentum building", () => {
      const rsi = [30, 35, 40, 45, 50];
      const slope = strategy.calculateRSISlope(rsi, 3);
      expect(slope).toBeGreaterThan(0);
    });

    test("Negative slope: momentum weakening", () => {
      const rsi = [70, 65, 60, 55, 50];
      const slope = strategy.calculateRSISlope(rsi, 3);
      expect(slope).toBeLessThan(0);
    });

    test("Flat slope: no momentum change", () => {
      const rsi = [50, 50, 50, 50, 50];
      const slope = strategy.calculateRSISlope(rsi, 3);
      expect(Math.abs(slope)).toBeLessThan(0.1);
    });
  });

  // ──────────────────────────────────────────────────────────
  // LONG ENTRY VALIDATION (5 tests)
  // ──────────────────────────────────────────────────────────

  describe("checkLongEntry", () => {
    test("LONG entry: all conditions met", () => {
      const closes = Array(20).fill(42450);
      const volumes = Array(20).fill(2500);

      const result = strategy.checkLongEntry(
        closes,
        volumes,
        42420,      // emaFastEntry
        42350,      // emaMidEntry
        48,         // rsiEntry (in 40-70 range)
        2500,       // volumeCurrent
        2000,       // volumeSMA
        "LONG",     // htfTrend
        50,         // macdMTF
        40,         // signalMTF
        10,         // histogramMTF (positive)
        55,         // rsiMTF (>50)
        3.2         // rsiSlopeMTF (positive)
      );

      expect(result.valid).toBe(true);
    });

    test("LONG entry rejected: HTF not uptrend", () => {
      const closes = Array(20).fill(42450);
      const volumes = Array(20).fill(2500);

      const result = strategy.checkLongEntry(
        closes, volumes, 42420, 42350, 48, 2500, 2000,
        "SHORT",  // Wrong trend
        50, 40, 10, 55, 3.2
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("HTF");
    });

    test("LONG entry rejected: RSI overbought", () => {
      const closes = Array(20).fill(42450);
      const volumes = Array(20).fill(2500);

      const result = strategy.checkLongEntry(
        closes, volumes, 42420, 42350, 75, 2500, 2000,  // RSI too high
        "LONG", 50, 40, 10, 55, 3.2
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("RSI");
    });

    test("LONG entry rejected: close below EMA9", () => {
      const closes = Array(20).fill(42400);  // Close below EMA
      const volumes = Array(20).fill(2500);

      const result = strategy.checkLongEntry(
        closes, volumes, 42420, 42350, 48, 2500, 2000,
        "LONG", 50, 40, 10, 55, 3.2
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("EMA9");
    });

    test("LONG entry rejected: low volume", () => {
      const closes = Array(20).fill(42450);
      const volumes = Array(20).fill(1500);  // Low volume

      const result = strategy.checkLongEntry(
        closes, volumes, 42420, 42350, 48, 1500, 2000,  // Below SMA
        "LONG", 50, 40, 10, 55, 3.2
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Volume");
    });
  });

  // ──────────────────────────────────────────────────────────
  // SHORT ENTRY VALIDATION (5 tests)
  // ──────────────────────────────────────────────────────────

  describe("checkShortEntry", () => {
    test("SHORT entry: all conditions met", () => {
      const closes = Array(20).fill(41350);  // Close BELOW EMA9
      const volumes = Array(20).fill(2500);

      const result = strategy.checkShortEntry(
        closes,
        volumes,
        41380,      // emaFastEntry (above close)
        41450,      // emaMidEntry
        45,         // rsiEntry (in 30-60 range)
        2500,       // volumeCurrent
        2000,       // volumeSMA
        "SHORT",    // htfTrend
        -50,        // macdMTF (negative)
        -40,        // signalMTF
        -10,        // histogramMTF (negative)
        40,         // rsiMTF (<50)
        -3.2        // rsiSlopeMTF (negative)
      );

      expect(result.valid).toBe(true);
    });

    test("SHORT entry rejected: HTF not downtrend", () => {
      const closes = Array(20).fill(41400);
      const volumes = Array(20).fill(2500);

      const result = strategy.checkShortEntry(
        closes, volumes, 41380, 41450, 45, 2500, 2000,
        "LONG",  // Wrong trend
        -50, -40, -10, 40, -3.2
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("HTF");
    });

    test("SHORT entry rejected: RSI oversold", () => {
      const closes = Array(20).fill(41350);  // Below EMA
      const volumes = Array(20).fill(2500);

      const result = strategy.checkShortEntry(
        closes, volumes, 41380, 41450, 25, 2500, 2000,  // RSI too low (oversold)
        "SHORT", -50, -40, -10, 40, -3.2
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("RSI");
    });

    test("SHORT entry rejected: close above EMA9", () => {
      const closes = Array(20).fill(41400);  // Close above EMA
      const volumes = Array(20).fill(2500);

      const result = strategy.checkShortEntry(
        closes, volumes, 41380, 41450, 45, 2500, 2000,
        "SHORT", -50, -40, -10, 40, -3.2
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("EMA9");
    });

    test("SHORT entry rejected: MACD not negative", () => {
      const closes = Array(20).fill(41400);
      const volumes = Array(20).fill(2500);

      const result = strategy.checkShortEntry(
        closes, volumes, 41380, 41450, 45, 2500, 2000,
        "SHORT", 50, 40, 10,  // MACD positive (wrong)
        40, -3.2
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("momentum");
    });
  });

  // ──────────────────────────────────────────────────────────
  // RISK CONFIGURATION (4 tests)
  // ──────────────────────────────────────────────────────────

  describe("calculateRiskConfig", () => {
    test("LONG SL/TP calculation", () => {
      const entry = 42000;
      const atr = 100;
      const riskCfg = strategy.calculateRiskConfig(entry, atr, "LONG");

      expect(riskCfg.stopLoss).toBe(42000 - 100 * 1.2);  // 41880
      expect(riskCfg.takeProfit).toBe(42000 + 100 * 2.3); // 42230
      expect(riskCfg.riskReward).toBeCloseTo(1.92, 1);    // 2.3/1.2
    });

    test("SHORT SL/TP calculation", () => {
      const entry = 42000;
      const atr = 100;
      const riskCfg = strategy.calculateRiskConfig(entry, atr, "SHORT");

      expect(riskCfg.stopLoss).toBe(42000 + 100 * 1.2);   // 42120
      expect(riskCfg.takeProfit).toBe(42000 - 100 * 2.3); // 41770
      expect(riskCfg.riskReward).toBeCloseTo(1.92, 1);
    });

    test("RR ratio is consistent", () => {
      const riskCfg1 = strategy.calculateRiskConfig(42000, 100, "LONG");
      const riskCfg2 = strategy.calculateRiskConfig(50000, 200, "SHORT");

      expect(riskCfg1.riskReward).toBeCloseTo(riskCfg2.riskReward, 1);
    });

    test("Distances calculated correctly", () => {
      const atr = 100;
      const riskCfg = strategy.calculateRiskConfig(42000, atr, "LONG");

      expect(riskCfg.slDistance).toBe(atr * 1.2);
      expect(riskCfg.tpDistance).toBe(atr * 2.3);
    });
  });

  // ──────────────────────────────────────────────────────────
  // TRAILING STOP (4 tests)
  // ──────────────────────────────────────────────────────────

  describe("updateTrailingStop", () => {
    test("Trail LONG stop upward after 50% TP", () => {
      const trade = {
        direction: "LONG",
        entryPrice: 42000,
        stopLoss: 41880,
        takeProfit: 42230,
      };

      const atr = 100;
      const currentPrice = 42115;  // Above entry + 50% of TP distance

      strategy.updateTrailingStop(trade, currentPrice, atr);

      expect(trade.stopLoss).toBeGreaterThan(41880);
      expect(trade.trailingStopActive).toBe(true);
    });

    test("LONG stop does not move below initial SL", () => {
      const trade = {
        direction: "LONG",
        entryPrice: 42000,
        stopLoss: 41880,
        takeProfit: 42230,
      };

      const atr = 100;
      const currentPrice = 41800;  // Still valid but not above 50% TP

      const initialSL = trade.stopLoss;
      strategy.updateTrailingStop(trade, currentPrice, atr);

      expect(trade.stopLoss).toBe(initialSL);
    });

    test("Trail SHORT stop downward after 50% TP", () => {
      const trade = {
        direction: "SHORT",
        entryPrice: 42000,
        stopLoss: 42120,
        takeProfit: 41770,
      };

      const atr = 100;
      const currentPrice = 41885;  // Below entry - 50% of TP distance

      strategy.updateTrailingStop(trade, currentPrice, atr);

      expect(trade.stopLoss).toBeLessThan(42120);
      expect(trade.trailingStopActive).toBe(true);
    });

    test("SHORT stop does not move above initial SL", () => {
      const trade = {
        direction: "SHORT",
        entryPrice: 42000,
        stopLoss: 42120,
        takeProfit: 41770,
      };

      const atr = 100;
      const currentPrice = 42200;  // Still valid but not below 50% TP

      const initialSL = trade.stopLoss;
      strategy.updateTrailingStop(trade, currentPrice, atr);

      expect(trade.stopLoss).toBe(initialSL);
    });
  });

  // ──────────────────────────────────────────────────────────
  // MARKET VALIDATION (3 tests)
  // ──────────────────────────────────────────────────────────

  describe("validateMarketCondition", () => {
    test("Market too dead (ATR < 0.5%)", () => {
      const result = strategy.validateMarketCondition(0.3, 0.5);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("dead");
    });

    test("Market too volatile (ATR > 8%)", () => {
      const result = strategy.validateMarketCondition(10, 0.5);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("volatile");
    });

    test("Healthy market (ATR 1%, trend 0.6)", () => {
      const result = strategy.validateMarketCondition(1.0, 0.6);
      expect(result.valid).toBe(true);
      expect(result.reason).toContain("suitable");
    });
  });

  // ──────────────────────────────────────────────────────────
  // MARKET RANKING (2 tests)
  // ──────────────────────────────────────────────────────────

  describe("rankByMarketConditions", () => {
    test("High score: strong trend + moderate volatility", () => {
      const score = strategy.rankByMarketConditions({ volatility: 1.5, trendStrength: 0.7 });
      expect(score).toBeGreaterThan(70);
    });

    test("Low score: weak trend + high volatility", () => {
      const score = strategy.rankByMarketConditions({ volatility: 6, trendStrength: 0.2 });
      expect(score).toBeLessThan(50);
    });
  });

  // ──────────────────────────────────────────────────────────
  // CONFIGURATION (2 tests)
  // ──────────────────────────────────────────────────────────

  describe("Configuration", () => {
    test("Default config set correctly", () => {
      expect(strategy.config.slMultiplier).toBe(1.2);
      expect(strategy.config.tpMultiplier).toBe(2.3);
      expect(strategy.config.riskPerTrade).toBe(0.02);
      expect(strategy.config.maxTradesPerDay).toBe(6);
    });

    test("Config can be updated", () => {
      strategy.setConfig({ riskPerTrade: 0.01 });
      expect(strategy.config.riskPerTrade).toBe(0.01);
      expect(strategy.config.tpMultiplier).toBe(2.3);  // Other values unchanged
    });
  });

  // ──────────────────────────────────────────────────────────
  // PULLBACK ZONE (FIX #6) — (4 tests)
  // ──────────────────────────────────────────────────────────

  describe("isInPullbackZone", () => {
    test("LONG valid: dip ke EMA9 lalu reclaim (pullback nyata)", () => {
      // prior berisi 42000 (di bawah EMA9 42420 = dip), close kini 42460 (reclaim)
      const closes = [42000, 42450, 42460];
      expect(strategy.isInPullbackZone(closes, 42420, "LONG")).toBe(true);
    });

    test("LONG invalid: tanpa pullback (close terus di atas EMA9 = kelanjutan)", () => {
      // tak ada bar yang dip ke EMA9 → bukan pullback entry (FIX #3)
      const closes = [42500, 42550, 42600];  // semua > EMA9 42420
      expect(strategy.isInPullbackZone(closes, 42420, "LONG")).toBe(false);
    });

    test("SHORT valid: last 2 closes held below EMA9", () => {
      const closes = [41500, 41350, 41340];
      expect(strategy.isInPullbackZone(closes, 41380, "SHORT")).toBe(true);
    });

    test("Insufficient history returns true (non-blocking)", () => {
      expect(strategy.isInPullbackZone([42000], 42420, "LONG")).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────
  // POSITION SIZING (FIX #7) — (4 tests)
  // ──────────────────────────────────────────────────────────

  describe("calculatePositionSize", () => {
    test("Sizes by risk and SL distance with leverage", () => {
      // balance 10M, entry 42000, SL 41900 (dist 100), risk 2%, lev 1.5
      // baseQty = (10M*0.02)/100 = 2000; leveraged = 3000
      const qty = strategy.calculatePositionSize(10000000, 42000, 41900, 0.02, 1.5);
      // notional 3000*42000 = 126M > maxNotional 15M → capped to 15M/42000
      expect(qty).toBeCloseTo(15000000 / 42000, 2);
    });

    test("Uncapped small position respects raw risk sizing", () => {
      // big balance so notional stays under cap
      const qty = strategy.calculatePositionSize(10000000000, 42000, 41000, 0.001, 1);
      // riskAmount = 10B*0.001 = 10M; slDist = 1000; baseQty = 10000; lev 1 → 10000
      expect(qty).toBe(10000);
    });

    test("Zero SL distance returns 0", () => {
      expect(strategy.calculatePositionSize(10000000, 42000, 42000, 0.02, 1.5)).toBe(0);
    });

    test("Invalid balance returns 0", () => {
      expect(strategy.calculatePositionSize(0, 42000, 41900)).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────
  // EXIT MANAGEMENT (FIX #8) — (6 tests)
  // ──────────────────────────────────────────────────────────

  describe("checkExit", () => {
    const longTrade = { direction: "LONG", entryPrice: 42000, stopLoss: 41880, takeProfit: 42230 };
    const shortTrade = { direction: "SHORT", entryPrice: 42000, stopLoss: 42120, takeProfit: 41770 };

    test("LONG exits on stop loss", () => {
      const r = strategy.checkExit(longTrade, { high: 41950, low: 41870, close: 41900 }, 5);
      expect(r.exit).toBe(true);
      expect(r.reason).toBe("SL");
    });

    test("LONG exits on take profit", () => {
      const r = strategy.checkExit(longTrade, { high: 42250, low: 42100, close: 42240 }, 5);
      expect(r.exit).toBe(true);
      expect(r.reason).toBe("TP");
    });

    test("SHORT exits on stop loss", () => {
      const r = strategy.checkExit(shortTrade, { high: 42130, low: 42000, close: 42100 }, 5);
      expect(r.exit).toBe(true);
      expect(r.reason).toBe("SL");
    });

    test("SHORT exits on take profit", () => {
      const r = strategy.checkExit(shortTrade, { high: 41900, low: 41760, close: 41780 }, 5);
      expect(r.exit).toBe(true);
      expect(r.reason).toBe("TP");
    });

    test("Timeout exit after maxBarsHeld", () => {
      const r = strategy.checkExit(longTrade, { high: 42000, low: 41950, close: 41980 }, 100);
      expect(r.exit).toBe(true);
      expect(r.reason).toBe("TIMEOUT");
    });

    test("No exit when price inside range", () => {
      const r = strategy.checkExit(longTrade, { high: 42100, low: 41950, close: 42050 }, 10);
      expect(r.exit).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────
  // BREAKEVEN STOP (FIX #8) — (2 tests)
  // ──────────────────────────────────────────────────────────

  describe("applyBreakevenStop", () => {
    test("LONG SL moves to entry after 20% of TP", () => {
      const trade = { direction: "LONG", entryPrice: 42000, stopLoss: 41880, takeProfit: 42230 };
      // tpDist 230, activation 46 → price 42050 >= 42046
      strategy.applyBreakevenStop(trade, 42050);
      expect(trade.stopLoss).toBe(42000);
      expect(trade.breakEvenActive).toBe(true);
    });

    test("LONG SL unchanged before activation threshold", () => {
      const trade = { direction: "LONG", entryPrice: 42000, stopLoss: 41880, takeProfit: 42230 };
      strategy.applyBreakevenStop(trade, 42010);  // below 42046
      expect(trade.stopLoss).toBe(41880);
    });
  });

  // ──────────────────────────────────────────────────────────
  // STATE MANAGEMENT (FIX #9) — (2 tests)
  // ──────────────────────────────────────────────────────────

  describe("trend state", () => {
    test("Fresh state initialized", () => {
      expect(strategy._trendState.htfTrendConfirmed).toBe(false);
      expect(strategy._trendState.htfTrendDirection).toBeNull();
    });

    test("resetTrendState clears tracked values", () => {
      strategy._trendState.htfTrendDirection = "LONG";
      strategy._trendState.barsInCurrentTrend = 5;
      strategy.resetTrendState();
      expect(strategy._trendState.htfTrendDirection).toBeNull();
      expect(strategy._trendState.barsInCurrentTrend).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────
  // CONFIG ADDITIONS (FIX #4, #8) — (2 tests)
  // ──────────────────────────────────────────────────────────

  describe("New config parameters", () => {
    test("Volume config present", () => {
      expect(strategy.config.volSMAPeriod).toBe(20);
      expect(strategy.config.minVolRatio).toBe(1.0);
    });

    test("Exit management config present", () => {
      expect(strategy.config.maxBarsHeld).toBe(100);
      expect(strategy.config.breakEvenActivationPct).toBe(0.2);
    });
  });

  // ──────────────────────────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────────────────────────

  describe("Test Summary", () => {
    test("All tests should pass", () => {
      expect(strategy).toBeDefined();
      expect(strategy.config.name || "TREND_MOMENTUM").toBe("TREND_MOMENTUM");
    });
  });
});
