/**
 * exchangeSwitch.test.js
 *
 * Unit test untuk Sprint 2 — Exchange Switch (Skenario B Flavor 2 / Soft Block).
 * Menutup acceptance criteria:
 *   AC-01 / S2-QA-01  Guard 409 open position (+ list posisi + code)
 *   AC-02 / S2-QA-01  Guard 409 bot running   (+ pesan jelas + code)
 *   AC-04 / S2-QA-02  Validasi key baru SEBELUM revoke (key lama tetap aktif)
 *   AC-03 / S2-QA-03  Happy path: stop bot → soft-delete lama → audit log → 200
 *   AC-05             Rate limit 3x / 24 jam → 429
 *   AC-06             getExchangeStatus blockerReason BOTH/OPEN/BOTS
 *   AC-08             AuditLog EXCHANGE_SWITCH tercatat
 *
 * Repo Quantara TIDAK memakai mocha — file ini menyertakan harness minimal sendiri
 * dan dijalankan sebagai script Node biasa (`node test/exchangeSwitch.test.js`),
 * konsisten dengan test lain di repo yang exit(1) saat ada kegagalan.
 *
 * Dependensi berat (PrismaClient, BitgetClient, userExchange) di-mock lewat
 * override Module._load SEBELUM service di-require — tidak menyentuh DB asli.
 */

'use strict';

const assert = require('assert');
const Module = require('module');

process.env.NODE_ENV = 'test';

// ─── Mini test harness ───────────────────────────────────────────────────────
const _suites = [];
let _current = null;
function describe(name, fn) {
  const suite = { name, tests: [], beforeEach: null };
  const parent = _current; _current = suite; fn(); _current = parent;
  _suites.push(suite);
}
function it(name, fn) { _current.tests.push({ name, fn }); }
function beforeEach(fn) { _current.beforeEach = fn; }

async function run() {
  let passed = 0, failed = 0;
  for (const suite of _suites) {
    console.log(`\n  ${suite.name}`);
    for (const t of suite.tests) {
      try {
        if (suite.beforeEach) await suite.beforeEach();
        await t.fn();
        console.log(`    ✓ ${t.name}`);
        passed++;
      } catch (err) {
        console.log(`    ✗ ${t.name}\n        ${err.message}`);
        failed++;
      }
    }
  }
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Exchange Switch: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log(`${'─'.repeat(60)}\n`);
  if (failed > 0) { console.error('❌ Ada test yang gagal.'); process.exit(1); }
  else { console.log('✅ Semua exchange-switch test lulus.'); }
}

// ─── Mock state (di-reset tiap test) ─────────────────────────────────────────
const scenario = {
  activeExchange: { exchangeType: 'bitget' }, // userExchange.findFirst result (null = none)
  openTrades: [],                              // trade.findMany result
  runningBots: 0,                              // bot.count result
  recentSwitches: 0,                           // auditLog.count result
  bitgetValid: true,                           // BitgetClient.getBalance success?
};
const spy = {
  botUpdateMany: 0,         // graceful stop dipanggil?
  softDeleteUpdateMany: 0,  // userExchange soft-delete dipanggil?
  upsertCalls: [],          // upsertExchange args
  auditCreated: [],         // auditLog.create data
};
function resetMocks() {
  scenario.activeExchange = { exchangeType: 'bitget' };
  scenario.openTrades = [];
  scenario.runningBots = 0;
  scenario.recentSwitches = 0;
  scenario.bitgetValid = true;
  spy.botUpdateMany = 0;
  spy.softDeleteUpdateMany = 0;
  spy.upsertCalls = [];
  spy.auditCreated = [];
}

// ─── Fake PrismaClient ───────────────────────────────────────────────────────
class FakePrismaClient {
  constructor() {
    this.userExchange = {
      findFirst: async () => scenario.activeExchange,
      updateMany: async () => { spy.softDeleteUpdateMany++; return { count: 1 }; },
    };
    this.trade = { findMany: async () => scenario.openTrades };
    this.bot = {
      count: async () => scenario.runningBots,
      updateMany: async () => { spy.botUpdateMany++; return { count: scenario.runningBots }; },
    };
    this.auditLog = {
      count: async () => scenario.recentSwitches,
      create: async ({ data }) => { spy.auditCreated.push(data); return data; },
    };
  }
}

// ─── Fake BitgetClient ───────────────────────────────────────────────────────
class FakeBitgetClient {
  constructor() {}
  async getBalance() {
    if (!scenario.bitgetValid) throw new Error('signature error / invalid key');
    return { available: '1000' };
  }
}

// ─── Fake userExchange.upsertExchange ────────────────────────────────────────
const fakeUserExchange = {
  upsertExchange: async (userId, args) => { spy.upsertCalls.push({ userId, args }); return { ok: true }; },
};

// ─── Inject mocks via Module._load override (sebelum require service) ─────────
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@prisma/client') return { PrismaClient: FakePrismaClient };
  if (request.endsWith('infrastructure/exchange/BitgetClient')) return FakeBitgetClient;
  if (request === './userExchange' || request.endsWith('/services/userExchange')) return fakeUserExchange;
  return _origLoad.apply(this, arguments);
};

const { getExchangeStatus, switchExchange, validateNewExchangeKey } =
  require('../src/services/exchangeSwitch');

Module._load = _origLoad; // restore

const USER = 'user-123';
const goodKeys = { newExchange: 'bitget', apiKey: 'ak', secretKey: 'sk', passphrase: 'pp' };

// ─── Tests ───────────────────────────────────────────────────────────────────
describe('getExchangeStatus (AC-06)', () => {
  beforeEach(resetMocks);

  it('canSwitch=true bila tidak ada posisi & bot', async () => {
    const s = await getExchangeStatus(USER);
    assert.strictEqual(s.canSwitch, true);
    assert.strictEqual(s.blockerReason, null);
    assert.strictEqual(s.exchange, 'bitget');
  });

  it('blockerReason OPEN_POSITIONS + positions terisi', async () => {
    scenario.openTrades = [{ symbol: 'BTCUSDT', side: 'LONG', pnl: 340000 }];
    const s = await getExchangeStatus(USER);
    assert.strictEqual(s.canSwitch, false);
    assert.strictEqual(s.blockerReason, 'OPEN_POSITIONS');
    assert.strictEqual(s.positions[0].symbol, 'BTCUSDT');
    assert.strictEqual(s.positions[0].unrealizedPnl, 340000);
  });

  it('blockerReason BOTS_RUNNING bila ada bot running', async () => {
    scenario.runningBots = 2;
    const s = await getExchangeStatus(USER);
    assert.strictEqual(s.blockerReason, 'BOTS_RUNNING');
  });

  it('blockerReason BOTH bila posisi + bot', async () => {
    scenario.openTrades = [{ symbol: 'ETHUSDT', side: 'SHORT', pnl: -1 }];
    scenario.runningBots = 1;
    const s = await getExchangeStatus(USER);
    assert.strictEqual(s.blockerReason, 'BOTH');
  });
});

describe('switchExchange guard (S2-QA-01 / AC-01,02)', () => {
  beforeEach(resetMocks);

  it('Case 1 — open position → 409 code OPEN_POSITIONS_EXIST + list posisi', async () => {
    scenario.openTrades = [{ symbol: 'BTCUSDT', side: 'LONG', pnl: 340000 }];
    await assert.rejects(() => switchExchange(USER, goodKeys), (e) => {
      assert.strictEqual(e.statusCode, 409);
      assert.strictEqual(e.code, 'OPEN_POSITIONS_EXIST');
      assert.strictEqual(e.positions[0].symbol, 'BTCUSDT');
      return true;
    });
    assert.strictEqual(spy.softDeleteUpdateMany, 0, 'key lama TIDAK boleh disentuh');
  });

  it('Case 2 — bot running → 409 code BOT_RUNNING', async () => {
    scenario.runningBots = 1;
    await assert.rejects(() => switchExchange(USER, goodKeys), (e) => {
      assert.strictEqual(e.statusCode, 409);
      assert.strictEqual(e.code, 'BOT_RUNNING');
      assert.ok(/bot/i.test(e.message));
      return true;
    });
  });

  it('Case 3 — posisi DAN bot → 409 code BOTH', async () => {
    scenario.openTrades = [{ symbol: 'X', side: 'LONG', pnl: 0 }];
    scenario.runningBots = 1;
    await assert.rejects(() => switchExchange(USER, goodKeys), (e) => {
      assert.strictEqual(e.code, 'BOTH');
      return true;
    });
  });
});

describe('validateNewExchangeKey (S2-QA-02 / AC-04)', () => {
  beforeEach(resetMocks);

  it('key valid → resolve true', async () => {
    scenario.bitgetValid = true;
    assert.strictEqual(await validateNewExchangeKey('bitget', 'ak', 'sk', 'pp'), true);
  });

  it('key invalid → throw 422 dengan pesan spesifik', async () => {
    scenario.bitgetValid = false;
    await assert.rejects(() => validateNewExchangeKey('bitget', 'bad', 'bad', 'bad'), (e) => {
      assert.strictEqual(e.statusCode, 422);
      assert.ok(/tidak valid/i.test(e.message));
      return true;
    });
  });

  it('non-bitget → skip validasi (trusted)', async () => {
    assert.strictEqual(await validateNewExchangeKey('bybit', 'ak', 'sk'), true);
  });
});

describe('switchExchange invalid key (S2-QA-02 — key lama tetap aktif)', () => {
  beforeEach(resetMocks);

  it('key baru invalid → 422 dan TIDAK ada revoke/stop/audit', async () => {
    scenario.bitgetValid = false;
    await assert.rejects(() => switchExchange(USER, goodKeys), (e) => e.statusCode === 422);
    assert.strictEqual(spy.botUpdateMany, 0, 'bot tidak boleh di-stop');
    assert.strictEqual(spy.softDeleteUpdateMany, 0, 'key lama tidak boleh di-soft-delete');
    assert.strictEqual(spy.upsertCalls.length, 0, 'key baru tidak boleh disimpan');
    assert.strictEqual(spy.auditCreated.length, 0, 'tidak ada audit log');
  });
});

describe('switchExchange rate limit (AC-05)', () => {
  beforeEach(resetMocks);

  it('switch ke-4 dalam 24 jam → 429', async () => {
    scenario.recentSwitches = 3;
    await assert.rejects(() => switchExchange(USER, goodKeys), (e) => {
      assert.strictEqual(e.statusCode, 429);
      assert.strictEqual(e.code, 'RATE_LIMIT_EXCEEDED');
      return true;
    });
  });
});

describe('switchExchange happy path (S2-QA-03 / AC-03,08)', () => {
  beforeEach(resetMocks);

  it('200 + bot di-stop + key lama soft-delete + audit EXCHANGE_SWITCH', async () => {
    // Guard mensyaratkan 0 bot running untuk lolos; graceful-stop step tetap
    // jalan sebagai safety-net (no-op bila sudah 0).
    scenario.runningBots = 0;
    scenario.activeExchange = { exchangeType: 'bitget' };
    const res = await switchExchange(USER, { ...goodKeys, newExchange: 'bitget' });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.newExchange, 'bitget');
    assert.ok(spy.botUpdateMany >= 1, 'graceful-stop step harus dipanggil');
    assert.ok(spy.softDeleteUpdateMany >= 1, 'key lama harus di-soft-delete');
    assert.strictEqual(spy.upsertCalls.length, 1, 'key baru harus disimpan');

    assert.strictEqual(spy.auditCreated.length, 1);
    const audit = spy.auditCreated[0];
    assert.strictEqual(audit.action, 'EXCHANGE_SWITCH');
    const details = JSON.parse(audit.details);
    assert.strictEqual(details.toExchange, 'bitget');
    assert.ok('fromExchange' in details && 'timestamp' in details);
  });
});

run();
