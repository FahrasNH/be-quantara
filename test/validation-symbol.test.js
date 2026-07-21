"use strict";

const assert = require("assert");
const {
  validateSymbolFormat,
  validateSymbolParam,
} = require("../src/shared/middleware/validation");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed++;
  }
}

function runMiddleware(mw, symbol) {
  const req = { params: { symbol } };
  let statusCode;
  let body;
  let calledNext = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  const next = () => {
    calledNext = true;
  };
  mw(req, res, next);
  return { statusCode, body, calledNext };
}

console.log("validation — symbol param middleware\n");

test("validateSymbolFormat accepts legacy disallowed symbols", () => {
  const r = runMiddleware(validateSymbolFormat, "AUCTIONUSDT");
  assert.strictEqual(r.calledNext, true);
  assert.strictEqual(r.statusCode, undefined);
});

test("validateSymbolFormat rejects invalid format", () => {
  const r = runMiddleware(validateSymbolFormat, "not-a-pair");
  assert.strictEqual(r.calledNext, false);
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.message, "Invalid symbol format");
});

test("validateSymbolParam blocks disallowed symbols (create/start)", () => {
  const r = runMiddleware(validateSymbolParam, "AUCTIONUSDT");
  assert.strictEqual(r.calledNext, false);
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.message, "Symbol not allowed");
  assert.strictEqual(r.body.code, "SYMBOL_NOT_ALLOWED");
});

test("validateSymbolParam allows allowlisted symbols", () => {
  const r = runMiddleware(validateSymbolParam, "BTCUSDT");
  assert.strictEqual(r.calledNext, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
