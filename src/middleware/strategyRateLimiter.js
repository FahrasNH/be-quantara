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
const { verifyConfirmToken } = require('../infrastructure/security/confirmToken');

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
  // Skip di non-production (staging/dev), hanya aktif di production
  skip: () => process.env.NODE_ENV !== 'production',
});

/**
 * Middleware: Double-confirm untuk operasi stop + force-close.
 *
 * Client WAJIB mengirim body:
 *   { forceClose: true, confirm: true, confirmToken: "<ts>.<hmac>" }
 *
 * confirmToken di-issue server via GET /bots/:symbol/confirm-token (HMAC, umur 5
 * menit). Stop biasa (tanpa forceClose) TIDAK memerlukan konfirmasi.
 *
 * ROOT CAUSE (FIX-5 / TASK 3.5): token lama predictable (STOP_<symbol>_<last4>)
 * → bisa dipalsukan. Diganti token HMAC server-issued (lihat confirmToken.js).
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

  if (!verifyConfirmToken(confirmToken, { symbol, userId })) {
    return res.status(400).json({
      ok: false,
      statusCode: 400,
      message: 'Token konfirmasi tidak valid atau kedaluwarsa. Ambil token baru via GET /bots/' +
               `${symbol}/confirm-token lalu kirim ulang dalam 5 menit.`,
      code: 'INVALID_CONFIRM_TOKEN',
    });
  }

  next();
}

module.exports = { strategyChangeLimiter, emergencyStopConfirmGuard };
