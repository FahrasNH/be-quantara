/**
 * ─────────────────────────────────────────────────────────────────────────────
 * botOpLock.js — In-flight lock per (userId, symbol) untuk operasi start/stop bot
 * (SEC-002 GAP1).
 *
 * Handler start/stop melakukan check-then-act pada registry bot (botsMap) yang
 * tidak atomik: dua POST /start bersamaan bisa sama-sama lolos cek "belum running"
 * lalu masing-masing membuat instance → sesi duplikat / order ganda di live.
 *
 * Lock ini menolak request kedua dengan 409 BOT_OPERATION_IN_FLIGHT selama
 * operasi pertama untuk key yang sama belum mengirim response. Lock dilepas via
 * event `finish`/`close` pada response sehingga tidak pernah bocor (termasuk
 * saat handler throw → errorHandler tetap mengirim response).
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

function createBotOpLock() {
  const inFlight = new Set();

  return function botOpLock(req, res, next) {
    const key = `${req.userId}:${req.params.symbol}`;
    if (inFlight.has(key)) {
      return res.status(409).json({
        ok: false,
        statusCode: 409,
        code: "BOT_OPERATION_IN_FLIGHT",
        message: "Operasi start/stop untuk bot ini sedang diproses. Coba lagi sebentar.",
      });
    }
    inFlight.add(key);
    const release = () => inFlight.delete(key);
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}

module.exports = { createBotOpLock };
