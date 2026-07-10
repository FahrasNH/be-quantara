/**
 * PairTierDriftMonitor.js  (src/infrastructure/classification/PairTierDriftMonitor.js)
 *
 * v2.4 follow-up (ATR_AND_PAIR_TIER_GUIDE.md §2.3 / FAQ "Seberapa sering ambang
 * perlu dikalibrasi ulang?"): the tier thresholds (0.48/0.65/0.78) were
 * calibrated on the 2023–2024 score distribution. Market regimes shift that
 * distribution left/right over time, which shows up as coins silently changing
 * tier without their fundamentals changing. This monitor makes that drift
 * VISIBLE instead of silent:
 *
 *   - snapshot(): classify every coin currently in the CoinGecko cache and
 *     record { tier, score } per base ticker.
 *   - checkDrift(): compare today's snapshot against the last persisted one;
 *     if more than `alertThresholdPct` of common coins changed tier, emit an
 *     ops alert (console + Telegram when configured) recommending a
 *     recalibration review (scripts/recalibrate-pair-tiers.js).
 *
 * Snapshots persist to data/pair-tier-snapshots.json so restarts don't reset
 * the baseline. This module only OBSERVES — it never mutates thresholds;
 * threshold changes stay a human decision (report → backtest → deploy).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pairClassifier } = require('./PairClassifier');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'pair-tier-snapshots.json');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

class PairTierDriftMonitor {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.alertThresholdPct=10] - % of coins changing tier that triggers an alert
   * @param {number} [opts.intervalMs] - schedule period (default weekly)
   * @param {Function} [opts.notify] - alert sink (message: string) => void; defaults to TelegramNotifier.notifyError
   * @param {string} [opts.snapshotFile] - override persistence path (tests)
   */
  constructor(opts = {}) {
    this.alertThresholdPct = opts.alertThresholdPct ?? 10;
    this.intervalMs = opts.intervalMs ?? WEEK_MS;
    this.snapshotFile = opts.snapshotFile ?? SNAPSHOT_FILE;
    this._notify = opts.notify ?? null;
    this._timer = null;
  }

  /** Classify every coin in the current CoinGecko cache → { BASE: { tier, score } }. */
  snapshot() {
    const out = {};
    for (const base of pairClassifier._dynamicCoinData.keys()) {
      const r = pairClassifier.classify(`${base}USDT`);
      if (r?.tier) out[base] = { tier: r.tier, score: r.hybridScore ?? null };
    }
    return out;
  }

  _loadPersisted() {
    try {
      return JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
    } catch {
      return null;
    }
  }

  _persist(record) {
    fs.mkdirSync(path.dirname(this.snapshotFile), { recursive: true });
    fs.writeFileSync(this.snapshotFile, JSON.stringify(record, null, 2));
  }

  /**
   * Compare current tiers against the last persisted snapshot.
   * Always persists the fresh snapshot afterwards (rolling weekly baseline).
   * @returns {{ driftPct: number, changed: Array<{base:string,from:string,to:string}>, total: number, alerted: boolean, firstRun: boolean }}
   */
  checkDrift() {
    const current = this.snapshot();
    const currentCount = Object.keys(current).length;
    const prevRecord = this._loadPersisted();
    const result = { driftPct: 0, changed: [], total: 0, alerted: false, firstRun: !prevRecord };

    if (currentCount === 0) {
      // CoinGecko cache empty (outage / startup before first refresh) — a
      // comparison would read as "everything vanished"; keep the old baseline.
      return result;
    }

    if (prevRecord?.tiers) {
      const prev = prevRecord.tiers;
      const common = Object.keys(current).filter((b) => prev[b]);
      result.total = common.length;
      for (const base of common) {
        if (prev[base].tier !== current[base].tier) {
          result.changed.push({ base, from: prev[base].tier, to: current[base].tier });
        }
      }
      result.driftPct = result.total ? (result.changed.length / result.total) * 100 : 0;

      if (result.driftPct > this.alertThresholdPct) {
        result.alerted = true;
        const sample = result.changed.slice(0, 10)
          .map((c) => `${c.base}: ${c.from}→${c.to}`).join(', ');
        const msg = `[PairTierDrift] ${result.changed.length}/${result.total} pairs `
          + `(${result.driftPct.toFixed(1)}%) changed tier since ${prevRecord.at || 'last snapshot'} `
          + `(threshold ${this.alertThresholdPct}%). Sample: ${sample}. `
          + `Review thresholds: node scripts/recalibrate-pair-tiers.js`;
        console.warn(msg);
        this._alert(msg);
      }
    }

    this._persist({ at: new Date().toISOString(), tiers: current });
    return result;
  }

  _alert(message) {
    try {
      if (this._notify) return this._notify(message);
      // Lazy require: TelegramNotifier reads env at load; keep tests import-light.
      const { notifyError, enabled } = require('../notifications/TelegramNotifier');
      if (enabled) notifyError(message);
    } catch (e) {
      console.warn('[PairTierDrift] alert delivery failed:', e.message);
    }
  }

  /**
   * Weekly schedule. Runs an immediate check only when the persisted baseline
   * is missing or older than one interval (so PM2 restarts every few hours
   * don't turn "weekly" into "hourly").
   */
  start() {
    if (this._timer) return;
    const prev = this._loadPersisted();
    const stale = !prev?.at || (Date.now() - Date.parse(prev.at)) > this.intervalMs;
    if (stale) {
      // Delay the first check a bit so refreshDynamic() has populated the cache.
      setTimeout(() => { try { this.checkDrift(); } catch (e) { console.warn('[PairTierDrift]', e.message); } }, 5 * 60 * 1000).unref?.();
    }
    this._timer = setInterval(() => {
      try { this.checkDrift(); } catch (e) { console.warn('[PairTierDrift]', e.message); }
    }, this.intervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

const pairTierDriftMonitor = new PairTierDriftMonitor();

module.exports = { PairTierDriftMonitor, pairTierDriftMonitor };
