/**
 * RAG gate — per-trade strategyKey + minimum support (Sprint 23 fixes).
 * Run: node test/rag-gate-strategy-key.test.js
 */

const assert = require("assert");
const VectorStore = require("../src/infrastructure/db/VectorStore");
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

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
