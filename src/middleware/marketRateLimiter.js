/**
 * marketRateLimiter.js (src/middleware/marketRateLimiter.js)
 *
 * Task C AC-7: GET /market/symbols hits a live exchange API (CCXT loadMarkets)
 * on cache-miss, so it must be rate-limited per user to prevent exchange API
 * abuse. Max 10 req/min per user.
 *
 * Keyed per-user (req.userId, set by authMiddleware) with an IPv6-safe IP
 * fallback — same pattern as strategyRateLimiter.js.
 */

"use strict";

const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

const symbolsRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.userId ? `symbols:${req.userId}` : `symbols:ip:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).json({
      ok: false,
      statusCode: 429,
      message: "Terlalu banyak permintaan daftar simbol. Coba lagi dalam 1 menit.",
      code: "SYMBOLS_RATE_LIMITED",
    });
  },
  skip: () => process.env.NODE_ENV !== "production",
});

module.exports = { symbolsRateLimiter };
