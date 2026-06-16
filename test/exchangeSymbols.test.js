/**
 * exchangeSymbols.test.js
 *
 * Unit tests for Task A (GET /market/symbols backend) + Task C (Binance key
 * permission validation).
 *
 * Covers:
 *   A-AC1/AC3  getPerpetualSymbols returns normalized shape for binance/bitget/okx
 *   A-AC4      5-min cache — no repeated exchange API call within TTL
 *   A-AC5      stale fallback when exchange API is down (stale:true, no throw)
 *   A-AC7      no exchange connected → 400 (IDOR-safe: derives exchange from user)
 *   C-AC1      Binance key WITH withdrawal permission → rejected
 *   C-AC2      Binance key WITHOUT futures permission → rejected
 *   C-AC3      Valid Binance key (futures, no withdrawal) → accepted
 *
 * No DB / no network: @prisma/client and ccxt are mocked via Module._load
 * override BEFORE the service is required (same harness style as the repo).
 */

"use strict";

const assert = require("assert");
const Module = require("module");

// ── Shared mock control ──────────────────────────────────────────────────────
const control = {
  connectedExchange: "binance", // what the user has connected
  loadMarketsImpl: null,        // () => markets | throws
  loadMarketsCalls: 0,
  apiRestrictions: { enableFutures: true, enableWithdrawals: false },
};

function fakeMarkets() {
  return {
    "BTC/USDT:USDT": { swap: true, linear: true, base: "BTC", quote: "USDT", active: true, limits: { amount: { min: 0.001 } } },
    "ETH/USDT:USDT": { swap: true, linear: true, base: "ETH", quote: "USDT", active: true, limits: { amount: { min: 0.01 } } },
    // Should be filtered out:
    "BTC/USD:BTC":   { swap: true, linear: false, base: "BTC", quote: "USD", active: true },   // inverse
    "SOL/USDT":      { swap: false, spot: true, base: "SOL", quote: "USDT", active: true },     // spot
    "ADA/USDT:USDT": { swap: true, linear: true, base: "ADA", quote: "USDT", active: false },   // delisted
  };
}

// ── ccxt mock ─────────────────────────────────────────────────────────────────
class FakeExchange {
  constructor() {}
  async loadMarkets() {
    control.loadMarketsCalls++;
    if (control.loadMarketsImpl) return control.loadMarketsImpl();
    return fakeMarkets();
  }
  async sapiGetAccountApiRestrictions() {
    return control.apiRestrictions;
  }
  // Legacy alias kept for older mocks
  async sapiGetAccountApirestrictions() {
    return this.sapiGetAccountApiRestrictions();
  }
}
const ccxtMock = { binance: FakeExchange, bitget: FakeExchange, okx: FakeExchange };

// ── prisma mock ───────────────────────────────────────────────────────────────
class FakePrismaClient {
  constructor() {
    this.userExchange = {
      findFirst: async () =>
        control.connectedExchange ? { exchangeType: control.connectedExchange } : null,
    };
    this.user = {
      findUnique: async () => null,
    };
  }
}

// ── Install mocks BEFORE requiring the service ────────────────────────────────
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "ccxt") return ccxtMock;
  if (request === "@prisma/client") return { PrismaClient: FakePrismaClient };
  return origLoad.apply(this, arguments);
};

const ExchangeService = require("../src/services/ExchangeService");
const BinanceClient = require("../src/infrastructure/exchange/BinanceClient");

// ── Tiny harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
async function test(name, fn) {
  control.loadMarketsImpl = null;
  control.loadMarketsCalls = 0;
  ExchangeService._clearCaches();
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed++;
  }
}

(async () => {
  console.log("ExchangeService — getPerpetualSymbols + validation\n");

  await test("A-AC1/AC3: normalized shape, filters non-linear/spot/inactive", async () => {
    control.connectedExchange = "binance";
    const { exchange, symbols } = await ExchangeService.getPerpetualSymbols("u1");
    assert.strictEqual(exchange, "binance");
    assert.deepStrictEqual(symbols.map((s) => s.symbol), ["BTCUSDT", "ETHUSDT"]);
    assert.deepStrictEqual(symbols[0], { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", minQty: 0.001 });
  });

  await test("A-AC1: works for bitget and okx too", async () => {
    for (const ex of ["bitget", "okx"]) {
      control.connectedExchange = ex;
      ExchangeService._clearCaches();
      const { exchange, symbols } = await ExchangeService.getPerpetualSymbols("u1");
      assert.strictEqual(exchange, ex);
      assert.ok(symbols.length === 2, `${ex} should list 2 symbols`);
    }
  });

  await test("A-AC4: cache hit within TTL — no second loadMarkets call", async () => {
    control.connectedExchange = "binance";
    const first = await ExchangeService.getPerpetualSymbols("u1");
    assert.strictEqual(first.cached, false);
    const second = await ExchangeService.getPerpetualSymbols("u1");
    assert.strictEqual(second.cached, true);
    assert.strictEqual(control.loadMarketsCalls, 1, "loadMarkets must be called only once");
  });

  await test("A-AC5: stale fallback when exchange API down after TTL expiry", async () => {
    control.connectedExchange = "binance";
    await ExchangeService.getPerpetualSymbols("u1");       // populate cache
    ExchangeService._expireCaches();                        // simulate TTL expiry
    control.loadMarketsImpl = () => { throw new Error("ETIMEDOUT"); };
    const res = await ExchangeService.getPerpetualSymbols("u1");
    assert.strictEqual(res.stale, true, "should be flagged stale");
    assert.ok(res.symbols.length === 2, "should return last cached list, not empty");
  });

  await test("A-AC5: API down with NO cache → 503 (never 500/empty)", async () => {
    control.connectedExchange = "binance";
    control.loadMarketsImpl = () => { throw new Error("ECONNRESET"); };
    await assert.rejects(
      () => ExchangeService.getPerpetualSymbols("u1"),
      (e) => e.statusCode === 503 && e.code === "EXCHANGE_UNAVAILABLE"
    );
  });

  await test("A-AC7: no exchange connected → 400 NO_EXCHANGE_CONNECTED", async () => {
    control.connectedExchange = null;
    await assert.rejects(
      () => ExchangeService.getPerpetualSymbols("u1"),
      (e) => e.statusCode === 400 && e.code === "NO_EXCHANGE_CONNECTED"
    );
  });

  await test("C-AC1: Binance key WITH withdrawal permission → rejected", async () => {
    control.apiRestrictions = { enableFutures: true, enableWithdrawals: true };
    const client = new BinanceClient("k", "s");
    await assert.rejects(
      () => client.validatePermissions(),
      (e) => e.statusCode === 400 && e.code === "WITHDRAWAL_PERMISSION_DETECTED"
    );
  });

  await test("C-AC2: Binance key WITHOUT futures permission → rejected", async () => {
    control.apiRestrictions = { enableFutures: false, enableWithdrawals: false };
    const client = new BinanceClient("k", "s");
    await assert.rejects(
      () => client.validatePermissions(),
      (e) => e.statusCode === 400 && e.code === "FUTURES_PERMISSION_MISSING"
    );
  });

  await test("C-AC3: valid key (futures, no withdrawal) → accepted", async () => {
    control.apiRestrictions = { enableFutures: true, enableWithdrawals: false };
    const client = new BinanceClient("k", "s");
    const r = await client.validatePermissions();
    assert.deepStrictEqual(r, { ok: true, futures: true, withdrawal: false });
  });

  await test("C-AC1: string flags ('true'/'false') coerced correctly", async () => {
    control.apiRestrictions = { enableFutures: "true", enableWithdrawals: "true" };
    const client = new BinanceClient("k", "s");
    await assert.rejects(
      () => client.validatePermissions(),
      (e) => e.code === "WITHDRAWAL_PERMISSION_DETECTED"
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  Module._load = origLoad;
  if (failed > 0) process.exit(1);
})();
