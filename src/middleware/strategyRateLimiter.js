/**
 * strategyRateLimiter.js  (src/middleware/strategyRateLimiter.js)
 *
 * ROOT CAUSE FIX (FIX-5, Security):
 *   1. POST /bots/:symbol/strategy tidak punya rate limit spesifik →
 *      bisa di-spam untuk churn strategy terus-menerus.
 *   2. POST /bots/:symbol/stop dengan forceClose=true adalah operasi destruktif
 *      → perlu konfirmasi token untuk cegah accidental/CSRF trigger.
 *
 * Gunakan rateLimit dari express-rate-limit (sudah ada di project).
 * Catatan: di Quantara, auth middleware mengeset `req.userId` (bukan req.user.id).
 */

'use strict';

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

/**
 * Rate limiter untuk strategy switch.
 * Max 5 strategy changes per user per 60 detik.
 * Cukup longgar untuk normal use, cukup ketat untuk anti-spam.
 */
const strategyChangeLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 menit
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // Kunci per-user (fallback ke IP bila userId belum ada). Auth sudah berjalan
  // sebelum middleware ini, jadi req.userId hampir selalu tersedia. Fallback IP
  // memakai ipKeyGenerator agar IPv6 di-normalisasi (anti-bypass per /64).
  keyGenerator: (req) => (req.userId ? `strategy:${req.userId}` : `strategy:ip:${ipKeyGenerator(req.ip)}`),
  handler: (req, res) => {
    res.status(429).json({
      ok: false,
      statusCode: 429,
      message: 'Terlalu banyak permintaan ganti strategi. Coba lagi dalam 1 menit.',
      code: 'STRATEGY_RATE_LIMITED',
    });
  },
  // Skip di unit test dan saat eksplisit di-disable (E2E rate-limit test lain)
  skip: () => process.env.NODE_ENV === 'test',
});

/**
 * Middleware: Double-confirm untuk operasi stop + force-close.
 *
 * Client WAJIB mengirim body:
 *   { forceClose: true, confirm: true, confirmToken: "STOP_<SYMBOL>_<userId_last4>" }
 *
 * Stop biasa (tanpa forceClose) TIDAK memerlukan konfirmasi.
 *
 * ROOT CAUSE: tanpa ini, satu request malformed atau CSRF bisa force-close posisi live.
 */
function emergencyStopConfirmGuard(req, res, next) {
  const { forceClose, confirm, confirmToken } = req.body ?? {};

  // Hanya aktif untuk operasi force-close (stop biasa tidak perlu double-confirm)
  if (!forceClose) return next();

  if (confirm !== true) {
    return res.status(400).json({
      ok: false,
      statusCode: 400,
      message: 'Force close membutuhkan konfirmasi eksplisit. Set confirm: true di body.',
      code: 'MISSING_CONFIRM',
    });
  }

  const { symbol } = req.params;
  const userId     = req.userId ?? '';
  const last4      = userId.toString().slice(-4);
  const expected   = `STOP_${symbol}_${last4}`;

  if (!confirmToken || confirmToken !== expected) {
    return res.status(400).json({
      ok: false,
      statusCode: 400,
      message: `Token konfirmasi tidak cocok. Format: "STOP_${symbol}_XXXX"`,
      code: 'INVALID_CONFIRM_TOKEN',
    });
  }

  next();
}

module.exports = { strategyChangeLimiter, emergencyStopConfirmGuard };
