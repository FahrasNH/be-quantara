/**
 * RAG gate — per-trade strategyKey + minimum support (Sprint 23 fixes).
 * Run: node test/rag-gate-strategy-key.test.js
 */

const assert = require("assert");
const VectorStore = require("../src/infrastructure/db/VectorStore");
const { resolveRagStrategyFilterKeys } = require("../src/config/strategies");
const {
  _resolveRagStrategyFilterKeys,
  _ragScoreFromOutcomes,
  _applyRagGate,
  RAG_MIN_SUPPORT,
} = require("../src/modules/backtest/services/RealStrategyBacktestService");

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function makeMockDeps(similarRows = []) {
  const pool = {
    query: async (sql) => {
      if (sql.includes("pg_extension")) return { rows: [{ extname: "vector" }] };
      if (sql.includes("COUNT")) return { rows: [{ cnt: similarRows.length || 100 }] };
      return { rows: [] };
    },
  };
  const vs = new VectorStore(pool);
  vs.findSimilar = async () => similarRows;
  return {
    fe: {
      buildFeatureVector: () => new Float32Array(60).fill(0.1),
    },
    wp: { model: null, load: async () => {}, predict: () => ({ pWin: 0.5 }) },
    vs,
  };
}

async function main() {
  console.log("\n=== RAG Gate Strategy Key + Min Support Tests ===\n");

  await test("per-trade component key wins over umbrella ctx", () => {
    const keys = _resolveRagStrategyFilterKeys(
      { strategyKey: "MARKET_STRUCTURE" },
      { strategyKey: "TREND_SURGE" },
    );
    assert.strictEqual(keys, "MARKET_STRUCTURE");
  });

  await test("umbrella TREND_SURGE fans out to TS components", () => {
    const keys = _resolveRagStrategyFilterKeys({}, { strategyKey: "TREND_SURGE" });
    assert.ok(Array.isArray(keys));
    assert.deepStrictEqual(keys, ["TREND_FOLLOWING", "MARKET_STRUCTURE", "AUCTION_MARKET_THEORY"]);
  });

  await test("umbrella ADAPTIVE_FUSION fans out to AF components", () => {
    const keys = _resolveRagStrategyFilterKeys({}, { strategyKey: "ADAPTIVE_FUSION" });
    assert.ok(Array.isArray(keys));
    assert.deepStrictEqual(keys, ["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"]);
  });

  await test("umbrella MEAN_DRIFT fans out to MD components", () => {
    const keys = _resolveRagStrategyFilterKeys({}, { strategyKey: "MEAN_DRIFT" });
    assert.ok(Array.isArray(keys));
    assert.deepStrictEqual(keys, ["MEAN_REVERSION", "SUPPLY_AND_DEMAND", "STATISTICAL_ARBITRAGE"]);
  });

  await test("umbrella BREAKOUT_STORM fans out to BS race participants", () => {
    const keys = _resolveRagStrategyFilterKeys({}, { strategyKey: "BREAKOUT_STORM" });
    assert.ok(Array.isArray(keys));
    assert.ok(keys.includes("ICT_STYLE_TRADING"));
    assert.ok(keys.includes("LIQUIDATION_SQUEEZE"));
  });

  await test("winningComponent preferred over umbrella ctx", () => {
    const keys = _resolveRagStrategyFilterKeys(
      { winningComponent: "AUCTION_MARKET_THEORY" },
      { strategyKey: "TREND_SURGE" },
    );
    assert.strictEqual(keys, "AUCTION_MARKET_THEORY");
  });

  await test("standalone component key passes through", () => {
    const keys = _resolveRagStrategyFilterKeys({}, { strategyKey: "MEAN_REVERSION" });
    assert.strictEqual(keys, "MEAN_REVERSION");
  });

  await test("_ragScoreFromOutcomes — below min support returns null", () => {
    assert.strictEqual(_ragScoreFromOutcomes(["loss"]), null);
    assert.strictEqual(_ragScoreFromOutcomes(Array(RAG_MIN_SUPPORT - 1).fill("win")), null);
  });

  await test("_ragScoreFromOutcomes — at min support computes win rate", () => {
    const outcomes = Array(RAG_MIN_SUPPORT).fill("win");
    outcomes[0] = "loss";
    const score = _ragScoreFromOutcomes(outcomes);
    assert.ok(Math.abs(score - (RAG_MIN_SUPPORT - 1) / RAG_MIN_SUPPORT) < 1e-9);
  });

  await test("resolveRagStrategyFilterKeys SSOT — TREND_SURGE fan-out", () => {
    assert.deepStrictEqual(
      resolveRagStrategyFilterKeys("TREND_SURGE"),
      ["TREND_FOLLOWING", "MARKET_STRUCTURE", "AUCTION_MARKET_THEORY"],
    );
  });

  await test("_applyRagGate — umbrella ctx passes array to VectorStore", async () => {
    let capturedFilter = null;
    const deps = makeMockDeps([]);
    deps.vs.findSimilar = async (_vec, _k, filters) => {
      capturedFilter = filters;
      return [];
    };

    await _applyRagGate(
      [{ openTime: "2024-01-01T00:00:00.000Z", side: "LONG" }],
      { strategyKey: "TREND_SURGE", symbol: "BTCUSDT" },
      { deps },
    );

    assert.ok(Array.isArray(capturedFilter.strategyKey));
    assert.deepStrictEqual(capturedFilter.strategyKey, [
      "TREND_FOLLOWING", "MARKET_STRUCTURE", "AUCTION_MARKET_THEORY",
    ]);
  });

  await test("_applyRagGate — uses per-trade key in VectorStore filter", async () => {
    let capturedFilter = null;
    const deps = makeMockDeps([
      { tradeId: "t1", similarity: 0.9, metadata: { outcome: "win" } },
    ]);
    deps.vs.findSimilar = async (_vec, _k, filters) => {
      capturedFilter = filters;
      return [];
    };

    await _applyRagGate(
      [{ openTime: "2024-01-01T00:00:00.000Z", side: "LONG", strategyKey: "TREND_FOLLOWING" }],
      { strategyKey: "TREND_SURGE", symbol: "BTCUSDT" },
      { deps },
    );

    assert.strictEqual(capturedFilter.strategyKey, "TREND_FOLLOWING");
  });

  await test("_applyRagGate — insufficient neighbors fail-open (kept)", async () => {
    const similar = [{ tradeId: "t1", similarity: 0.9, metadata: { outcome: "loss" } }];
    const deps = makeMockDeps(similar);

    const result = await _applyRagGate(
      [{ openTime: "2024-01-01T00:00:00.000Z", side: "LONG", strategyKey: "TREND_FOLLOWING" }],
      { strategyKey: "TREND_FOLLOWING", symbol: "BTCUSDT" },
      { deps },
    );

    assert.strictEqual(result.trades.length, 1);
    assert.strictEqual(result.rejected, 0);
    assert.ok(result.logs[0].reason.includes("insufficient-rag-support"));
  });

  // A degenerate WinPredictor (precision/recall ~0) emits a uniformly low pWin.
  // Blended 50/50 it can sink an otherwise healthy trade below the 0.4 threshold;
  // lgbWeight=0 must decide on retrieval evidence alone. Guards the Wyckoff
  // "3 of 54 survived" diagnosis — see ragStats.diag.lgbWeight.
  const flatLowLgb = (similar) => {
    const deps = makeMockDeps(similar);
    deps.wp = { model: {}, load: async () => {}, predict: () => ({ pWin: 0.1 }) };
    return deps;
  };
  // 20 neighbours, 70% winners → ragScore 0.7.
  const healthyNeighbours = Array.from({ length: 20 }, (_, i) => ({
    tradeId: `n${i}`,
    similarity: 0.9,
    metadata: { outcome: i < 14 ? "win" : "loss" },
  }));
  const oneTrade = [{ openTime: "2024-01-01T00:00:00.000Z", side: "LONG", strategyKey: "TREND_FOLLOWING" }];
  const ctx = { strategyKey: "TREND_FOLLOWING", symbol: "BTCUSDT" };

  await test("_applyRagGate — low lgb drags a healthy trade under threshold at default blend", async () => {
    const result = await _applyRagGate(oneTrade, ctx, { deps: flatLowLgb(healthyNeighbours), lgbWeight: 0.5 });
    // 0.5*0.1 + 0.5*0.7 = 0.40 → conservative discount leaves it at 0.40, not below.
    assert.strictEqual(result.stats.diag.lgbWeight, 0.5);
    assert.ok(Math.abs(result.stats.avgScore - 0.4) < 1e-9, `expected 0.40, got ${result.stats.avgScore}`);
  });

  await test("_applyRagGate — lgbWeight=0 scores on retrieval evidence alone", async () => {
    const result = await _applyRagGate(oneTrade, ctx, { deps: flatLowLgb(healthyNeighbours), lgbWeight: 0 });
    // ragScore 0.7 → discounted to 0.5 + 0.2*0.9 = 0.68; model ignored entirely.
    assert.strictEqual(result.stats.diag.lgbWeight, 0);
    assert.ok(Math.abs(result.stats.avgScore - 0.68) < 1e-9, `expected 0.68, got ${result.stats.avgScore}`);
    assert.strictEqual(result.trades.length, 1);
  });

  await test("_applyRagGate — lgbWeight=0 still rejects when neighbours themselves lost", async () => {
    // 20 neighbours, 30% winners → ragScore 0.3 < 0.4. Weighting the model out
    // must NOT rescue a trade whose retrieval evidence is genuinely bad.
    const poorNeighbours = Array.from({ length: 20 }, (_, i) => ({
      tradeId: `n${i}`,
      similarity: 0.9,
      metadata: { outcome: i < 6 ? "win" : "loss" },
    }));
    const result = await _applyRagGate(oneTrade, ctx, { deps: flatLowLgb(poorNeighbours), lgbWeight: 0 });
    assert.strictEqual(result.trades.length, 0);
    assert.strictEqual(result.rejected, 1);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
