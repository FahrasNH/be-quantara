/**
 * strategyGuard.js  (src/middleware/strategyGuard.js)
 * Middleware: blokir strategi yang belum production-ready dari start live/dry-run.
 *
 *   BS_BR: Sprint 14 HALT — 5/5 backtest windows unprofitable
 *   (WR 37.1%, PF 0.72, n=267). Live blocked; dry-run/backtest allowed so fixes
 *   can be validated. Re-enable only after ≥4/5 window gate passes.
 *
 * Catatan integrasi Quantara:
 *   Route Quantara mengirim strategi via `strategyKey` (lihat /:symbol/start dan
 *   /:symbol/strategy di routes/bots-afs.js). Guard ini membaca `strategy`
 *   maupun `strategyKey` agar kompatibel. Start tanpa body strategyKey harus
 *   juga di-guard via bot.strategyKey di handler (lihat isBsBrHaltedKey).
 *
 * Usage di routes/bots-afs.js:
 *   router.post('/:symbol/start',    ..., strategyGuard, handler);
 *   router.post('/:symbol/strategy', ..., strategyGuard, handler);
 */

'use strict';

const { isBsBrHaltedKey } = require('../../config/strategies');
const { normalizeStrategyKey } = require('../../config/strategyKeyNormalizer');

// Strategi yang diblokir total (live maupun dry-run)
const BLOCKED_STRATEGIES = new Set([
  // kosong — gunakan DRY_RUN_ONLY untuk strategi staging / halt
]);

// Strategi yang hanya boleh dry-run, belum boleh live
// Set STRATEGY_OVERRIDE=BS_BR di .env untuk izinkan live (dev saja)
const DRY_RUN_ONLY_STRATEGIES = new Set([
  'BREAKOUT_TRADING',
  'BS_BR',
  'BREAKOUT_STORM',
]);

/**
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function strategyGuard(req, res, next) {
  const strategy = req.body?.strategy ?? req.body?.strategyKey;
  const dryRun   = req.body?.dryRun === true || req.body?.dryRun === 'true';

  if (!strategy) return next(); // guard hanya aktif jika strategy eksplisit dikirim

  const overrideEnv = process.env.STRATEGY_OVERRIDE ?? '';
  const overrides   = overrideEnv.split(',').map(s => s.trim()).filter(Boolean);
  const upper = String(strategy).toUpperCase();
  const canonical = normalizeStrategyKey(upper);
  const overridden = overrides.some((o) => {
    const oUpper = String(o).toUpperCase();
    return oUpper === upper || oUpper === canonical
      || (isBsBrHaltedKey(upper) && isBsBrHaltedKey(o));
  });

  // Block total — bahkan staging wajib override eksplisit via env
  if (BLOCKED_STRATEGIES.has(strategy) && !overridden) {
    return res.status(403).json({
      ok: false,
      statusCode: 403,
      message: `Strategi "${strategy}" sedang dalam perbaikan dan tidak dapat dijalankan. ` +
               `Hubungi tim engineering.`,
      code: 'STRATEGY_BLOCKED',
      strategy,
    });
  }

  // Dry-run only — boleh dry-run, tidak boleh live (kecuali STRATEGY_OVERRIDE)
  const dryRunOnly = DRY_RUN_ONLY_STRATEGIES.has(canonical)
    || DRY_RUN_ONLY_STRATEGIES.has(upper)
    || isBsBrHaltedKey(strategy);
  if (dryRunOnly && !dryRun && !overridden) {
    return res.status(403).json({
      ok: false,
      statusCode: 403,
      message: `Strategi "${strategy}" di-HALT (Sprint 14: expectancy negatif pada backtest 5 window). ` +
               `Hanya tersedia Dry Run / backtest sampai re-test gate lolos. ` +
               `Set STRATEGY_OVERRIDE=${upper} di .env hanya untuk validasi staging.`,
      code: 'STRATEGY_DRYRUN_ONLY',
      strategy,
    });
  }

  next();
}

module.exports = { strategyGuard, BLOCKED_STRATEGIES, DRY_RUN_ONLY_STRATEGIES };
