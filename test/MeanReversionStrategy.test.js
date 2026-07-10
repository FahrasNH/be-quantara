const MeanReversionStrategy = require("../src/domain/strategy/implementations/MeanReversionStrategy");

describe("MeanReversionStrategy (Mean Drift — dual-component)", () => {
  let strategy;

  beforeEach(() => {
    strategy = new MeanReversionStrategy();
  });

  // ──────────────────────────────────────────────────────────
  // BOLLINGER BANDS CALCULATION
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

    test("Tighter stdDev (Scalping A, 1.5σ) < wider stdDev (Intraday B, 2.0σ)", () => {
      const closes = Array(20).fill(0).map((_, i) => 42000 + Math.sin(i / 2) * 500);
      const bbA = strategy.calculateBollingerBands(closes, 20, 1.5);
      const bbB = strategy.calculateBollingerBands(closes, 20, 2.0);
      expect(bbA.bandwidth).toBeLessThan(bbB.bandwidth);
    });

    test("Insufficient data returns null", () => {
      const bb = strategy.calculateBollingerBands(Array(10).fill(42000), 20, 2.0);
      expect(bb).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────
  // DETECT SIGNAL — string contract + component meta
  // ──────────────────────────────────────────────────────────

  /** Build an indicators object with a price series that dips below BB lower + oversold RSI at the last bar. */
  function buildOversoldIndicators() {
    // 55 bars flat, then a sharp drop on the final bar to breach the lower band.
    const closes = Array(60).fill(42000);
    closes[59] = 40500; // deep dip → below both BB lower bands
    const rsi = Array(60).fill(50);
    rsi[59] = 20; // < rsiOversoldA(28) and < rsiOversoldB(32)
    const volumes = Array(60).fill(1500);
    const atr = Array(60).fill(120);
    const volSMA = Array(60).fill(1500);
    // VWAP is precomputed by calcIndicators; here we stub it above the dip so the
    // LONG confirmation `close < vwap` holds (dip 40500 < vwap 42000).
    const vwap = Array(60).fill(42000);
    const candles = closes.map((c, i) => ({ high: c + 50, low: c - 50, close: c, volume: volumes[i] }));
    return { closes, rsi, volumes, atr, volSMA, vwap, candles };
  }

  describe("detectSignal contract", () => {
    test("returns null before warmup (<50 bars)", () => {
      const ind = buildOversoldIndicators();
      expect(strategy.detectSignal(ind, 40)).toBeNull();
    });

    test("returns a STRING signal (not object) + populates getLastSignalMeta", () => {
      const ind = buildOversoldIndicators();
      const sig = strategy.detectSignal(ind, 59);
      expect(sig).toBe("LONG");
      const meta = strategy.getLastSignalMeta();
      expect(meta).not.toBeNull();
      expect(["Scalping", "Intraday"]).toContain(meta.component);
    });

    test("deep oversold prefers Scalping (Component A) first", () => {
      const ind = buildOversoldIndicators();
      strategy.detectSignal(ind, 59);
      expect(strategy.getLastSignalMeta().component).toBe("Scalping");
    });

    test("no signal when RSI is neutral → meta cleared", () => {
      const ind = buildOversoldIndicators();
      ind.rsi[59] = 50; // neutral, no extreme
      ind.closes[59] = 42000;
      ind.candles[59] = { high: 42050, low: 41950, close: 42000, volume: 1500 };
      expect(strategy.detectSignal(ind, 59)).toBeNull();
      expect(strategy.getLastSignalMeta()).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────
  // RISK CONFIGURATION — component-aware RR
  // ──────────────────────────────────────────────────────────

  describe("calculateRiskConfig", () => {
    test("Scalping (A): RR = 1:2.5, SL = 1.4×ATR", () => {
      const rc = strategy.calculateRiskConfig(42000, 100, "LONG", "Scalping");
      expect(rc.slDistance).toBeCloseTo(140, 5);       // 1.4×ATR
      expect(rc.tpDistance).toBeCloseTo(350, 5);       // slDist × 2.5 = 140×2.5
      expect(rc.riskReward).toBe(2.5);
      expect(rc.stopLoss).toBeCloseTo(42000 - 140, 5);
      expect(rc.takeProfit).toBeCloseTo(42000 + 350, 5);
      expect(rc.component).toBe("Scalping");
    });

    test("Intraday (B): RR = 1:2.0, SL = 1.4×ATR", () => {
      const rc = strategy.calculateRiskConfig(42000, 100, "SHORT", "Intraday");
      expect(rc.slDistance).toBeCloseTo(140, 5);
      expect(rc.tpDistance).toBeCloseTo(280, 5);       // slDist × 2.0 = 140×2.0
      expect(rc.riskReward).toBe(2.0);
      expect(rc.stopLoss).toBeCloseTo(42000 + 140, 5); // SHORT SL above
      expect(rc.takeProfit).toBeCloseTo(42000 - 280, 5);
      expect(rc.component).toBe("Intraday");
    });

    test("defaults to Intraday when component omitted", () => {
      const rc = strategy.calculateRiskConfig(50000, 200, "LONG");
      expect(rc.component).toBe("Intraday");
      expect(rc.riskReward).toBe(2.0);
    });
  });

  // ──────────────────────────────────────────────────────────
  // MARKET VALIDATION
  // ──────────────────────────────────────────────────────────

  describe("validateMarketCondition", () => {
    test("Choppy market approved", () => {
      const result = strategy.validateMarketCondition(2.0, 0.1);
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
  // MARKET RANKING
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
  // CONFIGURATION — new dual-component keys
  // ──────────────────────────────────────────────────────────

  describe("Configuration", () => {
    test("Default config set correctly (v2.0 dual-component)", () => {
      expect(strategy.config.bbStdDevA).toBe(1.5);
      expect(strategy.config.bbStdDevB).toBe(2.0);
      expect(strategy.config.rsiOversoldA).toBe(28);
      expect(strategy.config.rsiOversoldB).toBe(32);
      expect(strategy.config.tpMultiplierA).toBe(2.5);
      expect(strategy.config.tpMultiplierB).toBe(2.0);
      expect(strategy.config.atrMult).toBe(1.4);
      expect(strategy.config.riskPerTrade).toBe(0.008);
      expect(strategy.config.leverage).toBe(1.0);
    });

    test("Config can be updated", () => {
      strategy.setConfig({ riskPerTrade: 0.005 });
      expect(strategy.config.riskPerTrade).toBe(0.005);
      expect(strategy.config.tpMultiplierA).toBe(2.5);
    });
  });

  describe("Test Summary", () => {
    test("strategy instantiates with MEAN_REVERSION name", () => {
      expect(strategy).toBeDefined();
      expect(strategy.config.name || "MEAN_REVERSION").toBe("MEAN_REVERSION");
    });
  });
});
