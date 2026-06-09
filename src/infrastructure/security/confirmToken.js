/**
 * ─────────────────────────────────────────────────────────────────────────────
 * confirmToken.js — Token konfirmasi HMAC untuk operasi destruktif (TASK 3.5)
 *
 * ROOT CAUSE (Security): token lama `STOP_<symbol>_<userId_last4>` PREDICTABLE —
 * penyerang yang tahu symbol + 4 digit userId bisa memalsukannya (CSRF/replay).
 *
 * Token baru = HMAC-SHA256(secret, "<symbol>:<userId>:<ts>") yang:
 *   - tidak bisa ditebak tanpa CONFIRM_SECRET (server-side),
 *   - self-describing (`<ts>.<sig>`) sehingga server bisa cek kedaluwarsa,
 *   - berumur pendek (default 5 menit) → window serangan kecil,
 *   - diverifikasi dengan perbandingan constant-time (anti timing attack).
 *
 * Alur: client GET token via endpoint terproteksi (issueConfirmToken), lalu
 * mengirimnya kembali pada force-close. Server memverifikasi (verifyConfirmToken).
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const crypto = require("crypto");

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000; // 5 menit
const CLOCK_SKEW_MS = 60 * 1000;          // toleransi 1 menit untuk ts "masa depan"

/**
 * Secret untuk HMAC. Prioritas: CONFIRM_SECRET > JWT_SECRET > default dev.
 * Di produksi WAJIB set CONFIRM_SECRET (atau minimal JWT_SECRET).
 */
function getSecret() {
  return process.env.CONFIRM_SECRET || process.env.JWT_SECRET || "quantara-dev-confirm-secret-change-me";
}

function sign(payload) {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("hex").slice(0, 32);
}

/**
 * Terbitkan token konfirmasi untuk (symbol, userId).
 * @param {{symbol: string, userId: string|number, ts?: number}} p
 * @returns {string} token format "<ts>.<sig>"
 */
function issueConfirmToken({ symbol, userId, ts = Date.now() }) {
  const sig = sign(`${symbol}:${userId}:${ts}`);
  return `${ts}.${sig}`;
}

/**
 * Verifikasi token konfirmasi.
 * @param {string} token
 * @param {{symbol: string, userId: string|number, maxAgeMs?: number, now?: number}} p
 * @returns {boolean}
 */
function verifyConfirmToken(token, { symbol, userId, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() }) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;

  const [tsStr, sig] = token.split(".");
  const ts = parseInt(tsStr, 10);
  if (!Number.isFinite(ts) || !sig) return false;

  // Kedaluwarsa atau timestamp dari masa depan (di luar toleransi skew) → tolak.
  if (now - ts > maxAgeMs) return false;
  if (ts - now > CLOCK_SKEW_MS) return false;

  const expected = sign(`${symbol}:${userId}:${ts}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { issueConfirmToken, verifyConfirmToken, DEFAULT_MAX_AGE_MS };
