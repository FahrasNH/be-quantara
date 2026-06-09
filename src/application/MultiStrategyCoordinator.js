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

    /** @type {Map<string, object>} strategyKey -> engine */
    this.engines = new Map();
    this.running = false;
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

  // ───────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ───────────────────────────────────────────────────────────────────────────

  /** Spawn satu engine per strategi (capital equal-weight) lalu start semuanya. */
  async start() {
    if (this.running) throw new Error("MultiStrategyCoordinator sudah berjalan");

    // Pesan margin sebagai satu grup (anti over-allocate lintas-strategi).
    if (this.accountCoordinator?.reserveGroup) {
      this.accountCoordinator.reserveGroup(
        this.userId, this.symbol, this.strategies, this.totalCapital
      );
    }

    for (let i = 0; i < this.strategies.length; i++) {
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
      });

      // Relay event engine → konsumen koordinator (WS streaming, dll.)
      if (typeof engine.on === "function") {
        engine.on("log", (e) => this.emit("log", e));
        engine.on("status", () => this.emit("status", this.getState()));
      }

      this.engines.set(strategyKey, engine);
      await engine.start();
      this._log("info", `Engine [${strategyKey}] start — capital $${this.capitalPerStrategy.toFixed(2)}`);
    }

    this.running = true;
    this._log("info", `${this.strategies.length} strategi aktif: ${this.strategies.join(", ")}`);

    if (this.pollIntervalMs > 0) {
      this._poll = setInterval(() => {
        try { this.evaluate(); } catch (e) { this._log("error", `evaluate gagal: ${e.message}`); }
      }, this.pollIntervalMs);
    }

    this.emit("status", this.getState());
  }

  /** Stop semua engine dan lepas reservasi margin grup. */
  async stop() {
    if (this._poll) { clearInterval(this._poll); this._poll = null; }

    for (const [strategyKey, engine] of this.engines) {
      try {
        await engine.stop();
        this._log("info", `Engine [${strategyKey}] dihentikan`);
      } catch (e) {
        this._log("error", `Gagal stop engine [${strategyKey}]: ${e.message}`);
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
      catch (e) { this._log("error", `reconcile stop [${strategyKey}] gagal: ${e.message}`); }
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

  // ───────────────────────────────────────────────────────────────────────────
  // STATE
  // ───────────────────────────────────────────────────────────────────────────

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
      running: this.running,
      symbol: this.symbol,
      dryRun: this.dryRun,
      multiStrategy: true,
      strategyGroup: this.strategies,
      capitalPerStrategy: this.capitalPerStrategy,
      capital: this.totalCapital,
      conflictMode: this.conflictMode,
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
