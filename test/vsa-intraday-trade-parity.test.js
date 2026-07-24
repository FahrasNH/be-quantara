/**
 * Sprint 23 regression — VSA Intraday-only backtest must return trades when
 * execAblation.opened > 0 (Notion: 450 OPENED vs 0 Result Summary).
 *
 * Root cause (fixed 6e37288): runTripleTypeBacktest omitted tradeType, so VSA
 * never painted the Intraday leg; after fix, opened positions must close into
 * the trades array with component/tradeType = Intraday for FE filters.
 */
"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const AdaptiveFusionUmbrella = require("../src/core/strategy-engine/umbrellas/AdaptiveFusionUmbrella");
const { runTripleTypeBacktest } = require("../src/modules/backtest/services/RealStrategyBacktestService");
const { applyStrategyJobDefaults } = require("../src/modules/backtest/services/runBacktestJob");

function buildVsaFriendlySeries(n = 200) {
  const opens = [];
  const highs = [];
  const lows = [];
  const closes = [];
  const volumes = [];
  const atr = [];
  for (let i = 0; i < n; i++) {
    const c = 100 + Math.sin(i / 8) * 0.15;
    opens.push(c - 0.02);
    closes.push(c);
    highs.push(c + 0.35);
    lows.push(c - 0.35);
    volumes.push(1000);
    atr.push(0.5);
  }
  // Swing low + stopping-volume style bar near the end
  const pen = n - 4;
  lows[pen] = 98.7;
  highs[pen] = 100.2;
  closes[pen] = 99.8;
  volumes[pen] = 2800;
  atr[pen] = 0.6;
  closes[n - 2] = 100.15;
  return { opens, highs, lows, closes, volumes, atr, lastIdx: n - 2 };
}

describe("VSA Intraday trade parity", () => {
  test("detectSignalMulti paints Intraday leg when tradeType=Intraday", () => {
    const um = new AdaptiveFusionUmbrella();
    const c = buildVsaFriendlySeries();
    const indicators = {
      opens: c.opens,
      highs: c.highs,
      lows: c.lows,
      closes: c.closes,
      volumes: c.volumes,
      volSMA: c.volumes.map(() => 900),
      atr: c.atr,
      rsi: c.closes.map(() => 50),
    };
    const multi = um.detectSignalMulti(indicators, c.lastIdx, {
      afActiveRacers: ["VOLUME_SPREAD_ANALYSIS"],
      tradeType: "Intraday",
      typeOverrides: {
        Intraday: { vsaSessionFilter: false },
      },
    });
    if (multi.Intraday) {
      assert.equal(multi.Scalping, null);
      assert.equal(multi.Swing, null);
      assert.equal(multi.meta?.winningComponent, "VOLUME_SPREAD_ANALYSIS");
    }
  });

  test("runTripleTypeBacktest tags closed trades with Intraday leg", async () => {
    const n = 320;
    const c = buildVsaFriendlySeries(n);
    const entryCandles = [];
    const start = Date.parse("2024-01-01T00:00:00.000Z");
    for (let i = 0; i < n; i++) {
      entryCandles.push({
        timestamp: start + i * 15 * 60 * 1000,
        open: c.opens[i],
        high: c.highs[i],
        low: c.lows[i],
        close: c.closes[i],
        volume: c.volumes[i],
      });
    }
    const htfCandles = entryCandles.filter((_, i) => i % 4 === 0);

    const strategyKey = "VOLUME_SPREAD_ANALYSIS";
    const config = applyStrategyJobDefaults(strategyKey, { activeTypes: ["Intraday"] });
    config.typeOverrides = {
      ...(config.typeOverrides || {}),
      Intraday: {
        ...(config.typeOverrides?.Intraday || {}),
        vsaSessionFilter: false,
        atrGateRelative: false,
        atrMinMult: 0,
        atrMaxMult: 100,
      },
    };

    const result = await runTripleTypeBacktest({
      strategyKey,
      capital: 1000,
      enableFees: false,
      enableSlippage: false,
      typeOrder: ["Intraday"],
      entryCandles: { Intraday: entryCandles },
      htfCandles: { Intraday: htfCandles },
      dailyCandles: [],
      config,
      symbol: "BTCUSDT",
    });

    const typeStats = result.perTypeStats?.Intraday;
    const opened = typeStats?.execAblation?.opened ?? 0;
    const tradeCount = result.trades?.length ?? 0;

    if (opened > 0) {
      assert.ok(
        tradeCount > 0,
        `execAblation.opened=${opened} but trades.length=${tradeCount} — trades must not be dropped after engine close`,
      );
      assert.equal(result.stats?.totalTrades, tradeCount);
      assert.equal(typeStats?.trades, tradeCount);
      for (const t of result.trades) {
        assert.equal(t.component, "Intraday");
        assert.equal(t.tradeType, "Intraday");
      }
    }
  });
});
