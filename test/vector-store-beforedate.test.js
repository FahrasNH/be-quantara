/**
 * Unit tests — VectorStore beforeDate filter (no live DB).
 * Run: node test/vector-store-beforedate.test.js
 */

const assert = require("assert");
const VectorStore = require("../src/infrastructure/db/VectorStore");

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

function makeCapturingPool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("pg_extension")) return { rows: [{ extname: "vector" }] };
      if (sql.includes("COUNT")) return { rows: [{ cnt: 0 }] };
      return { rows: [] };
    },
  };
}

async function main() {
  console.log("\n=== VectorStore beforeDate Filter Tests ===\n");

  await test("findSimilar — includes beforeDate in WHERE clause", async () => {
    const pool = makeCapturingPool();
    const vs = new VectorStore(pool);
    const vec = new Array(60).fill(0.1);
    const before = "2024-06-01T00:00:00.000Z";

    await vs.findSimilar(vec, 5, { symbol: "BTCUSDT", beforeDate: before });

    const selectCall = pool.calls.find((c) => c.sql.includes("SELECT") && c.sql.includes("TradeEmbedding"));
    assert.ok(selectCall, "expected findSimilar SELECT query");
    assert.ok(
      selectCall.sql.includes("(metadata->>'timestamp')::timestamptz"),
      "expected timestamp cast in SQL"
    );
    assert.ok(selectCall.params.includes(before), "beforeDate should be bound as param");
  });

  await test("findSimilar — strategyKey + beforeDate both bound", async () => {
    const pool = makeCapturingPool();
    const vs = new VectorStore(pool);
    const vec = new Array(60).fill(0.2);

    await vs.findSimilar(vec, 10, {
      strategyKey: "MEAN_REVERSION",
      beforeDate: "2025-01-15T12:00:00.000Z",
    });

    const selectCall = pool.calls.find((c) => c.sql.includes("SELECT") && c.sql.includes("TradeEmbedding"));
    assert.ok(selectCall.sql.includes("metadata->>'strategyKey'"), "expected strategyKey filter");
    assert.ok(selectCall.params.includes("MEAN_REVERSION"), "strategyKey param bound");
  });

  await test("findSimilar — strategyKey array uses ANY()", async () => {
    const pool = makeCapturingPool();
    const vs = new VectorStore(pool);
    const vec = new Array(60).fill(0.3);

    await vs.findSimilar(vec, 10, {
      strategyKey: ["TREND_FOLLOWING", "MARKET_STRUCTURE", "AUCTION_MARKET_THEORY"],
      beforeDate: "2025-01-15T12:00:00.000Z",
    });

    const selectCall = pool.calls.find((c) => c.sql.includes("SELECT") && c.sql.includes("TradeEmbedding"));
    assert.ok(selectCall.sql.includes("= ANY("), "expected ANY() for strategyKey array");
    assert.deepStrictEqual(
      selectCall.params[1],
      ["TREND_FOLLOWING", "MARKET_STRUCTURE", "AUCTION_MARKET_THEORY"],
    );
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
