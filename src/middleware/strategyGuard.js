/**
 * strategyGuard.js  (src/middleware/strategyGuard.js)
 * Middleware: blokir strategi yang belum production-ready dari start live/dry-run.
 *
 * ROOT CAUSE FIX (FIX-1):
 *   BREAKOUT_RETEST sempat WR 0.7% karena belum terintegrasi ke BotEngine (fallback ke
 *   strategi B) + bug entry/SL. Setelah perbaikan: dry-run diizinkan, live diblokir
 *   sampai validasi staging selesai.
 *
 * Catatan integrasi Quantara:
 *   Route Quantara mengirim strategi via `strategyKey` (lihat /:symbol/start dan
 *   /:symbol/strategy di routes/bots-afs.js). Guard ini membaca `strategy`
 *   maupun `strategyKey` agar kompatibel.
 *
 * Usage di routes/bots-afs.js:
 *   router.post('/:symbol/start',    ..., strategyGuard, handler);
 *   router.post('/:symbol/strategy', ..., strategyGuard, handler);
 */

'use strict';

// Strategi yang diblokir total (live maupun dry-run)
const BLOCKED_STRATEGIES = new Set([
  // kosong — gunakan DRY_RUN_ONLY untuk strategi staging
]);

// Strategi yang hanya boleh dry-run, belum boleh live
// Set STRATEGY_OVERRIDE=BREAKOUT_RETEST di .env untuk izinkan live (dev saja)
const DRY_RUN_ONLY_STRATEGIES = new Set([
  'BREAKOUT_RETEST',
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

  // Block total — bahkan staging wajib override eksplisit via env
  if (BLOCKED_STRATEGIES.has(strategy) && !overrides.includes(strategy)) {
    return res.status(403).json({
      ok: false,
      statusCode: 403,
      message: `Strategi "${strategy}" sedang dalam perbaikan dan tidak dapat dijalankan. ` +
               `Win rate saat ini: 0.7%. Hubungi tim engineering.`,
      code: 'STRATEGY_BLOCKED',
      strategy,
    });
  }

  // Dry-run only — boleh dry-run, tidak boleh live (kecuali STRATEGY_OVERRIDE)
  if (DRY_RUN_ONLY_STRATEGIES.has(strategy) && !dryRun && !overrides.includes(strategy)) {
    return res.status(403).json({
      ok: false,
      statusCode: 403,
      message: `Strategi "${strategy}" hanya tersedia dalam mode Dry Run saat ini. ` +
               `Sedang divalidasi di staging sebelum live.`,
      code: 'STRATEGY_DRYRUN_ONLY',
      strategy,
    });
  }

  next();
}

module.exports = { strategyGuard, BLOCKED_STRATEGIES, DRY_RUN_ONLY_STRATEGIES };
