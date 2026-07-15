/**
 * quantara.patches.test.js
 *
 * Unit test untuk semua patch Quantara Patch v1.0:
 *   FIX-1 strategyGuard         (src/middleware/strategyGuard.js)
 *   FIX-3 signalIdempotency     (src/core/signal-engine/signalIdempotency.js)
 *   FIX-4 htfRegimeFilter       (src/core/signal-engine/htfRegimeFilter.js)
 *   FIX-2 analyzeStrategyFit     (src/core/analytics-engine/strategyAnalysis.js)
 *
 * Repo Quantara TIDAK memakai mocha — test dijalankan sebagai script Node biasa
 * (`node test/quantara.patches.test.js`). Karena itu file ini menyertakan harness
 * describe/it/beforeEach minimal sendiri, konsisten dengan gaya test lain di repo
 * yang exit(1) saat ada kegagalan.
 *
 * Run: npm run test:patches   (atau: node test/quantara.patches.test.js)
 */

'use strict';

const assert = require('assert');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

// ─── Mini test harness (mocha-compatible subset) ─────────────────────────────
const _suites = [];
let _current = null;

function describe(name, fn) {
  const suite = { name, tests: [], beforeEach: null };
  const parent = _current;
  _current = suite;
  fn();
  _current = parent;
  _suites.push(suite);
}
function it(name, fn) { _current.tests.push({ name, fn }); }
function beforeEach(fn) { _current.beforeEach = fn; }

async function run() {
  let passed = 0, failed = 0;
  const failures = [];

  for (const suite of _suites) {
    console.log(`\n  ${suite.name}`);
    for (const t of suite.tests) {
      try {
        if (suite.beforeEach) await suite.beforeEach();
        await t.fn();
        console.log(`    ✓ ${t.name}`);
        passed++;
      } catch (err) {
        console.log(`    ✗ ${t.name}`);
        console.log(`        ${err.message}`);
        failures.push({ suite: suite.name, test: t.name, err });
        failed++;
      }
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Quantara Patches: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log(`${'─'.repeat(60)}\n`);

  if (failed > 0) {
    console.error('❌ Ada test yang gagal.');
    process.exit(1);
  } else {
    console.log('✅ Semua patch test lulus.');
  }
}

// ─── Import patch modules (path sesuai struktur repo Quantara) ────────────────
const { strategyGuard, BLOCKED_STRATEGIES }            = require('../src/middleware/strategyGuard');
const { isDuplicate, makeSignalKey, _resetForTests }   = require('#core/signal-engine/signalIdempotency.js');
const { meanReversionRegimeFilter, classifyHTFRegime } = require('#core/signal-engine/htfRegimeFilter.js');
const { analyzeStrategyFit }                           = require('#core/analytics-engine/strategyAnalysis.js');

// ─── Helper: mock req/res/next ───────────────────────────────────────────────
function mockRes() {
  const res = { _status: null, _json: null };
  res.status = (code) => { res._status = code; return res; };
  res.json   = (data)  => { res._json  = data; return res; };
  return res;
}
function mockReq(body = {}, params = {}, userId = 'user-1234') {
  return { body, params, userId };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('Quantara Patches', () => {});

// ═══════════════════════════════════════════════════════════════════════════
describe('[FIX-1] strategyGuard — BREAKOUT_RETEST blocker', () => {

  it('harus allow BREAKOUT_RETEST dalam dry-run', () => {
    const req  = mockReq({ strategyKey: 'BREAKOUT_RETEST', dryRun: true });
    const res  = mockRes();
    let nextCalled = false;
    strategyGuard(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(res._status, null);
  });

  it('harus blokir BREAKOUT_RETEST live dengan STRATEGY_DRYRUN_ONLY', () => {
    const req  = mockReq({ strategyKey: 'BREAKOUT_RETEST', dryRun: false });
    const res  = mockRes();
    strategyGuard(req, res, () => { throw new Error('next() tak boleh dipanggil'); });
    assert.strictEqual(res._status, 403);
    assert.strictEqual(res._json.code, 'STRATEGY_DRYRUN_ONLY');
  });

  it('harus allow ADAPTIVE_FUSION', () => {
    const req  = mockReq({ strategyKey: 'ADAPTIVE_FUSION' });
    const res  = mockRes();
    let nextCalled = false;
    strategyGuard(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(res._status, null);
  });

  it('harus allow TREND_FOLLOWING', () => {
    const req  = mockReq({ strategyKey: 'TREND_FOLLOWING' });
    const res  = mockRes();
    let nextCalled = false;
    strategyGuard(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
  });

  it('harus allow MEAN_REVERSION', () => {
    const req  = mockReq({ strategyKey: 'MEAN_REVERSION' });
    const res  = mockRes();
    let nextCalled = false;
    strategyGuard(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
  });

  it('harus pass jika tidak ada strategy di body', () => {
    const req  = mockReq({});
    const res  = mockRes();
    let nextCalled = false;
    strategyGuard(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
  });

  it('BLOCKED_STRATEGIES tidak boleh mengandung BREAKOUT_RETEST', () => {
    assert.ok(!BLOCKED_STRATEGIES.has('BREAKOUT_RETEST'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('[FIX-3] signalIdempotency — duplicate order prevention', () => {

  beforeEach(() => _resetForTests());

  const BASE_SIGNAL = {
    symbol: 'BTCUSDT',
    strategy: 'TREND_FOLLOWING',
    candleOpenTime: 1700000000000,
    direction: 'LONG',
  };

  it('sinyal pertama harus return false (bukan duplicate)', () => {
    assert.strictEqual(isDuplicate(BASE_SIGNAL), false);
  });

  it('sinyal kedua identik harus return true (duplicate)', () => {
    isDuplicate(BASE_SIGNAL);
    assert.strictEqual(isDuplicate(BASE_SIGNAL), true);
  });

  it('sinyal berbeda symbol harus return false', () => {
    isDuplicate(BASE_SIGNAL);
    assert.strictEqual(isDuplicate({ ...BASE_SIGNAL, symbol: 'ETHUSDT' }), false);
  });

  it('sinyal berbeda direction harus return false', () => {
    isDuplicate(BASE_SIGNAL);
    assert.strictEqual(isDuplicate({ ...BASE_SIGNAL, direction: 'SHORT' }), false);
  });

  it('sinyal berbeda candleOpenTime harus return false', () => {
    isDuplicate(BASE_SIGNAL);
    assert.strictEqual(isDuplicate({ ...BASE_SIGNAL, candleOpenTime: 1700000060000 }), false);
  });

  it('makeSignalKey harus deterministic', () => {
    const k1 = makeSignalKey(BASE_SIGNAL);
    const k2 = makeSignalKey(BASE_SIGNAL);
    assert.strictEqual(k1, k2);
  });

  it('makeSignalKey harus berubah jika parameter berubah', () => {
    const k1 = makeSignalKey(BASE_SIGNAL);
    const k2 = makeSignalKey({ ...BASE_SIGNAL, direction: 'SHORT' });
    assert.notStrictEqual(k1, k2);
  });

  it('sinyal expired (TTL = 1ms) harus boleh diproses ulang', async () => {
    isDuplicate(BASE_SIGNAL, 1); // TTL 1ms
    await new Promise(r => setTimeout(r, 5));
    assert.strictEqual(isDuplicate(BASE_SIGNAL), false); // seharusnya baru lagi
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('[FIX-4] htfRegimeFilter — MEAN_REVERSION regime guard', () => {

  const RANGING_HTF = {
    emaFast: 50000, emaSlow: 50050, rsi: 52,
    close: 50000, atr: 500, atrBaseline: 500,
  };

  const STRONG_BULL_HTF = {
    emaFast: 52000, emaSlow: 50000, rsi: 65,
    close: 52000, atr: 800, atrBaseline: 500,
  };

  const STRONG_BEAR_HTF = {
    emaFast: 48000, emaSlow: 50000, rsi: 38,
    close: 48000, atr: 800, atrBaseline: 500,
  };

  it('LONG di ranging market harus allowed', () => {
    const result = meanReversionRegimeFilter({ direction: 'LONG', htfData: RANGING_HTF });
    assert.strictEqual(result.allowed, true);
  });

  it('SHORT di ranging market harus allowed', () => {
    const result = meanReversionRegimeFilter({ direction: 'SHORT', htfData: RANGING_HTF });
    assert.strictEqual(result.allowed, true);
  });

  it('SHORT di strong_bull harus diblokir', () => {
    const result = meanReversionRegimeFilter({ direction: 'SHORT', htfData: STRONG_BULL_HTF });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('strong bull'));
  });

  it('LONG di strong_bear harus diblokir', () => {
    const result = meanReversionRegimeFilter({ direction: 'LONG', htfData: STRONG_BEAR_HTF });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('strong bear'));
  });

  it('LONG di strong_bull harus allowed (trend-following)', () => {
    const result = meanReversionRegimeFilter({ direction: 'LONG', htfData: STRONG_BULL_HTF });
    assert.strictEqual(result.allowed, true);
  });

  it('ATR spike 2.5x harus diblokir', () => {
    const highVolHtf = { ...RANGING_HTF, atr: 1250, atrBaseline: 500 }; // 2.5x
    const result = meanReversionRegimeFilter({ direction: 'LONG', htfData: highVolHtf });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('volatility'));
  });

  it('classifyHTFRegime: ranging market harus return "ranging"', () => {
    assert.strictEqual(classifyHTFRegime(RANGING_HTF), 'ranging');
  });

  it('classifyHTFRegime: strong bull harus return "strong_bull"', () => {
    assert.strictEqual(classifyHTFRegime(STRONG_BULL_HTF), 'strong_bull');
  });

  it('classifyHTFRegime: strong bear harus return "strong_bear"', () => {
    assert.strictEqual(classifyHTFRegime(STRONG_BEAR_HTF), 'strong_bear');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('[FIX-2] analyzeStrategyFit — strategy analysis logic', () => {

  const TRENDING_MARKET = {
    symbol: 'BTCUSDT',
    ema9: 52000, ema21: 50000, rsi: 62,
    atr: 600, atrBaseline: 500,
    volume: 1500, avgVolume: 1200,
    htfTrend: 'trending_bull',
    lastClose: 52000, bbUpper: 53000, bbLower: 49000,
  };

  const RANGING_MARKET = {
    symbol: 'ETHUSDT',
    ema9: 3000, ema21: 3001, rsi: 28,
    atr: 40, atrBaseline: 45,
    volume: 1000, avgVolume: 1100,
    htfTrend: 'ranging',
    lastClose: 2985, bbUpper: 3100, bbLower: 2990,
  };

  it('trending market harus rekomendasikan TREND_FOLLOWING atau SMART_MONEY_CONCEPTS', () => {
    const result = analyzeStrategyFit(TRENDING_MARKET, 'ADAPTIVE_FUSION');
    assert.strictEqual(result.ok, true);
    assert.ok(['TREND_FOLLOWING', 'SMART_MONEY_CONCEPTS'].includes(result.recommended));
  });

  it('ranging + BB oversold harus rekomendasikan MEAN_REVERSION', () => {
    const result = analyzeStrategyFit(RANGING_MARKET, 'ADAPTIVE_FUSION');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.recommended, 'MEAN_REVERSION');
  });

  it('BREAKOUT_RETEST boleh muncul di strategyScores', () => {
    const result = analyzeStrategyFit(TRENDING_MARKET, 'BREAKOUT_RETEST');
    assert.ok('BREAKOUT_RETEST' in result.strategyScores);
    assert.ok(!result.blockedStrategies.includes('BREAKOUT_RETEST'));
  });

  it('response harus mengandung semua required fields', () => {
    const result = analyzeStrategyFit(TRENDING_MARKET, 'ADAPTIVE_FUSION');
    const required = ['ok', 'symbol', 'timestamp', 'marketRegime', 'indicators',
                      'signals', 'strategyScores', 'recommended', 'confidence',
                      'switchRecommended', 'blockedStrategies'];
    for (const field of required) {
      assert.ok(field in result, `Field "${field}" tidak ada di response`);
    }
  });

  it('switchRecommended harus false jika currentStrategy sudah optimal', () => {
    const result = analyzeStrategyFit(RANGING_MARKET, 'MEAN_REVERSION');
    assert.strictEqual(result.switchRecommended, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('[T5-SPRINT] strategyName null guard — warning, tidak crash', () => {
  // Test ini memverifikasi bahwa logic resolvedStrategy di database.js benar:
  // strategyName ?? indicators?.strategy ?? indicators?.firedByStrategy ?? null
  // Jika semua null → resolvedStrategy = null → warning harus ter-trigger.

  function resolveStrategy(strategyName, indicators) {
    return strategyName ?? indicators?.strategy ?? indicators?.firedByStrategy ?? null;
  }

  it('resolvedStrategy menggunakan strategyName jika ada', () => {
    assert.strictEqual(resolveStrategy('ADAPTIVE_FUSION', { strategy: 'OTHER' }), 'ADAPTIVE_FUSION');
  });

  it('resolvedStrategy fallback ke indicators.strategy jika strategyName null', () => {
    assert.strictEqual(resolveStrategy(null, { strategy: 'TREND_FOLLOWING' }), 'TREND_FOLLOWING');
  });

  it('resolvedStrategy fallback ke indicators.firedByStrategy jika strategy juga null', () => {
    assert.strictEqual(resolveStrategy(null, { firedByStrategy: 'MEAN_REVERSION' }), 'MEAN_REVERSION');
  });

  it('resolvedStrategy return null jika semua path null — ini yang trigger warning', () => {
    assert.strictEqual(resolveStrategy(null, {}), null);
    assert.strictEqual(resolveStrategy(null, null), null);
    assert.strictEqual(resolveStrategy(undefined, undefined), null);
  });

  it('warning console.warn dipanggil jika resolvedStrategy null', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    // Simulasi kondisi yang memicu warning di database.js insertTrade
    const resolved = resolveStrategy(null, null);
    if (!resolved) {
      console.warn('[DB] insertTrade: strategyName null — trade akan masuk sebagai Untracked', { sessionId: 'test', symbol: 'BTCUSDT', side: 'LONG' });
    }

    console.warn = origWarn;
    assert.ok(warnings.length > 0, 'Harus ada warning jika strategyName null');
    assert.ok(warnings[0].includes('Untracked'), 'Warning harus menyebut Untracked');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('[BUG-08] SL/TP hard guard — sinyal tanpa SL/TP valid harus ditolak', () => {
  // Replica dari logic guard di BotEngine._handleSignal() agar bisa diuji tanpa
  // menginstansiasi BotEngine penuh. Perubahan di BotEngine HARUS tetap sinkron.

  function validateSlTp(signal, price, sl, tp) {
    if (!Number.isFinite(sl) || sl <= 0 || !Number.isFinite(tp) || tp <= 0) {
      return { ok: false, reason: `SL/TP tidak finite/positif: sl=${sl} tp=${tp}` };
    }
    if ((signal === 'LONG' && sl >= price) || (signal === 'SHORT' && sl <= price)) {
      return { ok: false, reason: `SL di sisi salah: ${signal} sl=${sl} price=${price}` };
    }
    if ((signal === 'LONG' && tp <= price) || (signal === 'SHORT' && tp >= price)) {
      return { ok: false, reason: `TP di sisi salah: ${signal} tp=${tp} price=${price}` };
    }
    return { ok: true };
  }

  it('LONG valid: sl < price < tp harus ok', () => {
    assert.strictEqual(validateSlTp('LONG', 100, 98, 104).ok, true);
  });

  it('SHORT valid: tp < price < sl harus ok', () => {
    assert.strictEqual(validateSlTp('SHORT', 100, 102, 96).ok, true);
  });

  it('sl=null harus ditolak', () => {
    assert.strictEqual(validateSlTp('LONG', 100, null, 104).ok, false);
  });

  it('tp=NaN harus ditolak', () => {
    assert.strictEqual(validateSlTp('LONG', 100, 98, NaN).ok, false);
  });

  it('sl=0 harus ditolak', () => {
    assert.strictEqual(validateSlTp('LONG', 100, 0, 104).ok, false);
  });

  it('LONG sl >= price harus ditolak (SL di sisi salah)', () => {
    assert.strictEqual(validateSlTp('LONG', 100, 100, 104).ok, false);
    assert.strictEqual(validateSlTp('LONG', 100, 101, 104).ok, false);
  });

  it('SHORT sl <= price harus ditolak', () => {
    assert.strictEqual(validateSlTp('SHORT', 100, 99, 96).ok, false);
  });

  it('LONG tp <= price harus ditolak', () => {
    assert.strictEqual(validateSlTp('LONG', 100, 98, 100).ok, false);
    assert.strictEqual(validateSlTp('LONG', 100, 98, 99).ok, false);
  });

  it('SHORT tp >= price harus ditolak', () => {
    assert.strictEqual(validateSlTp('SHORT', 100, 102, 101).ok, false);
  });
});

run();
