/**
 * backtest-delete.test.js — authorization for deleting backtest runs.
 * Run: node test/backtest-delete.test.js
 */
"use strict";

const assert = require("assert");

const prismaModulePath = require.resolve("../src/infrastructure/db/prismaClient");
let mockUserRole = "USER";
require.cache[prismaModulePath] = {
  id: prismaModulePath,
  exports: {
    user: {
      findUnique: async () => ({ role: mockUserRole }),
    },
  },
};

const db = require("../src/infrastructure/db/database");
const BacktestHistoryService = require("../src/server/services/BacktestHistoryService");

const records = new Map();
let deletedIds = [];

const origGetById = db.getBacktestHistoryById;
const origGetByIds = db.getBacktestHistoryByIds;
const origDeleteById = db.deleteBacktestHistoryById;
const origDeleteByIds = db.deleteBacktestHistoryByIds;

db.getBacktestHistoryById = async (id) => records.get(id) || null;
db.getBacktestHistoryByIds = async (ids) =>
  ids.map(id => records.get(id)).filter(Boolean);
db.deleteBacktestHistoryById = async (id) => {
  if (!records.has(id)) return false;
  records.delete(id);
  deletedIds.push(id);
  return true;
};
db.deleteBacktestHistoryByIds = async (ids) => {
  let count = 0;
  for (const id of ids) {
    if (records.has(id)) {
      records.delete(id);
      deletedIds.push(id);
      count++;
    }
  }
  return count;
};

function seed(id, userId, extra = {}) {
  records.set(id, {
    id,
    user_id: userId,
    symbol: "BTCUSDT",
    metrics: { roi_pct: 1 },
    ...extra,
  });
}

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

(async () => {
  console.log("\nBACKTEST DELETE\n");

  await t("user can delete own backtest run", async () => {
    records.clear();
    deletedIds = [];
    mockUserRole = "USER";
    seed(1, "user-a");
    const result = await BacktestHistoryService.deleteRun(1, "user-a");
    assert.strictEqual(result.deleted, true);
    assert.deepStrictEqual(deletedIds, [1]);
  });

  await t("regular user forbidden deleting another user's run", async () => {
    records.clear();
    deletedIds = [];
    mockUserRole = "USER";
    seed(2, "user-b");
    try {
      await BacktestHistoryService.deleteRun(2, "user-a");
      throw new Error("expected 403");
    } catch (err) {
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(deletedIds.length, 0);
    }
  });

  await t("admin can delete another user's run", async () => {
    records.clear();
    deletedIds = [];
    mockUserRole = "ADMIN";
    seed(3, "user-b");
    const result = await BacktestHistoryService.deleteRun(3, "admin-1");
    assert.strictEqual(result.deleted, true);
    assert.deepStrictEqual(deletedIds, [3]);
  });

  await t("bulk delete rejects mixed ownership for regular user", async () => {
    records.clear();
    deletedIds = [];
    mockUserRole = "USER";
    seed(4, "user-a");
    seed(5, "user-b");
    try {
      await BacktestHistoryService.deleteRuns([4, 5], "user-a");
      throw new Error("expected 403");
    } catch (err) {
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(deletedIds.length, 0);
      assert(records.has(4), "own record should remain when bulk fails");
      assert(records.has(5), "other record should remain when bulk fails");
    }
  });

  await t("admin bulk delete removes multiple runs", async () => {
    records.clear();
    deletedIds = [];
    mockUserRole = "SUPER_ADMIN";
    seed(6, "user-a");
    seed(7, "user-b");
    const result = await BacktestHistoryService.deleteRuns([6, 7], "admin-1");
    assert.strictEqual(result.deleted, 2);
    assert.strictEqual(records.size, 0);
  });

  await t("regular user forbidden deleting shared canonical archive", async () => {
    records.clear();
    deletedIds = [];
    mockUserRole = "USER";
    seed(8, "user-a", { canonical_key: "btc-adaptive-1d-shared" });
    try {
      await BacktestHistoryService.deleteRun(8, "user-a");
      throw new Error("expected 403");
    } catch (err) {
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(deletedIds.length, 0);
      assert(records.has(8));
    }
  });

  await t("admin can delete shared canonical archive", async () => {
    records.clear();
    deletedIds = [];
    mockUserRole = "ADMIN";
    seed(9, "user-b", { canonical_key: "btc-adaptive-1d-shared" });
    const result = await BacktestHistoryService.deleteRun(9, "admin-1");
    assert.strictEqual(result.deleted, true);
    assert.deepStrictEqual(deletedIds, [9]);
    assert.strictEqual(records.size, 0);
  });

  await t("deleteRun returns 404 when row missing after auth check", async () => {
    records.clear();
    deletedIds = [];
    mockUserRole = "ADMIN";
    db.deleteBacktestHistoryById = async () => false;
    seed(10, "user-a");
    try {
      await BacktestHistoryService.deleteRun(10, "admin-1");
      throw new Error("expected 404");
    } catch (err) {
      assert.strictEqual(err.statusCode, 404);
      assert.strictEqual(deletedIds.length, 0);
    } finally {
      db.deleteBacktestHistoryById = async (id) => {
        if (!records.has(id)) return false;
        records.delete(id);
        deletedIds.push(id);
        return true;
      };
    }
  });

  // restore db stubs for any later tests in same process
  db.getBacktestHistoryById = origGetById;
  db.getBacktestHistoryByIds = origGetByIds;
  db.deleteBacktestHistoryById = origDeleteById;
  db.deleteBacktestHistoryByIds = origDeleteByIds;

  console.log(`\n${failed === 0 ? "✅" : "❌"} BACKTEST DELETE: ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
