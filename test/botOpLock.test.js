/**
 * botOpLock.test.js — SEC-002 GAP1: in-flight lock start/stop per (userId, symbol).
 * Standalone (tanpa jest): node test/botOpLock.test.js
 */

"use strict";

const { EventEmitter } = require("events");
const { createBotOpLock } = require("../src/middleware/botOpLock");

let passed = 0, failed = 0;
function t(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else      { failed++; console.error(`  ✗ ${name}`); }
}

function mockReqRes(userId, symbol) {
  const req = { userId, params: { symbol } };
  const res = new EventEmitter();
  res.statusCode = null;
  res.body = null;
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.finish = () => res.emit("finish");
  return { req, res };
}

console.log("\nbotOpLock (SEC-002 GAP1)\n");

{
  const lock = createBotOpLock();

  // Request pertama lolos
  const a = mockReqRes("u1", "BTCUSDT");
  let nextCalled = false;
  lock(a.req, a.res, () => { nextCalled = true; });
  t("request pertama → next()", nextCalled === true);

  // Request kedua untuk key sama saat in-flight → 409
  const b = mockReqRes("u1", "BTCUSDT");
  let bNext = false;
  lock(b.req, b.res, () => { bNext = true; });
  t("request kedua (key sama, in-flight) → 409", b.res.statusCode === 409 && bNext === false);
  t("code BOT_OPERATION_IN_FLIGHT", b.res.body?.code === "BOT_OPERATION_IN_FLIGHT");

  // User lain / symbol lain tidak terblokir
  const c = mockReqRes("u2", "BTCUSDT");
  let cNext = false;
  lock(c.req, c.res, () => { cNext = true; });
  t("user berbeda → tidak terblokir", cNext === true);

  const d = mockReqRes("u1", "ETHUSDT");
  let dNext = false;
  lock(d.req, d.res, () => { dNext = true; });
  t("symbol berbeda → tidak terblokir", dNext === true);

  // Setelah response pertama selesai → lock lepas
  a.res.finish();
  const e = mockReqRes("u1", "BTCUSDT");
  let eNext = false;
  lock(e.req, e.res, () => { eNext = true; });
  t("setelah finish → lock dilepas, request baru lolos", eNext === true);

  // Release via 'close' (koneksi putus sebelum finish) juga melepas lock
  e.res.emit("close");
  const f = mockReqRes("u1", "BTCUSDT");
  let fNext = false;
  lock(f.req, f.res, () => { fNext = true; });
  t("release via close → request baru lolos", fNext === true);
}

console.log(`\n  TESTS: ${passed} passed, ${failed} failed (${passed + failed} total)\n`);
process.exit(failed ? 1 : 0);
