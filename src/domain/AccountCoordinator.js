/**
 * ─────────────────────────────────────────────────────────────────────────────
 * AccountCoordinator.js — Koordinasi margin LINTAS-BOT untuk satu akun (per user)
 *
 * Masalah yang diselesaikan (audit #5): beberapa bot (BTC/ETH/SOL) berbagi SATU
 * akun exchange. Tiap BotEngine sebelumnya menghitung ukuran posisi dari balance
 * penuh secara independen → bila beberapa bot membuka hampir bersamaan, total
 * margin bisa melebihi saldo akun → likuidasi.
 *
 * Solusi: satu koordinator per user yang melacak margin yang sudah "dipesan"
 * oleh tiap bot. Sebuah bot HARUS lolos `canOpen()` (anggaran margin + batas
 * jumlah posisi + 1 posisi per simbol) lalu `reserve()` sebelum mengirim order,
 * dan `release()` saat posisi ditutup. Pemeriksaan dijalankan terserialisasi
 * (in-process, single Node) sehingga reservasi bot A sudah terlihat oleh bot B
 * walau exchange belum memperbarui `available`.
 *
 * Margin awal posisi = notional / leverage. Invarian yang dijaga:
 *   Σ margin semua posisi terbuka ≤ accountEquity × maxAccountUtilization
 * ─────────────────────────────────────────────────────────────────────────────
 */

class AccountCoordinator {
  /**
   * @param {Object}  opts
   * @param {string}  opts.userId
   * @param {number}  [opts.maxAccountUtilization=0.8] — fraksi equity yang boleh
   *                  dipakai sebagai TOTAL margin lintas-bot (buffer anti-likuidasi).
   * @param {number}  [opts.maxConcurrentPositions=0] — batas jumlah posisi terbuka
   *                  serentak lintas-bot (0 = tanpa batas; anggaran margin yang membatasi).
   */
  constructor({ userId, maxAccountUtilization = 0.8, maxConcurrentPositions = 0 } = {}) {
    this.userId = userId;
    this.maxAccountUtilization = maxAccountUtilization;
    this.maxConcurrentPositions = maxConcurrentPositions;
    this.maxPerSymbol = 1;

    this.accountEquity = 0; // di-update oleh bot saat membaca balance
    this.reservations  = new Map(); // botKey -> { symbol, margin, ts }
  }

  /** Update snapshot equity akun (semua bot user ini berbagi akun yang sama). */
  setAccountEquity(equity) {
    if (Number.isFinite(equity) && equity > 0) this.accountEquity = equity;
  }

  /** Total margin yang sedang dipesan, opsional kecualikan satu botKey. */
  committedMargin(exceptBotKey = null) {
    let sum = 0;
    for (const [key, r] of this.reservations) {
      if (key === exceptBotKey) continue;
      sum += r.margin || 0;
    }
    return sum;
  }

  openCount(exceptBotKey = null) {
    if (!exceptBotKey) return this.reservations.size;
    return this.reservations.size - (this.reservations.has(exceptBotKey) ? 1 : 0);
  }

  /** Apakah simbol ini sudah dipegang reservasi lain (selain botKey). */
  hasSymbol(symbol, exceptBotKey = null) {
    for (const [key, r] of this.reservations) {
      if (key === exceptBotKey) continue;
      if (r.symbol === symbol) return true;
    }
    return false;
  }

  /**
   * Boleh buka posisi baru?
   * @param {Object} p
   * @param {string} p.botKey         — identitas bot (mis. "userId:SYMBOL")
   * @param {string} p.symbol
   * @param {number} p.requiredMargin — margin awal = notional / leverage (USDT)
   * @returns {{ ok: boolean, reason?: string, budget?: number, committed?: number }}
   */
  canOpen({ botKey, symbol, requiredMargin }) {
    // 1) Batas jumlah posisi serentak (jika diaktifkan)
    if (this.maxConcurrentPositions > 0 &&
        this.openCount(botKey) >= this.maxConcurrentPositions) {
      return { ok: false, reason: `Batas ${this.maxConcurrentPositions} posisi serentak (akun bersama) tercapai` };
    }

    // 2) Maks 1 posisi per simbol di seluruh akun
    if (this.hasSymbol(symbol, botKey)) {
      return { ok: false, reason: `Sudah ada posisi ${symbol} di akun ini` };
    }

    // 3) Anggaran margin — hanya bila equity diketahui
    if (this.accountEquity > 0) {
      if (!Number.isFinite(requiredMargin) || requiredMargin <= 0) {
        return { ok: false, reason: `Margin yang dibutuhkan tidak valid (${requiredMargin})` };
      }
      const budget    = this.accountEquity * this.maxAccountUtilization;
      const committed = this.committedMargin(botKey);
      if (committed + requiredMargin > budget) {
        return {
          ok: false,
          reason: `Margin akun tidak cukup: butuh $${requiredMargin.toFixed(2)}, ` +
                  `terpakai $${committed.toFixed(2)} / anggaran $${budget.toFixed(2)} ` +
                  `(${(this.maxAccountUtilization * 100).toFixed(0)}% dari equity $${this.accountEquity.toFixed(2)})`,
          budget, committed,
        };
      }
      return { ok: true, budget, committed };
    }

    // Equity belum diketahui → lewati gate anggaran (bot sudah punya guard balance sendiri)
    return { ok: true };
  }

  /** Catat reservasi margin untuk satu bot. Idempotent per botKey. */
  reserve(botKey, { symbol, margin }) {
    this.reservations.set(botKey, { symbol, margin: margin || 0, ts: Date.now() });
    return this;
  }

  /** Lepas reservasi saat posisi bot ditutup / bot berhenti. */
  release(botKey) {
    this.reservations.delete(botKey);
    return this;
  }

  /** Ringkasan untuk debugging / UI. */
  snapshot() {
    return {
      userId: this.userId,
      accountEquity: this.accountEquity,
      maxAccountUtilization: this.maxAccountUtilization,
      budget: this.accountEquity * this.maxAccountUtilization,
      committedMargin: this.committedMargin(),
      openCount: this.openCount(),
      maxConcurrentPositions: this.maxConcurrentPositions,
      reservations: Array.from(this.reservations.entries()).map(([botKey, r]) => ({
        botKey, symbol: r.symbol, margin: r.margin,
      })),
    };
  }
}

module.exports = AccountCoordinator;
