// ─────────────────────────────────────────────────────────────────────────────
// setTPSL-order-type.test.js — regression guard for the LAB/USDT naked-position
// incident. Binance/OKX setTPSL MUST place SL/TP via the unified stopLossPrice /
// takeProfitPrice PARAM on a `market` order (CCXT → STOP_MARKET / TAKE_PROFIT_MARKET).
// The old code passed type:"stopMarket"/"takeProfitMarket", which CCXT rejects with
// "binance stopMarket is not a valid order type for the X market" → SL never placed
// → position ran naked → emergency-close loop. These tests fail if that regresses.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require("node:test");
const assert = require("node:assert");

const BinanceClient = require("../src/infrastructure/exchange/BinanceClient");
const OkxClient = require("../src/infrastructure/exchange/OkxClient");

// Install a createOrder spy + stub priceToPrecision so the client runs fully offline.
function instrument(client) {
  const calls = [];
  client.exchange.priceToPrecision = (_sym, px) => px;
  client.exchange.createOrder = async (symbol, type, side, amount, price, params = {}) => {
    calls.push({ symbol, type, side, amount, price, params });
    return { id: `mock_${calls.length}` };
  };
  return calls;
}

const BANNED_TYPES = ["stopMarket", "takeProfitMarket", "STOPMARKET", "TAKEPROFITMARKET"];

test("Binance setTPSL (loss) uses market + stopLossPrice, never a banned type string", async () => {
  const c = new BinanceClient("k", "s");
  const calls = instrument(c);

  const r = await c.setTPSL("LABUSDT", "loss_plan", 15.0, "long", 3.3);

  assert.strictEqual(r.success, true, "SL should be placed");
  const first = calls[0];
  assert.strictEqual(first.type, "market", "order type must be 'market' (CCXT maps via param)");
  assert.ok(first.params.stopLossPrice != null, "must pass unified stopLossPrice param");
  assert.strictEqual(first.params.takeProfitPrice, undefined, "loss order must not carry takeProfitPrice");
  // The actual bug: a banned type string was passed as the order type.
  for (const call of calls) {
    assert.ok(!BANNED_TYPES.includes(call.type), `order type must never be '${call.type}'`);
  }
});

test("Binance setTPSL (profit) uses market + takeProfitPrice", async () => {
  const c = new BinanceClient("k", "s");
  const calls = instrument(c);

  const r = await c.setTPSL("LABUSDT", "profit_plan", 16.0, "long", 3.3);

  assert.strictEqual(r.success, true);
  assert.strictEqual(calls[0].type, "market");
  assert.ok(calls[0].params.takeProfitPrice != null, "must pass unified takeProfitPrice param");
});

test("Binance setTPSL approach-1 closes full position (no quantity → no lot-size mismatch)", async () => {
  const c = new BinanceClient("k", "s");
  const calls = instrument(c);

  await c.setTPSL("LABUSDT", "loss_plan", 15.0, "short", 3.3);

  assert.strictEqual(calls[0].amount, undefined, "closePosition path sends no quantity");
  assert.strictEqual(calls[0].params.closePosition, "true");
  assert.strictEqual(calls[0].params.workingType, "MARK_PRICE", "trigger on mark price (anti-manipulation)");
  // SHORT closes with a BUY.
  assert.strictEqual(calls[0].side, "buy");
});

test("Binance setTPSL falls back to size+reduceOnly if closePosition is rejected", async () => {
  const c = new BinanceClient("k", "s");
  const calls = [];
  c.exchange.priceToPrecision = (_s, px) => px;
  let n = 0;
  c.exchange.createOrder = async (symbol, type, side, amount, price, params = {}) => {
    n += 1;
    calls.push({ type, amount, params });
    if (n === 1) throw new Error("closePosition rejected (partial fill)");
    return { id: "mock_fallback" };
  };

  const r = await c.setTPSL("LABUSDT", "loss_plan", 15.0, "long", 3.3);

  assert.strictEqual(r.success, true, "fallback should succeed");
  assert.strictEqual(r.method, "binanceReduceOnly");
  assert.strictEqual(calls[1].type, "market");
  assert.strictEqual(calls[1].amount, 3.3, "fallback sends the position size");
  assert.strictEqual(calls[1].params.reduceOnly, true);
  assert.ok(calls[1].params.stopLossPrice != null);
});

test("OKX setTPSL uses market + stopLossPrice + mark trigger, never a banned type string", async () => {
  const c = new OkxClient("k", "s", "pass");
  const calls = instrument(c);

  const r = await c.setTPSL("LABUSDT", "loss_plan", 15.0, "long", 3.3);

  assert.strictEqual(r.success, true);
  const first = calls[0];
  assert.strictEqual(first.type, "market");
  assert.ok(first.params.stopLossPrice != null, "must pass unified stopLossPrice param");
  assert.strictEqual(first.params.slTriggerPxType, "mark", "OKX mark-price trigger");
  assert.strictEqual(first.params.tdMode, "cross");
  assert.strictEqual(first.params.reduceOnly, true);
  for (const call of calls) {
    assert.ok(!BANNED_TYPES.includes(call.type), `OKX order type must never be '${call.type}'`);
  }
});

test("OKX setTPSL (profit) uses takeProfitPrice + tpTriggerPxType mark", async () => {
  const c = new OkxClient("k", "s", "pass");
  const calls = instrument(c);

  await c.setTPSL("LABUSDT", "profit_plan", 16.0, "short", 3.3);

  assert.ok(calls[0].params.takeProfitPrice != null);
  assert.strictEqual(calls[0].params.tpTriggerPxType, "mark");
  assert.strictEqual(calls[0].side, "buy", "SHORT take-profit closes with a BUY");
});

test("setTPSL surfaces a failure (not a false success) when all approaches throw", async () => {
  const c = new BinanceClient("k", "s");
  c.exchange.priceToPrecision = (_s, px) => px;
  c.exchange.createOrder = async () => { throw new Error("exchange down"); };

  const r = await c.setTPSL("LABUSDT", "loss_plan", 15.0, "long", 3.3);

  assert.strictEqual(r.success, false, "must report failure so BotEngine emergency-closes");
  assert.match(r.message, /exchange down/);
});
