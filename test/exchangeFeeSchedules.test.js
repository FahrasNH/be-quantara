/**
 * Exchange fee schedule SSOT — resolution + wiring smoke tests.
 */
const assert = require("assert");
const {
  FEE_SCHEDULES,
  SUPPORTED_EXCHANGES,
  normalizeExchangeType,
  resolveFeeSchedule,
  roundtripTakerFee,
} = require("../src/constants/exchangeFeeSchedules");
const { resolveFeeModel, estimateFundingCost } = require("../src/server/services/RealStrategyBacktestService");
const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

console.log("\n═══ Exchange Fee Schedules ═══");

test("supported venues are bitget / okx / binance", () => {
  assert.deepEqual(SUPPORTED_EXCHANGES, ["bitget", "okx", "binance"]);
});

test("each schedule has taker > maker and funding modeled", () => {
  for (const id of SUPPORTED_EXCHANGES) {
    const s = FEE_SCHEDULES[id];
    assert.ok(s.takerFeeRate > 0, `${id} taker`);
    assert.ok(s.makerFeeRate > 0, `${id} maker`);
    assert.ok(s.takerFeeRate >= s.makerFeeRate, `${id} taker >= maker`);
    assert.ok(s.fundingRate8h > 0, `${id} funding`);
  }
});

test("normalizeExchangeType rejects garbage", () => {
  assert.equal(normalizeExchangeType("BITGET"), "bitget");
  assert.equal(normalizeExchangeType("bybit"), null);
  assert.equal(normalizeExchangeType(""), null);
});

test("resolveFeeSchedule falls back to bitget", () => {
  assert.equal(resolveFeeSchedule(undefined).exchange, "bitget");
  assert.equal(resolveFeeSchedule("nope").exchange, "bitget");
});

test("venue schedules differ on taker (not a unified hardcode)", () => {
  const bg = resolveFeeSchedule("bitget").takerFeeRate;
  const ok = resolveFeeSchedule("okx").takerFeeRate;
  const bn = resolveFeeSchedule("binance").takerFeeRate;
  assert.notEqual(bg, ok);
  assert.notEqual(ok, bn);
  assert.notEqual(bg, bn);
});

test("resolveFeeModel maps exchangeType → feeRate", () => {
  const bn = resolveFeeModel({ exchangeType: "binance", enableFees: true });
  assert.equal(bn.feeRate, 0.0004);
  assert.equal(bn.makerFeeRate, 0.0002);
  const off = resolveFeeModel({ exchangeType: "binance", enableFees: false });
  assert.equal(off.feeRate, 0);
});

test("identical notional yields different fees across schedules", () => {
  const notionalEntry = 100; // price
  const size = 1;
  const exitPrice = 100;
  const feeFor = (ex) => {
    const s = resolveFeeSchedule(ex);
    return s.takerFeeRate * notionalEntry * size + s.takerFeeRate * exitPrice * size;
  };
  const bg = feeFor("bitget");
  const bn = feeFor("binance");
  assert.ok(Math.abs(bg - bn) > 1e-9, `bitget ${bg} vs binance ${bn}`);
  assert.ok(bg > bn, "Bitget taker cost should exceed Binance on same notional");
});

test("funding accrual uses injected rate", () => {
  const open = Date.parse("2024-01-01T00:00:00Z");
  const close = open + 8 * 60 * 60 * 1000; // exactly 1 period
  const cheap = estimateFundingCost(100, 1, open, close, true, 0.00005);
  const dear = estimateFundingCost(100, 1, open, close, true, 0.0002);
  assert.ok(Math.abs(cheap - 0.005) < 1e-12);
  assert.ok(Math.abs(dear - 0.02) < 1e-12);
  assert.ok(dear > cheap);
});

test("runBacktestJob wires exchangeType + feeSchedule into compute path", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../src/modules/backtest/services/runBacktestJob.js"),
    "utf8"
  );
  assert.ok(src.includes("exchangeType"), "exchangeType missing from job");
  assert.ok(src.includes("feeSchedule"), "feeSchedule missing from job");
  assert.ok(src.includes("normalizeExchangeType"), "normalizeExchangeType missing");
  assert.ok(src.includes("feeOptsFor"), "feeOptsFor helper missing");
});

test("HistoricalKlinesService accepts exchangeType override", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../src/modules/backtest/services/HistoricalKlinesService.js"),
    "utf8"
  );
  assert.ok(src.includes("exchangeTypeOverride") || src.includes("exchangeType: exchangeTypeOverride"));
  assert.ok(src.includes("getPublicClient"), "getPublicClient must remain available");
});

test("roundtrip helper matches 2× taker", () => {
  assert.equal(roundtripTakerFee("bitget"), 0.0012);
  assert.equal(roundtripTakerFee("binance"), 0.0008);
});

console.log("\n══════════════════════════════════════");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("All exchange fee schedule tests passed.\n");
