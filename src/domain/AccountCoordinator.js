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
  constructor({ userId, maxAccountUtilization = 0.8, maxConcurrentPositions = 0, maxAccountDailyLossPct = 0 } = {}) {
    this.userId = userId;
    this.maxAccountUtilization = maxAccountUtilization;
    this.maxConcurrentPositions = maxConcurrentPositions;
    // Cap JUMLAH posisi terbuka serentak LINTAS-AKUN per-tier (fix meter "8/4").
    // SENGAJA dipisah dari maxConcurrentPositions: gate itu menghitung
    // reservations.size (= slot strategi ter-arm, bisa ~100) sehingga TIDAK boleh
    // dipakai sbg cap posisi terbuka. Field ini HANYA untuk dilaporkan ke FE
    // (snapshot/margin-budget); penegakan riil ada di BotEngine yang menghitung
    // posisi terbuka NYATA dari DB. 0 = belum di-set (FE fallback ke default tier).
    this.maxAccountOpenPositions = 0;
    // Batas kerugian harian AGREGAT lintas-bot (#5 residual). 0 = nonaktif.
    // Mencegah skenario tiap bot menembus 4%-nya sendiri → akun rugi 3×4%=12%.
    this.maxAccountDailyLossPct = maxAccountDailyLossPct;
    this.maxPerSymbol = 1;

    this.accountEquity = 0; // di-update oleh bot saat membaca balance (current)
    this.reservations  = new Map(); // botKey -> { symbol, margin, ts }
    // Risk yang dilaporkan tiap bot tiap tick: realized loss hari ini + floating loss.
    this.riskByBot     = new Map(); // botKey -> { realizedLoss, floatingLoss, ts }
    this.STALE_MS      = 25 * 60 * 60 * 1000; // abaikan laporan > 25 jam (bot mati)
  }

  /** Update snapshot equity akun (semua bot user ini berbagi akun yang sama). */
  setAccountEquity(equity) {
    if (Number.isFinite(equity) && equity > 0) this.accountEquity = equity;
  }

  /**
   * Set cap account-wide posisi terbuka serentak per-tier (per-tier account
   * open-position cap). Dipanggil saat bot START / resume setelah tier diketahui.
   * Hanya dipakai untuk pelaporan ke FE — penegakan riil di BotEngine via DB.
   * @param {number} n
   */
  setMaxAccountOpenPositions(n) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) this.maxAccountOpenPositions = v;
    return this;
  }

  /**
   * Laporan risk per bot (dipanggil tiap tick). realizedLoss = total loss hari ini
   * (USDT, ≥0) untuk simbol bot itu; floatingLoss = kerugian mengambang posisi
   * terbuka (USDT, ≥0). Coordinator menjumlahkan lintas-bot untuk gate akun.
   */
  reportRisk(botKey, { realizedLoss = 0, floatingLoss = 0 } = {}) {
    this.riskByBot.set(botKey, {
      realizedLoss: Math.max(0, Number(realizedLoss) || 0),
      floatingLoss: Math.max(0, Number(floatingLoss) || 0),
      ts: Date.now(),
    });
    return this;
  }

  /** Total kerugian HARIAN agregat akun = Σ(realized + floating) bot non-stale. */
  accountDailyLoss() {
    const now = Date.now();
    let realized = 0, floating = 0;
    for (const r of this.riskByBot.values()) {
      if (now - (r.ts || 0) > this.STALE_MS) continue;
      realized += r.realizedLoss || 0;
      floating += r.floatingLoss || 0;
    }
    return { realized, floating, total: realized + floating };
  }

  /**
   * Boleh trading dilihat dari batas kerugian harian AGREGAT akun?
   * Baseline equity awal-hari direkonstruksi = equity sekarang + realized loss.
   * @returns {{ ok: boolean, reason?: string, ddPct?: number }}
   */
  canTradeAccount() {
    if (!(this.maxAccountDailyLossPct > 0)) return { ok: true }; // nonaktif
    if (!(this.accountEquity > 0)) return { ok: true };          // equity belum diketahui → jangan blokir
    const { realized, floating, total } = this.accountDailyLoss();
    // Baseline = equity awal hari ≈ equity kini + yang sudah hilang (realized).
    const base = this.accountEquity + realized;
    const ddPct = total / base;
    if (ddPct >= this.maxAccountDailyLossPct) {
      return {
        ok: false,
        ddPct,
        reason: `Daily loss AKUN ${(ddPct * 100).toFixed(2)}% ` +
                `(realized $${realized.toFixed(2)} + floating $${floating.toFixed(2)}) ` +
                `≥ batas akun ${(this.maxAccountDailyLossPct * 100).toFixed(2)}% — stop entry lintas-bot`,
      };
    }
    return { ok: true, ddPct };
  }

  /**
   * Kunci grup multi-strategi = userId:symbol. Semua strategi yang berjalan
   * serentak pada satu koin berbagi groupKey ini sehingga koordinator bisa
   * (a) mengizinkan >1 posisi pada simbol yang sama selama masih satu grup, dan
   * (b) membatasi TOTAL margin grup terhadap anggaran akun.
   */
  groupKeyFor(userId, symbol) {
    return `${userId}:${symbol}`;
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

  /**
   * Apakah simbol ini sudah dipegang reservasi lain (selain botKey).
   * @param {string} symbol
   * @param {string|null} exceptBotKey   — abaikan reservasi milik botKey ini
   * @param {string|null} exceptGroupKey — abaikan reservasi yang segrup (multi-strategi
   *   pada satu koin boleh punya >1 posisi). null = perilaku legacy (1 posisi/simbol).
   */
  hasSymbol(symbol, exceptBotKey = null, exceptGroupKey = null) {
    for (const [key, r] of this.reservations) {
      if (key === exceptBotKey) continue;
      if (exceptGroupKey && r.groupKey === exceptGroupKey) continue;
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
   * @param {string} [p.groupKey]     — grup multi-strategi (userId:symbol). Bila diisi,
   *   batas 1-posisi-per-simbol diabaikan untuk strategi yang segrup (mereka memang
   *   sengaja membuka beberapa posisi pada koin yang sama). Anggaran margin TOTAL tetap
   *   ditegakkan karena committedMargin menjumlahkan semua reservasi (termasuk segrup).
   * @returns {{ ok: boolean, reason?: string, budget?: number, committed?: number }}
   */
  canOpen({ botKey, symbol, requiredMargin, groupKey = null, direction = null }) {
    // 1) Batas jumlah posisi serentak (jika diaktifkan)
    if (this.maxConcurrentPositions > 0 &&
        this.openCount(botKey) >= this.maxConcurrentPositions) {
      return { ok: false, reason: `Batas ${this.maxConcurrentPositions} posisi serentak (akun bersama) tercapai` };
    }

    // 2) Maks 1 posisi per simbol — kecuali strategi yang segrup (multi-strategi/koin)
    if (this.hasSymbol(symbol, botKey, groupKey)) {
      return { ok: false, reason: `Sudah ada posisi ${symbol} di akun ini` };
    }

    // 2b) Direction lock (AC-05): dalam SATU grup multi-strategi pada simbol yang
    //     sama, dilarang membuka arah berlawanan (LONG + SHORT serentak). Strategi
    //     pertama yang fire mengunci arah; arah berlawanan ditolak sampai flat.
    if (groupKey && direction) {
      const opposite = direction === "LONG" ? "SHORT" : "LONG";
      if (this.hasGroupDirection(groupKey, symbol, opposite, botKey)) {
        return {
          ok: false,
          reason: `Konflik arah pada ${symbol}: grup sudah memegang posisi ${opposite} — ${direction} ditolak (AC-05)`,
        };
      }
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

  /**
   *
   * Berbeda dari canOpen() yang menilai margin entry RIIL (notional/leverage),
   * gate START ini menilai FOOTPRINT MODAL PENUH karena reserveGroup() me-reserve
   * `totalCapital` penuh sebagai margin grup saat bot start. Gate lama memakai
   * `capital/leverage` (mis. /5) sehingga MENGECILKAN footprint 5× → user bisa
   * meng-arm 9 bot @ $50 di akun $105 (utilisasi 536%). Invarian yang dijaga:
   *   Σ(modal semua bot ter-arm) ≤ equity × maxAccountUtilization
   *
   * @param {Object} p
   * @param {number} p.capital            — modal bot yang akan di-start (USDT)
   * @param {string} [p.exceptSymbol]     — abaikan reservasi simbol ini (restart bot
   *                                         yang sama → jangan dihitung dobel)
   * @returns {{ ok, reason?, budget, committed, remaining }}
   */
  canStartBot({ capital, exceptSymbol = null }) {
    // Equity belum diketahui → caller WAJIB fail-closed (jangan arm "buta").
    if (!(this.accountEquity > 0)) {
      return { ok: false, reason: "EQUITY_UNKNOWN", budget: 0, committed: 0, remaining: 0 };
    }
    const budget = this.accountEquity * this.maxAccountUtilization;
    let committed = 0;
    for (const r of this.reservations.values()) {
      if (exceptSymbol && r.symbol === exceptSymbol) continue;
      committed += r.margin || 0;
    }
    const remaining = budget - committed;
    if (!Number.isFinite(capital) || capital <= 0) {
      return { ok: false, reason: "INVALID_CAPITAL", budget, committed, remaining };
    }
    if (committed + capital > budget + 1e-9) {
      return {
        ok: false,
        reason: `Modal $${capital.toFixed(2)} melebihi sisa anggaran: ` +
                `terpakai $${committed.toFixed(2)} / anggaran $${budget.toFixed(2)} ` +
                `(${(this.maxAccountUtilization * 100).toFixed(0)}% dari equity $${this.accountEquity.toFixed(2)}), ` +
                `sisa $${remaining.toFixed(2)}`,
        budget, committed, remaining,
      };
    }
    return { ok: true, budget, committed, remaining };
  }

  /**
   * Apakah grup ini sudah memegang posisi dengan arah tertentu pada simbol tsb?
   * Dipakai untuk direction lock (AC-05).
   */
  hasGroupDirection(groupKey, symbol, direction, exceptBotKey = null) {
    for (const [key, r] of this.reservations) {
      if (key === exceptBotKey) continue;
      if (r.groupKey === groupKey && r.symbol === symbol && r.direction === direction) {
        return true;
      }
    }
    return false;
  }

  /**
   * Catat reservasi margin untuk satu bot. Idempotent per botKey.
   * @param {string} botKey
   * @param {{symbol: string, margin?: number, groupKey?: string, strategyKey?: string, direction?: string}} entry
   */
  reserve(botKey, { symbol, margin, groupKey = null, strategyKey = null, direction = null }) {
    this.reservations.set(botKey, {
      symbol,
      margin: margin || 0,
      groupKey,
      strategyKey,
      direction,
      ts: Date.now(),
    });
    return this;
  }

  /** Lepas reservasi saat posisi bot ditutup / bot berhenti. */
  release(botKey) {
    this.reservations.delete(botKey);
    return this;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MULTI-STRATEGY GROUP (Auto Multi-Strategy Execution per Coin — TASK 1.4)
  //
  // Satu koin menjalankan N strategi serentak. Mereka direservasi sebagai unit
  // grup (groupKey = userId:symbol) sehingga TOTAL margin grup terkontrol terhadap
  // anggaran akun, namun tiap strategi tetap punya reservasi sendiri (botKey
  // = groupKey#strategyKey) agar bisa dibuka/ditutup independen.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Reservasi margin untuk seluruh strategi pada satu koin (equal-weight).
   * Mengganti reservasi grup yang ada untuk simbol ini (idempotent per grup).
   * @param {string}   userId
   * @param {string}   symbol
   * @param {string[]} strategies   — daftar strategi yang jalan serentak
   * @param {number}   totalMargin  — total margin grup (dibagi rata antar strategi)
   * @returns {{ groupKey: string, perStrategyMargin: number, count: number }}
   */
  reserveGroup(userId, symbol, strategies, totalMargin) {
    const groupKey = this.groupKeyFor(userId, symbol);
    const list = Array.isArray(strategies) ? strategies.filter(Boolean) : [];
    const perStrategyMargin = list.length > 0 ? (Number(totalMargin) || 0) / list.length : 0;

    // Bersihkan reservasi grup lama dulu agar tidak menumpuk saat re-reserve.
    this.releaseGroup(userId, symbol);

    for (const strategyKey of list) {
      this.reserve(`${groupKey}#${strategyKey}`, {
        symbol,
        margin: perStrategyMargin,
        groupKey,
        strategyKey,
      });
    }
    return { groupKey, perStrategyMargin, count: list.length };
  }

  /**
   * Lepas SEMUA reservasi milik grup (saat bot multi-strategi pada koin ini stop).
   * @returns {number} jumlah reservasi yang dilepas
   */
  releaseGroup(userId, symbol) {
    const groupKey = this.groupKeyFor(userId, symbol);
    let removed = 0;
    for (const [key, r] of this.reservations) {
      if (r.groupKey === groupKey) {
        this.reservations.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Utilisasi margin satu grup multi-strategi pada satu koin.
   * @returns {{ groupKey, symbol, reserved, count, strategies: string[], budget, utilizationPct }}
   */
  getGroupUtilization(userId, symbol) {
    const groupKey = this.groupKeyFor(userId, symbol);
    let reserved = 0;
    const strategies = [];
    for (const r of this.reservations.values()) {
      if (r.groupKey !== groupKey) continue;
      reserved += r.margin || 0;
      if (r.strategyKey) strategies.push(r.strategyKey);
    }
    const budget = this.accountEquity * this.maxAccountUtilization;
    return {
      groupKey,
      symbol,
      reserved,
      count: strategies.length,
      strategies,
      budget,
      utilizationPct: budget > 0 ? reserved / budget : 0,
    };
  }

  /** Ringkasan untuk debugging / UI. */
  snapshot() {
    return {
      userId: this.userId,
      accountEquity: this.accountEquity,
      maxAccountUtilization: this.maxAccountUtilization,
      maxAccountDailyLossPct: this.maxAccountDailyLossPct,
      accountDailyLoss: this.accountDailyLoss(),
      budget: this.accountEquity * this.maxAccountUtilization,
      committedMargin: this.committedMargin(),
      openCount: this.openCount(),
      maxConcurrentPositions: this.maxConcurrentPositions,
      // Cap account-wide posisi terbuka per-tier (untuk denominator meter FE).
      maxAccountOpenPositions: this.maxAccountOpenPositions,
      reservations: Array.from(this.reservations.entries()).map(([botKey, r]) => ({
        botKey, symbol: r.symbol, margin: r.margin,
      })),
    };
  }
}

module.exports = AccountCoordinator;
