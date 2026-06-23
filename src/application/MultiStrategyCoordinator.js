/**
 * ─────────────────────────────────────────────────────────────────────────────
 * MultiStrategyCoordinator.js — Auto Multi-Strategy Execution per Coin
 *
 * Menjalankan SEMUA strategi tier user secara serentak pada SATU koin. User cukup
 * memilih Tier + Koin; koordinator ini yang:
 *   1. men-spawn N engine (satu per strategi) dengan capital equal-weight,
 *   2. mengumpulkan signal dari tiap engine (collectSignals),
 *   3. menyelesaikan konflik arah lintas-strategi (resolveConflicts — reuse
 *      domain/SignalConflictResolver agar logika tidak terduplikasi),
 *   4. memesan/melepas margin sebagai satu GRUP di AccountCoordinator
 *      (anti over-allocate), dan
 *   5. melaporkan state teragregasi (getState) dengan permukaan yang kompatibel
 *      dengan BotEngine sehingga server cukup mengganti instance-nya.
 *
 * CLEAN ARCHITECTURE: ketergantungan di-INJECT (engineFactory, accountCoordinator,
 * logger), tidak di-`require` langsung. Ini membuat kelas mudah di-unit-test dengan
 * engine palsu dan tidak terikat ke implementasi engine tertentu.
 *
 * Kontrak engine minimum yang dibutuhkan koordinator:
 *   - strategyKey: string
 *   - async start(): Promise<void>
 *   - async stop(): Promise<void>
 *   - getState(): { running, openPositions[], trades[], lastSignal, ... }
 *   - (opsional) getPendingSignal(): { direction, slPrice?, tpPrice?,
 *       slMultiplier?, tpMultiplier? } | null  — bila tidak ada, dipakai
 *       getState().lastSignal sebagai fallback.
 *   - (opsional) applyConflictDecision(allowed: boolean): void — hook untuk
 *       Sprint 2: koordinator memberi tahu engine boleh/tidak entry tick ini.
 *   - (opsional) EventEmitter 'log'/'status' — di-relay ke konsumen koordinator.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const EventEmitter = require("events");
const { resolveConflicts } = require("../domain/SignalConflictResolver");

class MultiStrategyCoordinator extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string}   opts.userId
   * @param {string}   opts.symbol
   * @param {string[]} opts.strategies      — strategi tier yang dijalankan serentak
   * @param {number}   opts.totalCapital    — capital total untuk koin ini
   * @param {Function} opts.engineFactory   — (strategyKey, config) => Engine
   * @param {Object}   [opts.accountCoordinator] — AccountCoordinator (margin grup)
   * @param {boolean}  [opts.dryRun=true]
   * @param {("skip"|"majority")} [opts.conflictMode="skip"]
   * @param {number}   [opts.pollIntervalMs=0] — 0 = tidak auto-poll (driven manual/tes)
   * @param {Object}   [opts.engineConfig={}]  — config tambahan diteruskan ke tiap engine
   */
  constructor({
    userId,
    symbol,
    strategies,
    totalCapital,
    engineFactory,
    accountCoordinator = null,
    dryRun = true,
    conflictMode = "skip",
    pollIntervalMs = 0,
    engineConfig = {},
    maxPositionsPerCoin = 2,
    db = null,
  }) {
    super();

    if (typeof engineFactory !== "function") {
      throw new Error("MultiStrategyCoordinator: engineFactory (function) wajib di-inject");
    }
    const list = (Array.isArray(strategies) ? strategies : []).filter(Boolean);
    if (list.length === 0) {
      throw new Error("MultiStrategyCoordinator: minimal satu strategi diperlukan");
    }

    this.userId = userId;
    this.symbol = symbol;
    this.strategies = list;
    this.totalCapital = Number(totalCapital) || 0;
    this.capitalPerStrategy = this.totalCapital / list.length;
    this.engineFactory = engineFactory;
    this.accountCoordinator = accountCoordinator;
    this.dryRun = dryRun !== false;
    this.conflictMode = conflictMode === "majority" ? "majority" : "skip";
    this.pollIntervalMs = Number(pollIntervalMs) || 0;
    this.engineConfig = engineConfig;
    // Cap jumlah posisi terbuka per koin lintas-strategi (anti penumpukan satu arah).
    this.maxPositionsPerCoin = Math.max(1, Number(maxPositionsPerCoin) || 2);
    // DB di-inject (DI) → canEnter pakai DB sebagai sumber kebenaran tunggal.
    // Null saat unit test → fallback ke state engine live.
    this._db = db;

    /** @type {Map<string, object>} strategyKey -> engine */
    this.engines = new Map();
    this.running  = false;
    this.starting = false; // set synchronously in start() before first await
    this._stopRequested = false; // di-set stop() agar start() yang sedang warm-up bisa batal
    this.lastDecision = null; // hasil resolveConflicts terakhir (untuk getState/UI)
    this._poll = null;

    // Permukaan kompatibel-BotEngine agar server bisa memperlakukan koordinator
    // ini sama seperti satu BotEngine (mergeBotWithLiveState, dst.).
    this.config = {
      userId,
      symbol,
      dryRun: this.dryRun,
      strategyGroup: this.strategies,
      capitalPerStrategy: this.capitalPerStrategy,
      botId: engineConfig.botId ?? null,
    };
  }

  /** Logger terpadu: emit event + (opsional) console. */
  _log(level, message) {
    const entry = { time: new Date().toISOString(), level, msg: `[multi:${this.symbol}] ${message}` };
    this.emit("log", entry);
  }

  /** ADAPTIVE_FUSION → "Adaptive Fusion" */
  _titleCase(key) {
    return String(key).toLowerCase().replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }

  /** ADAPTIVE_FUSION → "AF" (initials) — keeps the startup banner on one line. */
  _abbrev(key) {
    const map = { ADAPTIVE_FUSION: "AF", TREND_MOMENTUM: "TM", MEAN_REVERSION: "MR", BREAKOUT_RETEST: "BR" };
    return map[key] || this._titleCase(key).split(" ").map(w => w[0]).join("").toUpperCase();
  }

  /**
   * Emit SATU banner startup terpadu untuk seluruh grup multi-strategi.
   *
   * Masalah yang diperbaiki: tiap engine sebelumnya emit banner sendiri →
   * tergabung jadi blob ambigu di panel log ("cek 60s itu strategi mana?").
   * Solusi: shared config (Exchange/Mode/Symbol/Modal) ditulis SEKALI, lalu
   * tabel per-strategi yang menampilkan interval/risk/RR/cek-tiap secara
   * eksplisit per baris — tiap angka jelas miliknya strategi mana.
   *
   * Di-emit lewat engine LEADER (BotEngine) supaya broadcast WS otomatis
   * menempelkan `symbol` (koordinator sendiri tidak melalui emit yang di-patch).
   */
  _emitUnifiedBanner() {
    const leader = this.engines.get(this.strategies[0]);
    if (!leader || typeof leader._logBlock !== "function") return;
    const c0 = leader.config;
    const coin = String(this.symbol).replace(/USDT$/i, "");
    const modeStr = this.dryRun ? "DRY RUN (simulasi)" : "LIVE TRADING";

    // Banner startup ringkas — hanya konteks penting. Tabel per-strategi (interval/
    // risk/RR/cek-tiap) DIHAPUS: kurang berguna saat startup & bikin log panjang.
    // Detail risk/RR per strategi tetap tersedia di config; yang relevan bagi user
    // saat ada posisi (strategi mana, holding time, Net P&L) ditampilkan di panel
    // detail koin, bukan diulang tiap startup.
    // Strategi disingkat ke inisial (AF · TM · MR · BR) agar muat satu baris —
    // nama lengkap ditampilkan di log entry tiap kali strategi memfire posisi.
    const names = this.strategies.map(k => this._abbrev(k)).join(" · ");
    const lines = [];
    lines.push(`══ QUANTARA BOT — ${coin}/USDT (multi-strategi) ══`);
    lines.push(`Exchange   : ${c0.exchangeLabel}`);
    lines.push(`Mode       : ${modeStr}`);
    lines.push(`Symbol     : ${this.symbol}`);
    lines.push(`Modal      : $${this.totalCapital.toFixed(2)} total · $${this.capitalPerStrategy.toFixed(2)} / strategi`);
    lines.push(`Strategi   : ${names}`);
    leader._logBlock("info", lines);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ───────────────────────────────────────────────────────────────────────────

  /** Spawn satu engine per strategi (capital equal-weight) lalu start semuanya. */
  async start() {
    if (this.running)  throw new Error("MultiStrategyCoordinator sudah berjalan");
    if (this.starting) throw new Error("MultiStrategyCoordinator sedang dalam proses start");
    this.starting = true; // SYNC — set before first await; prevents concurrent start race
    this._stopRequested = false; // reset di tiap start baru

    try {
    // Pesan margin sebagai satu grup (anti over-allocate lintas-strategi).
    if (this.accountCoordinator?.reserveGroup) {
      this.accountCoordinator.reserveGroup(
        this.userId, this.symbol, this.strategies, this.totalCapital
      );
    }

    // ── Pre-flight: 1 balance + leverage + marginMode call shared across all engines ──
    // Replaces N×3 redundant exchange calls (N = strategy count) with 1×3 calls.
    // Result is passed to each engine via config so _startup() skips those calls.
    let sharedBalance = null;
    let sharedLeverageSet = false;
    const { exchangeType, apiKey, apiSecret, passphrase } = this.engineConfig;
    if (apiKey && apiSecret) {
      try {
        const { createExchangeClient } = require("../infrastructure/exchange");
        const client = createExchangeClient(exchangeType, { apiKey, apiSecret, passphrase });
        sharedBalance = await client.getBalance("USDT");
        if (!this.dryRun) {
          const leverage = this.engineConfig.leverage || 2;
          await client.setLeverage(this.symbol, leverage);
          await client.setMarginMode(this.symbol, "crossed");
          sharedLeverageSet = true;
        }
        this._log("info", `Pre-flight ✓ balance $${(sharedBalance.equity || sharedBalance.available || 0).toFixed(2)} USDT${sharedLeverageSet ? ` | leverage ${this.engineConfig.leverage || 2}x diset` : ""}`);
      } catch (err) {
        this._log("warn", `Pre-flight exchange call gagal: ${err.message} — tiap engine retry sendiri`);
      }
    }

    for (let i = 0; i < this.strategies.length; i++) {
      // stop() dipanggil selama warm-up → hentikan spawn engine berikutnya.
      // Tanpa ini, loop terus membuat & start engine SETELAH stop() membersihkan
      // this.engines → engine yatim yang tetap ticking (zombie) walau bot di-stop.
      if (this._stopRequested) {
        this._log("warn", "Spawn engine dibatalkan — stop diminta saat warm-up");
        break;
      }
      const strategyKey = this.strategies[i];
      const engine = this.engineFactory(strategyKey, {
        ...this.engineConfig,
        userId: this.userId,
        symbol: this.symbol,
        strategyKey,
        capital: this.capitalPerStrategy,
        dryRun: this.dryRun,
        // botKey unik per strategi → AccountCoordinator melacak per-strategi,
        // groupKey menyatukan mereka pada satu koin.
        botKey: `${this.userId}:${this.symbol}#${strategyKey}`,
        groupKey: this.accountCoordinator?.groupKeyFor?.(this.userId, this.symbol)
          ?? `${this.userId}:${this.symbol}`,
        // Engine pertama = group leader: bertanggung jawab meng-klaim legacy trades
        // (yang tidak punya atribusi strategi) saat orphan recovery di _startup().
        isGroupLeader: i === 0,
        // Total capital grup — untuk log yang lebih informatif di _startup
        groupTotalCapital: this.totalCapital,
        // Referensi balik ke koordinator grup → engine memanggil canEnter() sebagai
        // gate sebelum membuka posisi (cap per-koin + proteksi hedge lintas-strategi).
        groupCoordinator: this,
        // Pre-fetched balance + leverage flag so engines skip redundant exchange calls
        sharedBalance,
        sharedLeverageSet,
        // Jangan emit banner startup per-engine — koordinator emit SATU banner
        // terpadu untuk seluruh grup (config tiap strategi jelas atribusinya).
        quietStartup: true,
      });

      // Relay event engine → konsumen koordinator (WS streaming, dll.)
      if (typeof engine.on === "function") {
        engine.on("log", (e) => this.emit("log", e));
        engine.on("status", () => this.emit("status", this.getState()));
      }

      this.engines.set(strategyKey, engine);
      await engine.start();
      this._log("info", `Engine ${this._titleCase(strategyKey)} start — capital $${this.capitalPerStrategy.toFixed(2)}`);
    }

    // stop() mendarat selama warm-up → batalkan: hentikan engine yang terlanjur start,
    // lepas margin grup, JANGAN set running=true (cegah koordinator zombie).
    if (this._stopRequested) {
      for (const [k, eng] of this.engines) {
        try { await eng.stop(); } catch (e) { this._log("error", `Cleanup stop [${k}] gagal: ${e.message}`); }
      }
      this.engines.clear();
      if (this.accountCoordinator?.releaseGroup) {
        this.accountCoordinator.releaseGroup(this.userId, this.symbol);
      }
      this.running = false;
      this._log("warn", "Start dibatalkan — stop diminta saat warm-up; koordinator tidak diaktifkan");
      this.emit("status", this.getState());
      return;
    }

    this.running = true;
    this._log("info", `${this.strategies.length} strategi aktif: ${this.strategies.join(", ")}`);
    // Emit SATU banner terpadu (shared config sekali + tabel per-strategi) lewat
    // engine leader, agar tampil sebagai 1 kartu yang jelas di panel log.
    this._emitUnifiedBanner();

    if (this.pollIntervalMs > 0) {
      this._poll = setInterval(() => {
        try { this.evaluate(); } catch (e) { this._log("error", `evaluate gagal: ${e.message}`); }
      }, this.pollIntervalMs);
    }

    this.emit("status", this.getState());

    } finally {
      this.starting = false;
    }
  }

  /** Stop semua engine dan lepas reservasi margin grup. */
  async stop() {
    // Sinyalkan ke start() yang mungkin masih warm-up agar membatalkan spawn engine
    // berikutnya (anti-zombie). Di-set SYNC sebelum await apa pun.
    this._stopRequested = true;
    if (this._poll) { clearInterval(this._poll); this._poll = null; }

    for (const [strategyKey, engine] of this.engines) {
      try {
        await engine.stop();
        this._log("info", `Engine ${this._titleCase(strategyKey)} dihentikan`);
      } catch (e) {
        this._log("error", `Gagal stop engine ${this._titleCase(strategyKey)}: ${e.message}`);
      }
    }
    this.engines.clear();

    if (this.accountCoordinator?.releaseGroup) {
      this.accountCoordinator.releaseGroup(this.userId, this.symbol);
    }

    this.running = false;
    this._log("warn", "Multi-strategy coordinator dihentikan");
    this.emit("status", this.getState());
  }

  /**
   * Rekonsiliasi strategi terhadap daftar yang diizinkan tier (TC-007).
   * Dipanggil mis. setelah tier user downgrade — engine untuk strategi yang tidak
   * lagi diizinkan dihentikan & dilepas, sisanya tetap berjalan.
   * @param {string[]} allowedStrategies
   * @returns {Promise<string[]>} daftar strategyKey yang dihentikan
   */
  async reconcileStrategies(allowedStrategies) {
    const allowed = new Set(Array.isArray(allowedStrategies) ? allowedStrategies : []);
    const stopped = [];
    for (const [strategyKey, engine] of this.engines) {
      if (allowed.has(strategyKey)) continue;
      try { await engine.stop(); }
      catch (e) { this._log("error", `reconcile stop ${this._titleCase(strategyKey)} gagal: ${e.message}`); }
      this.engines.delete(strategyKey);
      stopped.push(strategyKey);
    }
    this.strategies = this.strategies.filter((s) => allowed.has(s));
    if (stopped.length) {
      this._log("warn", `Strategi dihentikan (tidak lagi diizinkan tier): ${stopped.join(", ")}`);
      this.emit("status", this.getState());
    }
    return stopped;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SIGNAL ORCHESTRATION
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Kumpulkan signal terbaru dari tiap engine.
   * @returns {Array<{strategyKey, direction, slPrice?, tpPrice?, slMultiplier?, tpMultiplier?}>}
   */
  collectSignals() {
    const signals = [];
    for (const [strategyKey, engine] of this.engines) {
      let raw = null;
      if (typeof engine.getPendingSignal === "function") {
        raw = engine.getPendingSignal();
      } else if (typeof engine.getState === "function") {
        const st = engine.getState();
        raw = st && st.lastSignal ? { direction: st.lastSignal } : null;
      }
      signals.push({
        strategyKey,
        direction: raw?.direction ?? null,
        slPrice: raw?.slPrice ?? null,
        tpPrice: raw?.tpPrice ?? null,
        slMultiplier: raw?.slMultiplier ?? null,
        tpMultiplier: raw?.tpMultiplier ?? null,
      });
    }
    return signals;
  }

  /**
   * Selesaikan konflik arah lintas-strategi (delegasi ke domain resolver).
   * @param {Array} signals
   */
  resolveConflicts(signals) {
    return resolveConflicts(signals, { conflictMode: this.conflictMode });
  }

  /**
   * Satu siklus: kumpulkan signal → resolusi konflik → beri keputusan ke tiap
   * engine (jika engine mendukung applyConflictDecision). Tanpa side-effect bila
   * engine tidak mengimplementasikan hook tersebut (degradasi mulus).
   * @returns {ConflictResolution}
   */
  evaluate() {
    const signals = this.collectSignals();
    const decision = this.resolveConflicts(signals);
    this.lastDecision = decision;

    const allowedKeys = new Set(decision.execute.map((s) => s.strategyKey));
    for (const [strategyKey, engine] of this.engines) {
      if (typeof engine.applyConflictDecision === "function") {
        engine.applyConflictDecision(allowedKeys.has(strategyKey));
      }
    }

    if (decision.conflict) {
      this._log("warn", `Conflict resolved: ${decision.reason}`);
    }
    return decision;
  }

  /**
   * Kumpulkan posisi terbuka koin ini sebagai SUMBER KEBENARAN TUNGGAL.
   * Prioritas DB (close_time IS NULL) bila tersedia — agar gate menghormati SEMUA
   * posisi terbuka termasuk orphan yang belum ter-claim engine live (mencegah
   * penumpukan posisi baru di atas orphan). Fallback ke state engine live bila
   * DB tidak tersedia (mis. unit test dengan engine palsu).
   * @returns {Promise<Array<{side:string}>>}
   */
  async _collectOpenPositions() {
    // 1. Coba DB (otoritatif)
    if (this._db && typeof this._db.getOpenPositionsForGate === "function") {
      try {
        const rows = await this._db.getOpenPositionsForGate({
          symbol: this.symbol, userId: this.userId, dryRun: this.dryRun,
        });
        if (Array.isArray(rows)) return rows.map((r) => ({ side: r.side }));
      } catch { /* fallback ke state engine */ }
    }
    // 2. Fallback: state engine live
    const out = [];
    for (const [, engine] of this.engines) {
      for (const p of engine?.state?.openPositions || []) out.push({ side: p.side });
    }
    return out;
  }

  /**
   * GATE entry lintas-strategi (dipanggil engine SEBELUM membuka posisi).
   * ASYNC — menghitung exposure dari DB (sumber kebenaran tunggal). Aturan:
   *   1. Proteksi hedge: tolak jika sudah ada posisi arah BERLAWANAN di koin ini.
   *   2. Cap konsentrasi: tolak jika posisi terbuka >= maxPositionsPerCoin.
   *
   * @param {string} strategyKey
   * @param {"LONG"|"SHORT"} direction
   * @returns {Promise<{ allowed: boolean, reason: string, open: number, cap: number }>}
   */
  async canEnter(strategyKey, direction) {
    const dir = String(direction || "").toUpperCase();
    const positions = await this._collectOpenPositions();

    let totalOpen = 0, hasOpposite = false;
    for (const p of positions) {
      totalOpen++;
      const pSide = String(p.side || "").toUpperCase();
      if (pSide && dir && pSide !== dir) hasOpposite = true;
    }

    if (hasOpposite) {
      return { allowed: false, open: totalOpen, cap: this.maxPositionsPerCoin,
        reason: `Hedge guard: sudah ada posisi arah berlawanan di ${this.symbol}` };
    }
    if (totalOpen >= this.maxPositionsPerCoin) {
      return { allowed: false, open: totalOpen, cap: this.maxPositionsPerCoin,
        reason: `Cap per-koin tercapai (${totalOpen}/${this.maxPositionsPerCoin}) di ${this.symbol}` };
    }
    return { allowed: true, open: totalOpen, cap: this.maxPositionsPerCoin, reason: "OK" };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STATE
  // ───────────────────────────────────────────────────────────────────────────

  // Session ID dari SEMUA engine strategi (tiap strategi membuka sesinya sendiri).
  // history.js memakai ini untuk menandai sesi "ACTIVE" — tanpa ini, sesi
  // multi-strategy tak pernah cocok (coordinator tak punya sessionId tunggal) →
  // label ACTIVE tak muncul & sesi yang masih jalan ditandai closed.
  getSessionIds() {
    const ids = [];
    for (const [, engine] of this.engines) {
      const list = typeof engine?.getSessionIds === "function"
        ? engine.getSessionIds()
        : (engine?.sessionId ? [engine.sessionId] : []);
      for (const id of list) if (id) ids.push(id);
    }
    return ids;
  }

  /**
   * State teragregasi lintas-engine. Bentuknya kompatibel dengan BotEngine.getState()
   * (running, symbol, openPositions[], trades[], totalPnL) agar server tidak perlu
   * logika khusus, sambil menambah rincian per-strategi (engines, signals).
   */
  getState() {
    const engines = [];
    const openPositions = [];
    const trades = [];
    let unrealizedPnL = 0;

    for (const [strategyKey, engine] of this.engines) {
      const st = typeof engine.getState === "function" ? engine.getState() : {};
      engines.push({
        strategyKey,
        running: !!st.running,
        capital: st.capital ?? this.capitalPerStrategy,
        openTradeCount: (st.openPositions || []).length,
        closedTrades: (st.trades || []).length,
        lastSignal: st.lastSignal ?? null,
      });
      // Posisi tiap engine sudah di-enrich dengan unrealizedPL (lihat BotEngine.getState).
      for (const p of st.openPositions || []) {
        openPositions.push({ ...p, strategyKey });
        unrealizedPnL += p.unrealizedPL || 0;
      }
      for (const tr of st.trades || []) trades.push({ ...tr, strategyKey });
    }

    const totalPnL  = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const totalFees = trades.reduce((s, t) => s + (t.fee || 0) + (t.funding || 0), 0);
    const netPnL    = totalPnL - totalFees;
    const wins      = trades.filter((t) => (t.pnl || 0) > 0).length;
    const winRate   = trades.length > 0 ? Math.round((wins / trades.length) * 100) : 0;

    return {
      running:  this.running,
      starting: this.starting,
      symbol: this.symbol,
      dryRun: this.dryRun,
      multiStrategy: true,
      strategyGroup: this.strategies,
      capitalPerStrategy: this.capitalPerStrategy,
      capital: this.totalCapital,
      conflictMode: this.conflictMode,
      // Leverage efektif per-symbol (min lintas-strategi, di-set oleh app.js). Di-expose
      // agar FE menampilkan angka SEBENARNYA, bukan fallback hardcoded 2×.
      leverage: this.engineConfig?.leverage ?? null,
      engines,
      signals: this.lastDecision,
      openPositions,
      trades: trades.slice(-50),
      openTradeCount: openPositions.length,
      closedTrades: trades.length,
      totalTrades: openPositions.length + trades.length,
      totalPnL,
      totalFees,
      netPnL,
      // PnL mengambang agregat lintas-strategi — agar card "PnL net" menampilkan
      // posisi terbuka, bukan selalu +$0.00.
      unrealizedPnL,
      winRate,
    };
  }
}

module.exports = MultiStrategyCoordinator;
