'use strict';
/**
 * PairTierDriftAndRecalibration.test.js
 *
 * Tests for the v2.4 threshold-lifecycle tooling:
 *   - PairTierDriftMonitor: snapshot/compare/alert (B)
 *   - tierRecalibration: percentile report + drift flagging (A)
 */

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { pairClassifier } = require('../src/infrastructure/classification/PairClassifier');
const { PairTierDriftMonitor } = require('../src/infrastructure/classification/PairTierDriftMonitor');
const { computeRecalibrationReport, percentile } = require('../src/infrastructure/classification/tierRecalibration');

/** Seed the singleton's CoinGecko cache with n synthetic coins across the risk spectrum. */
function seedUniverse(n = 60) {
  pairClassifier._dynamicCoinData.clear();
  pairClassifier._dynamicRankMap.clear();
  for (let i = 1; i <= n; i++) {
    const base = `C${i}`;
    // Rank 1..n; volatility & liquidity worsen with rank so scores spread out.
    const priceChange24h = 1 + (i / n) * 9;           // 1% .. 10%
    const marketCap = 1e12 / i;                        // shrinking cap
    const volume24h = marketCap * (0.08 - (i / n) * 0.075); // liq ratio 0.08 → 0.005
    pairClassifier._dynamicCoinData.set(base, {
      id: base.toLowerCase(), marketCap, volume24h, rank: i,
      priceChange24h, high24h: 100 + priceChange24h, low24h: 100 - priceChange24h, currentPrice: 100,
    });
    pairClassifier._dynamicRankMap.set(base, i);
  }
  pairClassifier._dynamicLastAt = Date.now();
}

function clearUniverse() {
  pairClassifier._dynamicCoinData.clear();
  pairClassifier._dynamicRankMap.clear();
  pairClassifier._dynamicLastAt = null;
}

describe('PairTierDriftMonitor', () => {
  let tmpFile;
  beforeEach(() => {
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drift-')), 'snap.json');
    seedUniverse();
  });
  afterEach(() => clearUniverse());

  it('first run establishes a baseline without alerting', () => {
    const alerts = [];
    const mon = new PairTierDriftMonitor({ snapshotFile: tmpFile, notify: (m) => alerts.push(m) });
    const r = mon.checkDrift();
    assert.equal(r.firstRun, true);
    assert.equal(r.alerted, false);
    assert.ok(fs.existsSync(tmpFile));
    const persisted = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    assert.ok(Object.keys(persisted.tiers).length >= 50);
  });

  it('unchanged universe → 0% drift, no alert', () => {
    const alerts = [];
    const mon = new PairTierDriftMonitor({ snapshotFile: tmpFile, notify: (m) => alerts.push(m) });
    mon.checkDrift();               // baseline
    const r = mon.checkDrift();     // same data
    assert.equal(r.driftPct, 0);
    assert.equal(r.alerted, false);
    assert.equal(alerts.length, 0);
  });

  it('regime shift (volatility spike across universe) → drift alert fires', () => {
    const alerts = [];
    const mon = new PairTierDriftMonitor({ snapshotFile: tmpFile, alertThresholdPct: 10, notify: (m) => alerts.push(m) });
    mon.checkDrift(); // baseline on calm universe

    // Simulate a market-wide vol expansion: every coin's 24h range triples.
    for (const [, d] of pairClassifier._dynamicCoinData) {
      const range = (d.high24h - d.low24h) * 3;
      d.high24h = d.currentPrice + range / 2;
      d.low24h = d.currentPrice - range / 2;
      d.priceChange24h *= 3;
    }
    const r = mon.checkDrift();
    assert.ok(r.driftPct > 10, `driftPct=${r.driftPct}`);
    assert.equal(r.alerted, true);
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0].includes('recalibrate-pair-tiers'));
  });

  it('empty CoinGecko cache (outage) keeps the previous baseline instead of comparing against nothing', () => {
    const mon = new PairTierDriftMonitor({ snapshotFile: tmpFile, notify: () => {} });
    mon.checkDrift(); // baseline
    const before = fs.readFileSync(tmpFile, 'utf8');
    clearUniverse();
    const r = mon.checkDrift();
    assert.equal(r.alerted, false);
    assert.equal(fs.readFileSync(tmpFile, 'utf8'), before); // baseline untouched
  });
});

describe('tierRecalibration', () => {
  beforeEach(() => seedUniverse(80));
  afterEach(() => clearUniverse());

  it('percentile() interpolates correctly', () => {
    assert.equal(percentile([0, 10], 50), 5);
    assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
    assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
  });

  it('report includes distribution, tier counts, and suggestions for every threshold', () => {
    const report = computeRecalibrationReport();
    assert.equal(report.ok, true);
    assert.ok(report.universe >= 50);
    assert.ok(report.scoreDistribution.p50 > 0 && report.scoreDistribution.p50 < 1);
    const totalCounted = Object.values(report.tierCounts).reduce((s, n) => s + n, 0);
    assert.equal(totalCounted, report.universe);
    for (const key of ['STABLE', 'SEMI_VOLATILE', 'VOLATILE']) {
      assert.ok(typeof report.suggestedThresholds[key] === 'number', `missing suggestion for ${key}`);
      assert.ok(typeof report.drift[key] === 'number');
    }
    assert.ok(typeof report.recommendation === 'string' && report.recommendation.length > 0);
  });

  it('suggested thresholds stay ordered STABLE < SEMI_VOLATILE < VOLATILE', () => {
    const s = computeRecalibrationReport().suggestedThresholds;
    assert.ok(s.STABLE < s.SEMI_VOLATILE, `${s.STABLE} !< ${s.SEMI_VOLATILE}`);
    assert.ok(s.SEMI_VOLATILE < s.VOLATILE, `${s.SEMI_VOLATILE} !< ${s.VOLATILE}`);
  });

  it('refuses to report on a too-small universe (stale/empty cache guard)', () => {
    seedUniverse(10);
    const report = computeRecalibrationReport();
    assert.equal(report.ok, false);
    assert.ok(report.reason.includes('refreshDynamic'));
  });

  it('report never mutates the live thresholds', () => {
    const { TIER_THRESHOLDS } = require('../src/infrastructure/classification/PairClassifier');
    const before = { ...TIER_THRESHOLDS };
    computeRecalibrationReport();
    assert.deepEqual({ ...TIER_THRESHOLDS }, before);
  });
});
