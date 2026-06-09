// ─────────────────────────────────────────────
// src/application/BotEngine.js — Quantara BotEngine
// Class yang bisa di-start/stop oleh server
// Memancarkan event 'log' untuk streaming ke WS
// ─────────────────────────────────────────────

const EventEmitter = require("events");
const { getExchangeInfo } = require("../infrastructure/exchange");
const BitgetClient = require("../infrastructure/exchange/BitgetClient");
const cfg = require("../config/env");
const { calcIndicators, detectSignal, detectHTFTrend, calcPositionSize, detectSidewaysBreakout, getAdaptiveFusionMeta, calcEMA, calcRSI, calcATR, calcSMA } = require("../domain/indicators");
// ── Quantara Patch v1.0 ─────────────────────────────────────────────────────
const { isDuplicate } = require("../domain/signalIdempotency");             // FIX-3
const { meanReversionRegimeFilter } = require("../domain/htfRegimeFilter"); // FIX-4
const { getStrategy } = require("../domain/strategies");
const { buildTradeAttribution } = require("../domain/tradeAttribution"); // TASK 2.3
const db       = require("../infrastructure/db/database");
const { persistBotLog } = require("../infrastructure/db/botLogRepository");
const notifier = require("../infrastructure/notifications/TelegramNotifier");

class BotEngine extends EventEmitter {
  /**
   * @param {object} configOverrides  — override nilai default dari .env
   *   Contoh: new BotEngine({ symbol: "ETHUSDT", capital: 200, apiKey: "...", apiSecret: "..." })
   *   apiKey / apiSecret / passphrase dari DB (Settings page) lebih diprioritaskan daripada .env
   */
  constructor(configOverrides = {}) {
    super();
    const ei   = getExchangeInfo();
    // Strategi dari DB (configOverrides.strategyKey/strategy); getStrategy fallback ke "B"
    const strat = getStrategy(configOverrides.strategyKey || configOverrides.strategy);

    // ── Resolve API credentials: DB key (dari Settings) > env var ──────────────
    // configOverrides.apiKey diisi oleh route start-bot setelah decrypt dari DB.
    const resolvedApiKey     = configOverrides.apiKey     || cfg.BITGET_API_KEY     || "";
    const resolvedApiSecret  = configOverrides.apiSecret  || cfg.BITGET_SECRET_KEY  || "";
    const resolvedPassphrase = configOverrides.passphrase || cfg.BITGET_PASSPHRASE  || "";

    // Hapus dari configOverrides agar tidak bocor ke this.config (keamanan)
    const { apiKey: _k, apiSecret: _s, passphrase: _p, ...safeOverrides } = configOverrides;

    // ── Sumber kebenaran config (prioritas: DB > strategy default) ────────────
    // process.env TIDAK digunakan untuk config bot — semua dari strategy atau DB.
    // Satu-satunya env yang masih relevan adalah server-level config (PORT, DATABASE_URL, dll).
    this.config = {
      // ── Exchange (server config, tidak berubah per user) ──────────────────
      exchange:      ei.id,
      exchangeLabel: ei.label,
      marginCoin:    "USDT",

      // ── Identitas bot (dari DB via configOverrides) ───────────────────────
      // Default aman jika tidak ada override
      symbol:  "BTCUSDT",
      capital: 500,
      dryRun:  true,  // default dry-run; DB override via configOverrides.dryRun

      // ── Indikator teknikal (dari strategy definition) ─────────────────────
      emaFast:       strat.emaFast,
      emaSlow:       strat.emaSlow,
      emaTrend:      strat.emaTrend      || 0,
      rsiPeriod:     strat.rsiPeriod,
      rsiOverbought: strat.rsiOverbought,
      rsiOversold:   strat.rsiOversold,

      // RSI zona entry — batas masuk per strategi (dari PDF)
      rsiLongMin:    strat.rsiLongMin    || 50,
      rsiLongMax:    strat.rsiLongMax    || 70,
      rsiShortMin:   strat.rsiShortMin   || 30,
      rsiShortMax:   strat.rsiShortMax   || 50,

      atrPeriod:     strat.atrPeriod,
      atrMultiplier: strat.atrMultiplier,
      riskReward:    strat.riskReward,
      riskPerTrade:  strat.riskPerTrade,
      maxRiskPerTrade: 0.05,

      // Fee trading per sisi (taker). Bitget USDT-M futures default ~0.06%.
      // Dipakai untuk estimasi fee dry-run/backtest & fallback live.
      feeRate:       strat.feeRate ?? 0.0006,

      // ── Eksekusi & posisi ─────────────────────────────────────────────────
      maxPositions: 1,
      leverage:     strat.leverage,
      useBothSides: false,

      // Interval diambil dari strategi; fallback "15m" jika strategi tidak mendefinisikan
      interval:      strat.interval      || "15m",
      checkInterval: strat.checkInterval || 60_000,

      // ── Strategy info ─────────────────────────────────────────────────────
      strategyKey:   strat.name,
      strategyLabel: strat.label,
      signalType:    strat.signalType,

      // ── HTF trend filter ──────────────────────────────────────────────────
      higherTf:             strat.higherTf             || null,
      htfEmaFast:           strat.htfEmaFast            || 9,
      htfEmaSlow:           strat.htfEmaSlow            || 21,
      sidewaysThresholdPct: strat.sidewaysThresholdPct  || 0.2,

      // ── ATR filter ────────────────────────────────────────────────────────
      atrMinMult: strat.atrMinMult || 0.1,
      atrMaxMult: strat.atrMaxMult || 5.0,

      // ── Volume filter ─────────────────────────────────────────────────────
      volSmaMultiplier: strat.volSmaMultiplier || 1.0,

      // ── Sideways breakout/retest ──────────────────────────────────────────
      sidewaysRangeLookback:   strat.sidewaysRangeLookback   || 20,
      sidewaysBreakoutVolMult: strat.sidewaysBreakoutVolMult || 1.2,
      sidewaysBreakoutBufMult: strat.sidewaysBreakoutBufMult || 0.3,

      // ── Risk management harian ────────────────────────────────────────────
      maxDailyLossPct:   strat.maxDailyLossPct  || 0.04,
      maxTradesPerDay:   strat.maxTradesPerDay   || 10,
      cooldownAfterLoss: strat.cooldownAfterLoss || 5,
      maxConsecLoss:     strat.maxConsecLoss     || 3,

      // ── SL+ (Trailing Partial Take Profit) ───────────────────────────────
      slPlusEnabled:     true,   // aktif secara default
      slPlusPartial1Pct: 0.40,   // +1R → 40% partial, SL ke BEP
      slPlusPartial2Pct: 0.275,  // +2R → 27.5% partial, SL ke +1R

      // ── DB overrides (SELALU override semua default di atas) ─────────────
      // apiKey/apiSecret/passphrase sudah dihapus dari safeOverrides (keamanan)
      ...safeOverrides,

      // ── Credential flag (set setelah spread agar tidak ter-override) ──────
      _hasCredentials: !!(
        resolvedApiKey && resolvedApiSecret &&
        resolvedApiKey !== "your_api_key_here" &&
        resolvedApiKey !== "your_bitget_api_key"
      ),
    };

    this.state = {
      running:       false,
      openPositions: [],
      trades:        [],
      capital:       0,
      startCapital:  0,
      lastSignal:    null,
      checkCount:    0,
      errors:        0,
      lastTick:      null,
      lastPrice:     null,

      // Risk management tracking
      dailyTradeCount: 0,        // Jumlah trade hari ini
      dailyLoss:       0,        // Total loss hari ini (dalam USD)
      dailyStartCapital: 0,      // Modal awal hari ini (reset tiap hari)
      lastDayReset:    null,     // Timestamp reset terakhir
      consecLoss:      0,        // Loss berturut-turut
      cooldownUntil:   null,     // Timestamp cooldown selesai

      // HTF trend state
      htfTrend:        "UNKNOWN", // BULLISH / BEARISH / SIDEWAYS / UNKNOWN

      // Sideways breakout state (untuk Strat C retest)
      sidewaysBreakout: null,     // { signal, rangeHigh, rangeLow, rangeEdge, buffer, atr, detectedAt }
    };

    this.logs      = [];   // circular buffer max 1000 (WS streaming)
    this.sessionId = null; // DB session ID saat ini
    // Buat exchange client dengan key yang sudah di-resolve (DB > env)
    this.client    = new BitgetClient(resolvedApiKey, resolvedApiSecret, resolvedPassphrase);
    this._interval = null;
    this._reportInterval = null;
  }

  /**
   * Get real-time strategy rankings for Adaptive Fusion Strategy
   * Returns array of ranked components with scores and activation status
   */
  getStrategyRankings() {
    try {
      const AdaptiveFusionStrategy = require("../domain/strategy/implementations/AdaptiveFusionStrategy");
      const afs = new AdaptiveFusionStrategy();
      
      const volatility = this.state?.volatility || 1.0;
      const trendStrength = this.state?.trendStrength || 0.1;
      
      const rankings = afs.rankByMarketConditions({
        volatility,
        trend_strength: trendStrength,
      });
      
      const balance = this.config.capital || 0;
      return rankings.map(r => ({
        ...r,
        canActivate: balance >= (r.key === 'A' ? 500 : r.key === 'B' ? 50 : 0),
      }));
    } catch (err) {
      this._log("error", `Failed to get strategy rankings: ${err.message}`);
      return [];
    }
  }

  /**
   * Get position conflict information
   * Checks if new positions can be opened based on current positions
   */
  getPositionConflicts() {
    try {
      const openPositions = this.state?.openPositions || [];
      const symbolPositions = openPositions.filter(p => p.symbol === this.config.symbol).length;
      const maxPerSymbol = 1;
      const maxTotal = this.config.maxPositions || 5;
      const totalOpen = openPositions.length;
      
      const allowed = totalOpen < maxTotal && symbolPositions < maxPerSymbol;
      let reason = "Position can be opened";
      
      if (totalOpen >= maxTotal) {
        reason = `Maximum total positions reached (${totalOpen}/${maxTotal})`;
      } else if (symbolPositions >= maxPerSymbol) {
        reason = `Already have ${symbolPositions} position for ${this.config.symbol}`;
      }
      
      return {
        allowed,
        reason,
        totalOpen,
        maxTotal,
        symbolPositions,
        maxPerSymbol,
      };
    } catch (err) {
      this._log("error", `Failed to get position conflicts: ${err.message}`);
      return {
        allowed: false,
        reason: "Error checking positions",
        totalOpen: 0,
        maxTotal: 0,
        symbolPositions: 0,
        maxPerSymbol: 0,
      };
    }
  }

  // ─────────────────────────────────────────────
  // INTERNAL LOGGER — console + WS event + DB
  // ─────────────────────────────────────────────
  _log(level, ...args) {
    const msg   = args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    const time  = new Date().toISOString();
    const entry = { time, level, msg };

    // Buffer in-memory untuk WS
    this.logs.push(entry);
    if (this.logs.length > 1000) this.logs.shift();
    this.emit("log", entry);

    // Persist ke Prisma BotLog (semua level) bila botId tersedia
    if (this.config.botId) {
      persistBotLog({ botId: this.config.botId, level, message: msg }).catch(() => {});
    }

    // Legacy session logs (trade/error/warn) — backward compat
    if (this.sessionId && (level === "trade" || level === "error" || level === "warn")) {
      try {
        db.insertLog({ sessionId: this.sessionId, level, message: msg });
      } catch { /* jangan crash bot karena log error */ }
    }

    const C      = { info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m", trade: "\x1b[32m", price: "\x1b[34m" };
    const prefix = { info: "INFO ", warn: "WARN ", error: "ERROR", trade: "TRADE", price: "PRICE" };
    const ts     = `\x1b[90m[${new Date().toLocaleTimeString("id-ID")}]\x1b[0m`;
    console.log(`${ts} ${C[level] || "\x1b[37m"}[${prefix[level] || level.toUpperCase()}] ${msg}\x1b[0m`);
  }

  _sep(label = "") {
    const line = "─".repeat(50);
    const sep  = label
      ? `\n\x1b[90m${line}\x1b[0m\n\x1b[1m\x1b[33m  ${label}\x1b[0m\n\x1b[90m${line}\x1b[0m\n`
      : `\x1b[90m${line}\x1b[0m`;
    console.log(sep);
    if (label) this._log("info", `══ ${label} ══`);
  }

  // ─────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────
  getState() {
    return {
      running:       this.state.running,
      sessionId:     this.sessionId,
      symbol:        this.config.symbol,
      exchange:      this.config.exchange,
      exchangeLabel: this.config.exchangeLabel,
      dryRun:        this.config.dryRun,
      capital:        this.state.capital,
      startCapital:   this.state.startCapital,
      openPositions:  this.state.openPositions,
      trades:         this.state.trades.slice(-50),
      // totalTrades = open + closed (bukan hanya closed)
      totalTrades:    this.state.trades.length + this.state.openPositions.length,
      closedTrades:   this.state.trades.length,
      openTradeCount: this.state.openPositions.length,
      lastSignal:     this.state.lastSignal,
      checkCount:    this.state.checkCount,
      errors:        this.state.errors,
      lastTick:      this.state.lastTick,
      lastPrice:     this.state.lastPrice,
      // totalPnL = GROSS (selisih harga). totalFees & netPnL dipisah agar
      // dashboard bisa menampilkan keduanya — gross tak akan cocok dengan
      // perubahan balance riil karena fee. Net = gross - fee - funding.
      totalPnL:      this.state.trades.reduce((s, t) => s + (t.pnl || 0), 0),
      totalFees:     this.state.trades.reduce((s, t) => s + (t.fee || 0) + (t.funding || 0), 0),
      netPnL:        this.state.trades.reduce((s, t) => s + (t.pnl || 0) - (t.fee || 0) - (t.funding || 0), 0),
      unrealizedPnL: this.state.openPositions.reduce((s, p) => {
        if (p.unrealizedPL && p.unrealizedPL !== 0) return s + p.unrealizedPL;
        // Fallback: hitung dari lastPrice jika unrealizedPL belum diset dari exchange
        const px = this.state.lastPrice;
        if (!px || !p.entry) return s;
        const sz   = p.remainingSize || p.size || 0;
        const upnl = p.side === "LONG" ? (px - p.entry) * sz : (p.entry - px) * sz;
        return s + upnl;
      }, 0),
      winRate:       this._winRate(),

      // Risk management state
      riskState: {
        htfTrend:        this.state.htfTrend,
        higherTf:        this.config.higherTf,
        dailyTradeCount: this.state.dailyTradeCount,
        maxTradesPerDay: this.config.maxTradesPerDay,
        dailyLoss:       this.state.dailyLoss,
        maxDailyLossPct: this.config.maxDailyLossPct,
        consecLoss:      this.state.consecLoss,
        maxConsecLoss:   this.config.maxConsecLoss,
        cooldownUntil:   this.state.cooldownUntil,
        inCooldown:      !!(this.state.cooldownUntil && Date.now() < this.state.cooldownUntil),
      },

      params: {
        strategyKey:   this.config.strategyKey,
        strategyLabel: this.config.strategyLabel,
        signalType:    this.config.signalType,
        emaFast:       this.config.emaFast,
        emaSlow:       this.config.emaSlow,
        emaTrend:      this.config.emaTrend,
        rsiPeriod:     this.config.rsiPeriod,
        rsiOverbought: this.config.rsiOverbought,
        rsiOversold:   this.config.rsiOversold,
        atrPeriod:     this.config.atrPeriod,
        atrMultiplier: this.config.atrMultiplier,
        riskReward:      this.config.riskReward,
        riskPerTrade:    this.config.riskPerTrade,
        maxRiskPerTrade: this.config.maxRiskPerTrade,
        leverage:        this.config.leverage,
        useBothSides:  this.config.useBothSides,
        interval:      this.config.interval,
        checkInterval: this.config.checkInterval,
        higherTf:      this.config.higherTf,
      },
    };
  }

  getConfig() {
    const { ...cfg } = this.config;
    return cfg;
  }

  getLogs(n = 100) {
    return this.logs.slice(-Math.min(n, 1000));
  }

  async start() {
    if (this.state.running) throw new Error("Bot sudah berjalan");

    // Reset in-memory state
    this.state.trades        = [];
    this.state.openPositions = [];
    this.state.lastSignal    = null;
    this.state.checkCount    = 0;
    this.state.errors        = 0;

    await this._startup();
    this.state.running = true;

    // ── Selalu buat sesi BARU (1 token bisa punya banyak sesi) ────────────
    this.sessionId = await db.openSession({
      exchange:       this.config.exchange,
      symbol:         this.config.symbol,
      mode:           this.config.dryRun ? "dry_run" : "live",
      initialCapital: this.state.startCapital,
      config:         this.config,
      userId:         this.config.userId ?? null,  // isolasi data per user
    });
    this._log("info", `Session DB #${this.sessionId} dibuat`);

    // ── Restore posisi terbuka dari SEMUA sesi lama (lintas sesi) ─────────
    // Cari trades dengan close_time IS NULL untuk symbol ini di semua sesi
    try {
      let orphans = await db.getOpenTradesBySymbol(this.config.symbol);
      // Multi-Strategy per Coin: bila engine ini bagian dari grup (N strategi pada
      // satu koin), batasi restore HANYA pada trade strategi ini — agar tiap engine
      // tidak meng-klaim posisi milik strategi lain pada simbol yang sama.
      // Legacy single-engine (tanpa groupKey) tetap memulihkan semua posisi simbol.
      if (this.config.groupKey && this.config.strategyKey) {
        orphans = orphans.filter((row) => {
          let stratOfTrade = null;
          try { stratOfTrade = row.indicators ? JSON.parse(row.indicators)?.strategy : null; } catch { /* ignore */ }
          // Bila trade lama tidak punya atribusi strategi, jangan klaim di mode grup.
          return stratOfTrade === this.config.strategyKey;
        });
      }
      if (orphans.length > 0) {
        this._log("info", `${orphans.length} posisi open dari sesi lama ditemukan — sinkronisasi dengan exchange...`);

        if (!this.config.dryRun) {
          try {
            const livePosns = await this.client.getPositions(this.config.symbol);
            const liveByKey = new Map(livePosns.map(p => [p.side, p]));

            for (const dbTrade of orphans) {
              if (liveByKey.has(dbTrade.side)) {
                // Masih terbuka di exchange → angkat ke state sesi ini
                const lp        = liveByKey.get(dbTrade.side);
                const markPrice = lp.markPrice || dbTrade.entry_price;
                const size      = dbTrade.size || 0;
                // Hitung unrealized PnL secara manual jika exchange return 0
                const upnlFromExchange = lp.unrealizedPL ?? 0;
                const upnlCalc = markPrice > 0 && dbTrade.entry_price > 0
                  ? (dbTrade.side === "LONG"
                      ? (markPrice - dbTrade.entry_price) * size
                      : (dbTrade.entry_price - markPrice) * size)
                  : 0;
                const unrealizedPL = upnlFromExchange !== 0 ? upnlFromExchange : upnlCalc;

                this.state.openPositions.push({
                  id:           dbTrade.order_id || `restored_${dbTrade.id}`,
                  dbId:         dbTrade.id,        // tetap pakai id trade lama di DB
                  side:         dbTrade.side,
                  entry:        dbTrade.entry_price,
                  sl:           dbTrade.sl,
                  tp:           dbTrade.tp,
                  size,
                  openTime:     new Date(dbTrade.open_time).getTime(),
                  atr:          dbTrade.atr,
                  manualSLTP:   false,
                  unrealizedPL,
                  markPrice,
                  restoredFrom: dbTrade.session_id,
                  // SL+ tracking (restored dari nilai DB)
                  remainingSize: size,
                  R:             dbTrade.atr ? dbTrade.atr * this.config.atrMultiplier : 0,
                  slCurrent:     dbTrade.sl,
                  m1: false, m2: false, m3: false,
                });
                this._log("trade", `✓ Posisi ${dbTrade.side} @$${dbTrade.entry_price} dipulihkan (sesi #${dbTrade.session_id})`);
              } else {
                // Tidak ada di exchange → tutup di DB (kena SL/TP saat offline)
                const exitPrice = this.state.lastPrice || dbTrade.entry_price;
                const pnl       = dbTrade.side === "LONG"
                  ? (exitPrice - dbTrade.entry_price) * (dbTrade.size || 0)
                  : (dbTrade.entry_price - exitPrice) * (dbTrade.size || 0);
                // Close terdeteksi offline → fill aktual tak bisa dipetakan; estimasi fee
                const fee = this._estimateFee(dbTrade.entry_price, exitPrice, dbTrade.size || 0);
                this._log("warn", `Posisi ${dbTrade.side} sesi #${dbTrade.session_id} sudah ditutup di exchange saat offline — PnL ≈ $${pnl.toFixed(2)} (fee est -$${fee.toFixed(4)})`);
                try {
                  await db.closeTrade(dbTrade.id, {
                    exitPrice,
                    pnl,
                    fee,
                    reason:    "Closed_Offline",
                    closeTime: new Date().toISOString(),
                  });
                } catch { /* jangan crash */ }
              }
            }
          } catch (err) {
            // Exchange gagal — restore semua dari DB sebagai fallback
            this._log("warn", `Gagal sync exchange: ${err.message} — restore posisi dari DB`);
            for (const dbTrade of orphans) {
              this.state.openPositions.push({
                id:           dbTrade.order_id || `restored_${dbTrade.id}`,
                dbId:         dbTrade.id,
                side:         dbTrade.side,
                entry:        dbTrade.entry_price,
                sl:           dbTrade.sl,
                tp:           dbTrade.tp,
                size:         dbTrade.size,
                openTime:     new Date(dbTrade.open_time).getTime(),
                atr:          dbTrade.atr,
                manualSLTP:   false,
                restoredFrom: dbTrade.session_id,
              });
            }
          }
        } else {
          // Dry run: restore langsung dari DB tanpa sync exchange
          for (const dbTrade of orphans) {
            this.state.openPositions.push({
              id:           dbTrade.order_id || `restored_${dbTrade.id}`,
              dbId:         dbTrade.id,
              side:         dbTrade.side,
              entry:        dbTrade.entry_price,
              sl:           dbTrade.sl,
              tp:           dbTrade.tp,
              size:         dbTrade.size,
              openTime:     new Date(dbTrade.open_time).getTime(),
              atr:          dbTrade.atr,
              restoredFrom: dbTrade.session_id,
            });
          }
        }

        if (this.state.openPositions.length > 0)
          this._log("info", `${this.state.openPositions.length} posisi aktif dipulihkan ✓`);
      }

      // Re-reserve margin di koordinator untuk posisi yang dipulihkan (#5) — agar
      // setelah restart/redeploy, margin posisi terbuka tetap diperhitungkan dan
      // tidak terjadi over-commit oleh bot lain.
      if (!this.config.dryRun && this.config.coordinator && this.state.openPositions.length > 0) {
        const p   = this.state.openPositions[0];
        const lev = this.config.leverage || 1;
        const sz  = p.remainingSize || p.size || 0;
        const margin = (p.entry * sz) / lev;
        const botKey = this.config.botKey || `${this.config.userId ?? "anon"}:${this.config.symbol}`;
        this.config.coordinator.reserve(botKey, {
          symbol: this.config.symbol, margin,
          groupKey: this.config.groupKey ?? null,
          strategyKey: this.config.strategyKey ?? null,
          direction: p.side,
        });
      }
    } catch (err) {
      this._log("warn", `Gagal restore posisi lama: ${err.message}`);
    }

    this.emit("status", this.getState());

    await this._tick();

    this._interval       = setInterval(() => this._tick(), this.config.checkInterval);
    this._reportInterval = setInterval(() => this._statusReport(), 60 * 60 * 1000);

    this._log("info", `Bot berjalan — cek setiap ${this.config.checkInterval / 1000}s`);
  }

  async stop() {
    if (this._interval)       clearInterval(this._interval);
    if (this._reportInterval) clearInterval(this._reportInterval);
    this._interval       = null;
    this._reportInterval = null;
    this.state.running   = false;

    // Lepas reservasi margin HANYA jika bot sudah flat (#5). Jika masih ada
    // posisi terbuka (akan dipulihkan di start berikutnya), reservasi DIPERTAHANKAN
    // agar margin yang masih terkunci di exchange tetap diperhitungkan bot lain.
    this._releaseMarginIfFlat();

    // Tutup sesi di DB
    // Posisi yang masih open (close_time IS NULL) tetap tersimpan di tabel trades
    // dan akan di-restore oleh start() berikutnya via getOpenTradesBySymbol()
    if (this.sessionId) {
      const wins        = this.state.trades.filter(t => t.pnl > 0).length;
      const losses      = this.state.trades.filter(t => t.pnl <= 0).length;
      const totalTrades = this.state.trades.length + this.state.openPositions.length;
      const openCount   = this.state.openPositions.length;

      // ── finalCapital = modal awal bot ini + PnL trade bot ini sendiri ──
      // JANGAN pakai this.state.capital (balance exchange bersama 3 bot!)
      const tradePnL   = this.state.trades.reduce((s, t) => s + (t.pnl || 0), 0);
      const finalCapital = this.state.startCapital + tradePnL;

      await db.closeSession(this.sessionId, {
        finalCapital,
        totalTrades,
        wins,
        losses,
      });

      if (openCount > 0)
        this._log("warn", `Session DB #${this.sessionId} ditutup (${openCount} posisi masih open — akan dipulihkan di sesi berikutnya)`);
      else
        this._log("warn", `Session DB #${this.sessionId} ditutup`);

      this.sessionId = null;
    }

    this._log("warn", "Bot dihentikan");
    this.emit("status", this.getState());
  }

  // ─────────────────────────────────────────────
  // STARTUP
  // ─────────────────────────────────────────────
  async _startup() {
    this._sep(`QUANTARA BOT — ${this.config.exchangeLabel.toUpperCase()}`);
    this._log("info", `Exchange   : ${this.config.exchangeLabel}`);
    this._log("info", `Mode       : ${this.config.dryRun ? "DRY RUN (simulasi)" : "LIVE TRADING"}`);
    this._log("info", `Strategi   : [${this.config.strategyKey}] ${this.config.strategyLabel}`);
    this._log("info", `Symbol     : ${this.config.symbol}`);
    this._log("info", `Interval   : ${this.config.interval}`);
    this._log("info", `EMA        : Fast(${this.config.emaFast}) / Slow(${this.config.emaSlow})`);
    this._log("info", `RSI        : Overbought(${this.config.rsiOverbought}) / Oversold(${this.config.rsiOversold})`);
    this._log("info", `Risk/trade : ${(this.config.riskPerTrade * 100).toFixed(1)}%  |  Leverage: ${this.config.leverage}x  |  RR: 1:${this.config.riskReward}`);
    this._sep();

    // Gunakan kredensial yang sudah di-resolve (DB key dari Settings > env var)
    const noKey = !this.config._hasCredentials;

    if (noKey) {
      if (!this.config.dryRun) throw new Error("API Key exchange belum dikonfigurasi. Tambahkan di menu Settings → API Keys.");
      this._log("warn", "API Key tidak ditemukan — DRY RUN tanpa koneksi exchange (simulasi)");
      this.state.capital = this.state.startCapital = this.config.capital || 500;
    } else {
      try {
        const bal = await this.client.getBalance(this.config.marginCoin);
        const totalEquity = (bal.equity > 0 ? bal.equity : bal.available);

        if (this.config.dryRun) {
          // Dry-run: modal simulasi dari config DB, BUKAN saldo exchange nyata.
          this.state.capital = this.state.startCapital = this.config.capital || 500;
          this._log("info", `Modal DRY RUN: $${this.state.capital.toFixed(2)} USDT (exchange: $${totalEquity.toFixed(2)} — hanya referensi)`);
        } else {
          // Live: gunakan equity total (available + margin terkunci).
          this.state.capital      = totalEquity;
          this.state.startCapital = totalEquity;
          this._log("info", `Balance    : $${totalEquity.toFixed(2)} USDT (available: $${bal.available.toFixed(2)})`);
          await this.client.setLeverage(this.config.symbol, this.config.leverage);
          await this.client.setMarginMode(this.config.symbol, "crossed");
          this._log("info", `Leverage   : ${this.config.leverage}x diset ✓`);
        }
      } catch (err) {
        this._log("error", `Gagal connect ke ${this.config.exchangeLabel}: ${err.message}`);
        if (!this.config.dryRun) throw err;
        this.state.capital = this.state.startCapital = this.config.capital || 500;
        this._log("warn", `Fallback DRY RUN dengan modal $${this.state.capital.toFixed(2)}`);
      }
    }

    // ── Pulihkan circuit-breaker risiko dari DB (#3) ──────────────────────────
    // Tanpa ini, stop→start / redeploy mereset daily-loss & loss-streak ke 0,
    // sehingga batas kerugian harian bisa ditembus. Hitung ulang dari trade
    // yang sudah closed HARI INI (UTC) untuk user+symbol+mode ini.
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const risk = await db.getTodayRiskStats({
        userId:  this.config.userId ?? null,
        symbol:  this.config.symbol,
        dryRun:  this.config.dryRun,
      });
      this.state.dailyLoss         = risk.dailyLoss;
      this.state.dailyTradeCount   = risk.dailyTradeCount;
      this.state.consecLoss        = risk.consecLoss;
      this.state.lastDayReset      = todayStr;
      // dailyStartCapital ≈ modal saat ini + loss hari ini (perkiraan modal awal hari).
      this.state.dailyStartCapital = this.state.capital + risk.dailyLoss;
      if (risk.dailyTradeCount > 0) {
        this._log("info",
          `🛡️ Risk dipulihkan dari DB — trade hari ini: ${risk.dailyTradeCount}, ` +
          `daily loss: $${risk.dailyLoss.toFixed(2)}, loss beruntun: ${risk.consecLoss}`
        );
      }
    } catch (e) {
      this._log("warn", `Gagal memulihkan risk state dari DB: ${e.message} — mulai dari 0`);
    }

    this._sep("BOT BERJALAN");
  }

  // ─────────────────────────────────────────────
  // RISK MANAGEMENT HELPERS
  // ─────────────────────────────────────────────

  /** Reset counter harian jika sudah ganti hari */
  _resetDailyIfNeeded() {
    const now     = new Date();
    const todayStr = now.toISOString().slice(0, 10); // "2026-06-03"
    if (this.state.lastDayReset !== todayStr) {
      this.state.dailyTradeCount   = 0;
      this.state.dailyLoss         = 0;
      this.state.dailyStartCapital = this.state.capital;
      this.state.lastDayReset      = todayStr;
      this.state.consecLoss        = 0;
      this.state.cooldownUntil     = null;
      this._log("info", `📅 Hari baru — daily counter di-reset`);
    }
  }

  /**
   * Periksa apakah boleh buka trade baru.
   * Returns { ok: true } atau { ok: false, reason: string }
   */
  _checkRiskGates(atr, price) {
    // 1. Cooldown setelah loss
    if (this.state.cooldownUntil && Date.now() < this.state.cooldownUntil) {
      const remaining = Math.ceil((this.state.cooldownUntil - Date.now()) / 60000);
      return { ok: false, reason: `Cooldown aktif — tunggu ${remaining} menit lagi` };
    }

    // 2. Loss berturut-turut
    if (this.state.consecLoss >= this.config.maxConsecLoss) {
      return { ok: false, reason: `${this.state.consecLoss} loss berturut — stop trading hari ini` };
    }

    // 3. Max trades per hari
    if (this.state.dailyTradeCount >= this.config.maxTradesPerDay) {
      return { ok: false, reason: `Maks ${this.config.maxTradesPerDay} trade/hari sudah tercapai` };
    }

    // 4. Daily loss limit — sertakan FLOATING loss posisi terbuka (#8), bukan
    //    hanya realized, agar drawdown mengambang besar tetap men-trigger stop.
    const floatingLoss = this.state.openPositions.reduce((s, p) => {
      const u = p.unrealizedPL || 0;
      return u < 0 ? s + Math.abs(u) : s;
    }, 0);
    const effectiveDailyLoss = this.state.dailyLoss + floatingLoss;
    const dailyBase    = this.state.dailyStartCapital || this.state.capital;
    const dailyLossPct = dailyBase > 0 ? effectiveDailyLoss / dailyBase : 0;
    if (dailyLossPct >= this.config.maxDailyLossPct) {
      return {
        ok: false,
        reason: `Daily loss ${(dailyLossPct * 100).toFixed(2)}% (incl floating) melewati batas ${(this.config.maxDailyLossPct * 100)}%`,
      };
    }

    // 4b. Daily loss AGREGAT akun lintas-bot (#5) — cegah Σ kerugian beberapa bot
    //     menembus batas akun walau tiap bot masih dalam batasnya sendiri.
    if (!this.config.dryRun && this.config.coordinator) {
      const acc = this.config.coordinator.canTradeAccount();
      if (!acc.ok) return { ok: false, reason: acc.reason };
    }

    // 5. ATR range filter (previously 6 — SIDEWAYS dipindah ke _tick() per-strategi)
    if (atr && price) {
      const atrPct = (atr / price) * 100;
      const minPct = this.config.atrMinMult; // % langsung — misal 0.3 = 0.3% dari harga
      const maxPct = this.config.atrMaxMult; // % langsung — misal 3.0 = 3.0% dari harga
      if (atrPct < minPct) {
        return { ok: false, reason: `ATR terlalu kecil (${atrPct.toFixed(3)}%) — market terlalu sepi` };
      }
      if (atrPct > maxPct) {
        return { ok: false, reason: `ATR terlalu besar (${atrPct.toFixed(3)}%) — volatilitas ekstrem` };
      }
    }

    return { ok: true };
  }

  /** Panggil setelah trade ditutup untuk update counter risk */
  _updateRiskAfterClose(pnl) {
    if (pnl < 0) {
      this.state.dailyLoss   += Math.abs(pnl);
      this.state.consecLoss  += 1;
      // Set cooldown
      if (this.config.cooldownAfterLoss > 0) {
        this.state.cooldownUntil = Date.now() + this.config.cooldownAfterLoss * 60 * 1000;
        this._log("warn", `🕐 Cooldown ${this.config.cooldownAfterLoss} menit aktif setelah loss`);
      }
    } else {
      this.state.consecLoss = 0; // Reset streak setelah win
    }
  }

  // ─────────────────────────────────────────────
  // MAIN TICK
  // ─────────────────────────────────────────────
  async _tick() {
    // Guard re-entrancy (#6): _tick async & bisa lebih lama dari checkInterval
    // (ada sleep retry SL 3s + backoff 120s). Tanpa guard, setInterval memicu
    // tick paralel → entry ganda & race pada openPositions.
    if (this._ticking) {
      this._log("info", "Tick sebelumnya masih berjalan — lewati tick ini");
      return;
    }
    this._ticking = true;

    this.state.checkCount++;
    this.state.lastTick = new Date().toISOString();

    // Reset daily counter jika hari baru
    this._resetDailyIfNeeded();

    try {
      const candles = await this._fetchCandles();
      if (!candles || candles.length < this.config.emaSlow + 20) {
        this._log("warn", "Candle tidak cukup untuk kalkulasi indikator");
        return;
      }

      const indicators = calcIndicators(candles, {
        emaFast:   this.config.emaFast,
        emaSlow:   this.config.emaSlow,
        emaTrend:  this.config.emaTrend,
        rsiPeriod: this.config.rsiPeriod,
        atrPeriod: this.config.atrPeriod,
      });

      // ── HTF Trend Filter ───────────────────────────────────────────────────
      let htfCandlesCache = null;  // disimpan untuk sideways breakout detection
      if (this.config.higherTf) {
        try {
          const htfCandles = await this.client.getCandles(
            this.config.symbol, this.config.higherTf,
            Math.max(this.config.htfEmaSlow + 10, 50)
          );
          htfCandlesCache = htfCandles;
          this.state.htfTrend = detectHTFTrend(htfCandles, {
            htfEmaFast:           this.config.htfEmaFast,
            htfEmaSlow:           this.config.htfEmaSlow,
            sidewaysThresholdPct: this.config.sidewaysThresholdPct,
          });
        } catch {
          this.state.htfTrend = "UNKNOWN"; // Tidak bisa fetch HTF → allow trade
        }
      }

      // Reset sidewaysBreakout state jika HTF sudah tidak SIDEWAYS lagi
      if (this.state.htfTrend !== "SIDEWAYS" && this.state.sidewaysBreakout) {
        this._log("info", `HTF ${this.config.higherTf} tidak lagi SIDEWAYS — reset sideways breakout state`);
        this.state.sidewaysBreakout = null;
      }

      const lastIdx  = candles.length - 2;
      const price    = candles[lastIdx].close;
      const emaF     = indicators.emaFast[lastIdx];
      const emaS     = indicators.emaSlow[lastIdx];
      const emaTrend = this.config.emaTrend > 0 && indicators.emaTrend ? indicators.emaTrend[lastIdx] : null;
      const rsi      = indicators.rsi[lastIdx];
      const atr      = indicators.atr[lastIdx];

      this.state.lastPrice = price;

      if (this.state.checkCount % 5 === 1) {
        const htfLabel   = this.config.higherTf ? ` | HTF(${this.config.higherTf}): ${this.state.htfTrend}` : "";
        const trendLabel = emaTrend
          ? (price > emaTrend ? "↑ MAJOR" : "↓ MAJOR")
          : (emaF > emaS ? "↑ BULLISH" : "↓ BEARISH");
        this._log("price",
          `${this.config.symbol} $${price.toLocaleString()} | ` +
          `EMA${this.config.emaFast}=${emaF?.toFixed(2)} EMA${this.config.emaSlow}=${emaS?.toFixed(2)}` +
          (emaTrend ? ` EMA${this.config.emaTrend}=${emaTrend?.toFixed(2)}` : "") + ` | ` +
          `RSI=${rsi?.toFixed(1)} ATR=${atr?.toFixed(2)} | ` +
          `Trend: ${trendLabel}${htfLabel} | Strat: [${this.config.strategyKey}]`
        );
      }

      // Harga real-time untuk monitoring SL/TP (#7). `price` di atas = close candle
      // ke-2 terakhir (benar untuk deteksi sinyal, tapi BASI untuk cek SL/TP — pada
      // 15m bisa tertinggal s/d 15 menit). Gunakan ticker.last bila tersedia.
      let monitorPrice = price;
      if (this.state.openPositions.length > 0 && this.client?.getTicker) {
        try {
          const ticker = await this.client.getTicker(this.config.symbol);
          if (ticker?.last > 0) monitorPrice = ticker.last;
        } catch { /* fallback ke close candle */ }
      }
      this.state.lastPrice = monitorPrice;

      await this._checkOpenPositions(monitorPrice, atr);

      // Lapor risk ke koordinator akun tiap tick (#5) — termasuk saat memegang
      // posisi — agar gate daily-loss agregat lintas-bot selalu pakai data segar.
      if (!this.config.dryRun && this.config.coordinator) {
        const floatingLoss = this.state.openPositions.reduce((s, p) => {
          const u = p.unrealizedPL || 0;
          return u < 0 ? s + Math.abs(u) : s;
        }, 0);
        const botKey = this.config.botKey || `${this.config.userId ?? "anon"}:${this.config.symbol}`;
        this.config.coordinator.reportRisk(botKey, { realizedLoss: this.state.dailyLoss, floatingLoss });
      }

      if (this.state.openPositions.length < this.config.maxPositions) {
        // ── STEP 1: Risk gates (daily loss, cooldown, max trades, ATR, HTF) ──
        const gate = this._checkRiskGates(atr, price);
        if (!gate.ok) {
          if (this.state.checkCount % 10 === 1) {
            this._log("info", `🚫 Skip entry: ${gate.reason}`);
          }
        } else {
          // BREAKOUT_RETEST punya detector sendiri (level S&R + retest) — tidak pakai handler sideways PDF
          if (this.state.htfTrend === "SIDEWAYS" && this.config.signalType !== "BREAKOUT_RETEST") {
            // ── STEP 2a: SIDEWAYS — per-strategi (A diam, B breakout, C retest) ───
            await this._checkSidewaysEntry(htfCandlesCache, price, atr, indicators, lastIdx, emaF, emaS, emaTrend, rsi);
          } else {
            // ── STEP 2b: TRENDING — sinyal trend-following normal ───────────────
            // Hitung volatility & trend_strength untuk AFS component ranking (#BugA).
            // Tanpa ini AFS menerima default (volatility=1, trend_strength=0.1) → komponen
            // dipilih berdasarkan asumsi "dead market" bukan kondisi market nyata.
            const atrPctNow = atr && price ? (atr / price) * 100 : 1.0;
            const emaDelta  = emaS > 0 ? Math.abs(emaF - emaS) / emaS : 0;
            const trendStr  = Math.min(emaDelta * 50, 1.0); // normalisasi 0–1

            const signal = detectSignal(indicators, lastIdx, {
              rsiOverbought:    this.config.rsiOverbought,
              rsiOversold:      this.config.rsiOversold,
              rsiLongMin:       this.config.rsiLongMin,
              rsiLongMax:       this.config.rsiLongMax,
              rsiShortMin:      this.config.rsiShortMin,
              rsiShortMax:      this.config.rsiShortMax,
              useBothSides:     this.config.useBothSides,
              signalType:       this.config.signalType,
              volSmaMultiplier: this.config.volSmaMultiplier,
              symbol:           this.config.symbol,
              // AFS: kondisi market nyata agar komponen dipilih dengan benar
              volatility:       atrPctNow,
              trend_strength:   trendStr,
              balance:          this.state.capital,
            });

            // ── STEP 2c: MEAN_REVERSION HTF regime guard (FIX-4) ──────────────
            // MR tanpa filter akan counter-trend terus saat strong bull/bear →
            // SL beruntun → daily loss limit. Blokir SHORT di strong bull dan
            // LONG di strong bear, juga saat ATR HTF spike. Fail-open bila HTF
            // tidak bisa diambil (konsisten dgn HTF trend filter di bawah).
            let mrSignal = signal;
            if (signal && (this.config.strategyKey === "MEAN_REVERSION" || this.config.signalType === "MEAN_REVERSION")) {
              try {
                const htf = htfCandlesCache || await this.client.getCandles(this.config.symbol, "1h", 60);
                if (htf && htf.length >= 30) {
                  const hCloses = htf.map(c => c.close);
                  const hHighs  = htf.map(c => c.high);
                  const hLows   = htf.map(c => c.low);
                  const lastNN  = (a) => { for (let k = a.length - 1; k >= 0; k--) if (a[k] != null) return a[k]; return null; };
                  const atrArr  = calcATR(hHighs, hLows, hCloses, 14);
                  const htfData = {
                    emaFast:     lastNN(calcEMA(hCloses, 9)),
                    emaSlow:     lastNN(calcEMA(hCloses, 21)),
                    rsi:         lastNN(calcRSI(hCloses, 14)),
                    close:       hCloses[hCloses.length - 1],
                    atr:         lastNN(atrArr),
                    atrBaseline: lastNN(calcSMA(atrArr.map(v => (v == null ? 0 : v)), 20)),
                  };
                  const regimeCheck = meanReversionRegimeFilter({ direction: signal, htfData });
                  if (!regimeCheck.allowed) {
                    mrSignal = null;
                    this._log("info", `[MR] Entry diblokir (${regimeCheck.regime}): ${regimeCheck.reason}`);
                  }
                }
              } catch (e) {
                this._log("warn", `[MR] HTF regime check gagal — fail-open: ${e.message}`);
              }
            }

            // ── STEP 3: Saring sinyal berdasarkan HTF trend ───────────────────
            // BREAKOUT_RETEST: skip filter HTF — breakout/retest valid di konsolidasi
            let filteredSignal = mrSignal;
            if (mrSignal && this.config.signalType !== "BREAKOUT_RETEST" && this.state.htfTrend !== "UNKNOWN") {
              if (signal === "LONG"  && this.state.htfTrend === "BEARISH") {
                filteredSignal = null;
                this._log("info", `🔴 LONG diblok — HTF ${this.config.higherTf} BEARISH`);
              }
              if (signal === "SHORT" && this.state.htfTrend === "BULLISH") {
                filteredSignal = null;
                this._log("info", `🟢 SHORT diblok — HTF ${this.config.higherTf} BULLISH`);
              }
            }

            if (filteredSignal && filteredSignal !== this.state.lastSignal) {
              const vol    = indicators.volumes[lastIdx]  ?? 0;
              const volSMA = indicators.volSMA[lastIdx]   ?? 1;
              const indicatorSnapshot = {
                rsi:          rsi     != null ? parseFloat(rsi.toFixed(2))   : null,
                atr:          atr     != null ? parseFloat(atr.toFixed(4))   : null,
                atrPct:       atr && price ? parseFloat(((atr / price) * 100).toFixed(3)) : null,
                emaFast:      emaF    != null ? parseFloat(emaF.toFixed(4))  : null,
                emaSlow:      emaS    != null ? parseFloat(emaS.toFixed(4))  : null,
                emaTrendVal:  emaTrend != null ? parseFloat(emaTrend.toFixed(4)) : null,
                emaTrendBias: emaTrend != null ? (price > emaTrend ? "bullish" : "bearish") : null,
                volumeRatio:  volSMA > 0 ? parseFloat((vol / volSMA).toFixed(2)) : null,
                htfTrend:     this.state.htfTrend ?? null,
                strategy:     this.config.strategyKey ?? null,
              };

              // P1: For ADAPTIVE_FUSION, use component-aware SL/TP
              let signalOptions = {};
              if (this.config.signalType === "ADAPTIVE_FUSION") {
                const meta = getAdaptiveFusionMeta();
                if (meta) {
                  const AdaptiveFusionStrategy = require("../domain/strategy/implementations/AdaptiveFusionStrategy");
                  const afsInstance = new AdaptiveFusionStrategy();
                  const riskCfg = afsInstance.calculateRiskConfig(price, atr, filteredSignal, meta.component);
                  signalOptions.slDist = riskCfg.slDistance;
                  signalOptions.tpDist = riskCfg.tpDistance;
                  indicatorSnapshot.afComponent  = meta.component;
                  indicatorSnapshot.afVotes      = meta.votes;
                  indicatorSnapshot.afMarketCond = meta.marketCond;
                  this._log("info",
                    `[AF] Component: ${meta.component} | Votes: ${JSON.stringify(meta.votes)} | ` +
                    `RR 1:${riskCfg.riskReward} | SL×${riskCfg.slMultiplier} TP×${riskCfg.tpMultiplier}`
                  );
                }
              } else if (this.config.signalType === "BREAKOUT_RETEST") {
                const BreakoutRetestStrategy = require("../domain/strategy/implementations/BreakoutRetestStrategy");
                const brInstance = new BreakoutRetestStrategy();
                const riskCfg = brInstance.calculateRiskConfig(price, atr, filteredSignal);
                signalOptions.slDist = riskCfg.slDistance;
                signalOptions.tpDist = riskCfg.tpDistance;
                indicatorSnapshot.entryMode = "breakout_retest";
                this._log("info",
                  `[BR] RR 1:${riskCfg.riskReward} | SL×${riskCfg.slMultiplier} TP×${riskCfg.tpMultiplier}`
                );
              }

              // ── Idempotency guard (FIX-3) ───────────────────────────────────
              // Cegah dua posisi terbuka untuk sinyal yang sama bila tick/candle
              // diproses dua kali (mis. polling overlap atau WS reconnect).
              // Key = symbol + strategy + candleOpenTime + direction (TTL 5 menit).
              const candleOpenTime = candles[lastIdx].timestamp ?? candles[lastIdx].openTime;
              const dup = isDuplicate({
                symbol:         this.config.symbol,
                strategy:       this.config.strategyKey,
                candleOpenTime,
                direction:      filteredSignal,
              });

              if (dup) {
                this._log("warn", `Duplicate signal dibuang — ${filteredSignal} @candle ${candleOpenTime}`);
              } else {
                await this._handleSignal(filteredSignal, price, atr, indicatorSnapshot, signalOptions);
                this.state.lastSignal = filteredSignal;
              }
            } else if (!filteredSignal) {
              this.state.lastSignal = null;
            }
          }
        }
      }

      this.state.errors = 0;

      // Refresh capital dari exchange setiap 5 menit (live mode)
      // Pakai equity total (bukan available) agar grafik tidak anjlok saat posisi terbuka
      if (!this.config.dryRun && this.state.checkCount % 5 === 0) {
        try {
          const bal = await this.client.getBalance(this.config.marginCoin);
          const totalEquity = bal.equity > 0 ? bal.equity : bal.available;
          if (totalEquity > 0) this.state.capital = totalEquity;
        } catch { /* silent — pakai nilai sebelumnya */ }
      }

      // Snapshot equity ke DB setiap 5 ticks (throttle — bukan setiap tick)
      // Strat A (30s): 576 row/hari per bot vs 2880 sebelumnya
      if (this.sessionId && this.state.checkCount % 5 === 0) {
        try {
          db.snapshotEquity({
            sessionId:     this.sessionId,
            capital:       this.state.capital,
            price,
            openPositions: this.state.openPositions.length,
          });
        } catch { /* jangan crash karena snapshot error */ }
      }

      this.emit("status", this.getState());

    } catch (err) {
      this.state.errors++;
      this._log("error", `Tick error (${this.state.errors}/10): ${err.message}`);
      // Naikkan threshold 5 → 10 dan jangan stop permanen — skip tick saja
      if (this.state.errors >= 10) {
        this._log("error", "10 error berturut-turut — skip 2 menit, lanjut otomatis.");
        this.state.errors = 0; // reset agar bot tidak mati permanen
        await new Promise(r => setTimeout(r, 120_000)); // tunggu 2 menit
      }
    } finally {
      // Selalu lepas guard re-entrancy, termasuk setelah backoff 120s di atas.
      this._ticking = false;
    }
  }

  // ─────────────────────────────────────────────
  // FETCH CANDLES — dengan cache DB
  // ─────────────────────────────────────────────
  async _fetchCandles() {
    // OHLCV adalah endpoint publik — tidak perlu API key.
    // dryRun hanya mencegah order placement, bukan pengambilan harga nyata.
    // Selalu coba fetch data real; simulasi hanya jika exchange benar-benar tidak bisa dijangkau.

    // 1. Coba cache dulu (valid 15 menit)
    try {
      const cached = await db.getCachedCandles(this.config.exchange, this.config.symbol, this.config.interval, 900);
      if (cached && cached.length >= this.config.emaSlow + 20) {
        return cached;
      }
    } catch { /* cache error tidak masalah */ }

    // 2. Fetch dari exchange API (public endpoint — tidak butuh API key)
    try {
      const timeframe = this.config.interval.toLowerCase();
      const candles   = await this.client.getCandles(this.config.symbol, timeframe, 200);

      // Simpan ke cache
      try {
        db.cacheCandles(this.config.exchange, this.config.symbol, this.config.interval, candles);
      } catch { /* cache write error tidak masalah */ }

      return candles;
    } catch (err) {
      this._log("warn", `Gagal ambil candles dari exchange: ${err.message}`);

      // 2b. Fallback cache stale (hingga 24 jam) saat jaringan ke Bitget bermasalah
      try {
        const stale = await db.getCachedCandles(this.config.exchange, this.config.symbol, this.config.interval, 86_400);
        if (stale && stale.length >= this.config.emaSlow + 20) {
          this._log("info", `Pakai candle cache (${stale.length} bar) — exchange tidak terjangkau`);
          return stale;
        }
      } catch { /* abaikan */ }
    }

    // 3. Fallback simulasi — coba ambil harga terkini dulu via ticker (juga public),
    //    sehingga ATR / SL / TP simulasi tetap proporsional dengan harga nyata.
    let seedPrice = null;
    try {
      const ticker = await this.client.getTicker(this.config.symbol);
      if (ticker?.last && ticker.last > 0) {
        seedPrice = ticker.last;
        this._log("info", `Simulasi candle — seed price dari ticker: $${seedPrice.toLocaleString()}`);
      }
    } catch { /* ticker juga gagal — gunakan harga hardcode sebagai last resort */ }

    return this._generateDryRunCandles(seedPrice);
  }

  // seedPrice: harga real dari ticker (null = tidak tersedia, pakai hardcode per simbol)
  _generateDryRunCandles(seedPrice = null, n = 200) {
    // Harga hardcode hanya sebagai LAST RESORT jika ticker dan OHLCV keduanya gagal
    const FALLBACK_PRICES = {
      BTCUSDT: 65000,
      ETHUSDT: 3500,
      SOLUSDT: 160,
      BNBUSDT: 650,
    };
    const sym   = (this.config.symbol || "BTCUSDT").replace("/", "").replace(":USDT", "");
    let price   = seedPrice ?? FALLBACK_PRICES[sym] ?? 100;

    const candles = [];
    const now = Date.now();
    const intervalMs = this.config.interval === "1H" ? 3600000
      : this.config.interval === "4H" ? 14400000 : 86400000;

    let trend = 0.0005;
    for (let i = n; i >= 0; i--) {
      if (i % 40 === 0) trend = (Math.random() - 0.5) * 0.003;
      const change = trend + (Math.random() - 0.5) * 0.025;
      const open   = price;
      const close  = Math.max(price * (1 + change), price * 0.8);
      candles.push({
        timestamp: now - i * intervalMs,
        date:      new Date(now - i * intervalMs).toISOString(),
        open:      +open.toFixed(2),
        high:      +(Math.max(open, close) * (1 + Math.random() * 0.008)).toFixed(2),
        low:       +(Math.min(open, close) * (1 - Math.random() * 0.008)).toFixed(2),
        close:     +close.toFixed(2),
        volume:    Math.random() * 1000,
      });
      price = close;
    }
    return candles;
  }

  // ─────────────────────────────────────────────
  // HANDLE SIGNAL — simpan trade ke DB
  // ─────────────────────────────────────────────
  /**
   * @param {object} options
   *   slDist {number} — override jarak SL (default: ATR × atrMultiplier).
   *                     Dipakai untuk sideways breakout/retest entry dimana
   *                     SL ditempatkan di tepi range, bukan berbasis ATR.
   */
  async _handleSignal(signal, price, atr, indicatorSnapshot = null, options = {}) {
    if (!atr) { this._log("warn", "ATR tidak tersedia, skip signal"); return; }

    const slDist = options.slDist != null ? options.slDist : atr * this.config.atrMultiplier;
    // tpDist can be overridden independently (used by ADAPTIVE_FUSION per-component RR)
    const tpDist = options.tpDist != null ? options.tpDist : slDist * this.config.riskReward;
    const sl = signal === "LONG" ? price - slDist : price + slDist;
    const tp = signal === "LONG" ? price + tpDist : price - tpDist;

    // ── Atribusi strategi per-trade (TASK 2.3 — Multi-Strategy per Coin) ───────
    // Tiap engine (termasuk yang di-spawn MultiStrategyCoordinator) punya satu
    // strategyKey. Simpan atribusi eksplisit + SL/TP + multiplier ke snapshot
    // indikator yang dipersist di kolom trades.indicators agar setiap trade bisa
    // ditelusuri ke strategi yang memfire-nya (AC-04).
    const enrichedSnapshot = {
      ...(indicatorSnapshot || {}),
      ...buildTradeAttribution({
        strategyKey: this.config.strategyKey,
        sl, tp, slDist, tpDist, atr,
      }),
    };

    // Tentukan modal acuan untuk sizing.
    // LIVE: WAJIB dari balance exchange yang valid. Jika gagal/0 → ABORT trade.
    // Jangan pernah pakai angka hardcoded di live: akun kecil bisa 10x oversize
    // → likuidasi langsung. (SEV1 #2)
    let availCap;
    if (this.config.dryRun) {
      availCap = this.state.capital;
    } else {
      try {
        const bal = await this.client.getBalance(this.config.marginCoin);
        availCap  = bal.available;
        // Bagikan equity akun ke koordinator margin lintas-bot (#5)
        if (this.config.coordinator) {
          this.config.coordinator.setAccountEquity(bal.equity > 0 ? bal.equity : bal.available);
        }
      } catch (e) {
        this._log("error", `Balance gagal dibaca — skip entry demi keamanan (${e.message})`);
        return;
      }
      if (!Number.isFinite(availCap) || availCap <= 0) {
        this._log("warn", `Balance tidak valid (${availCap}) — skip entry`);
        return;
      }
    }

    const size = calcPositionSize(availCap, this.config.riskPerTrade, price, sl);
    if (size <= 0) { this._log("warn", "Position size terlalu kecil, skip signal"); return; }

    // ── Minimum lot size Bitget — flexible leverage guard ─────────────────────
    // Jika size < minLot, coba pakai minLot dan hitung risk aktualnya.
    // Kalau risk aktual masih ≤ maxRiskPerTrade → tetap buka (jangan lewatkan momentum).
    // Kalau risk aktual > maxRiskPerTrade → skip (terlalu berisiko).
    const MIN_LOT = { BTCUSDT: 0.001, ETHUSDT: 0.01, SOLUSDT: 0.1, BNBUSDT: 0.01 };
    const sym     = (this.config.symbol || "").replace("/", "").replace(":USDT", "");
    const minLot  = MIN_LOT[sym] ?? 0.001;

    let finalSize    = size;
    let actualRiskPct = this.config.riskPerTrade;

    if (finalSize < minLot) {
      const riskIfMinLot = (minLot * Math.abs(price - sl)) / availCap;
      // Batas penerimaan min-lot dibuat lebih ketat (#11): maksimal 2x risk normal,
      // dan tidak boleh melewati maxRiskPerTrade. Sebelumnya boleh sampai 5% (5x niat).
      const minLotRiskCap = Math.min(this.config.maxRiskPerTrade, this.config.riskPerTrade * 2);
      if (riskIfMinLot <= minLotRiskCap) {
        finalSize    = minLot;
        actualRiskPct = riskIfMinLot;
        this._log("info",
          `Size ideal ${size.toFixed(4)} < min lot ${minLot} ${sym} → pakai min lot. ` +
          `Risk aktual: ${(riskIfMinLot * 100).toFixed(2)}% (batas: ${(minLotRiskCap * 100).toFixed(2)}%)`
        );
      } else {
        this._log("warn",
          `Size ideal ${size.toFixed(4)} < min lot ${minLot} ${sym}. ` +
          `Risk jika pakai min lot: ${(riskIfMinLot * 100).toFixed(2)}% > batas ${(minLotRiskCap * 100).toFixed(2)}% → skip. ` +
          `(Butuh modal ~$${((minLot * Math.abs(price - sl)) / this.config.riskPerTrade).toFixed(2)} untuk trade ${sym} normal)`
        );
        return;
      }
    }
    // Ganti variabel size → finalSize untuk sisa kode di bawah

    // ── Koordinasi margin lintas-bot (#5) ─────────────────────────────────────
    // Margin awal = notional / leverage. Cek anggaran akun BERSAMA sebelum buka,
    // supaya beberapa bot di akun yang sama tidak over-commit → likuidasi.
    const lev            = this.config.leverage || 1;
    const requiredMargin = (price * finalSize) / lev;
    const botKey         = this.config.botKey || `${this.config.userId ?? "anon"}:${this.config.symbol}`;
    // Group guard berlaku di LIVE (anggaran margin + 1/simbol + direction lock) dan
    // juga di DRY RUN bila engine ini bagian dari grup multi-strategi — agar AC-05
    // (tidak ada LONG+SHORT serentak pada satu koin) tetap ditegakkan saat staging
    // dry-run. Di dry-run, gate anggaran otomatis di-skip (equity akun = 0).
    const useGroupGuard = this.config.coordinator &&
      (this.config.groupKey || !this.config.dryRun);
    if (useGroupGuard) {
      const verdict = this.config.coordinator.canOpen({
        botKey, symbol: this.config.symbol, requiredMargin,
        // Multi-Strategy per Coin: groupKey mengizinkan >1 posisi/simbol untuk
        // strategi segrup, direction menegakkan direction lock (AC-05).
        groupKey:  this.config.groupKey ?? null,
        direction: signal,
      });
      if (!verdict.ok) {
        this._log("warn", `🚦 Entry ditahan koordinator akun: ${verdict.reason}`);
        return;
      }
    }

    // Increment trade counter harian
    this.state.dailyTradeCount += 1;

    this._sep(`SINYAL ${signal}`);
    this._log("trade", `SINYAL: ${signal} ${this.config.symbol}`);
    this._log("trade", `Entry: $${price.toLocaleString()} | SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)} | Size: ${finalSize} | Risk: ${(actualRiskPct * 100).toFixed(2)}%`);
    this._log("info",  `📊 Trade hari ini: ${this.state.dailyTradeCount}/${this.config.maxTradesPerDay} | Loss beruntun: ${this.state.consecLoss}/${this.config.maxConsecLoss}`);

    const openTime = Date.now();

    if (!this.config.dryRun) {
      try {
        const side     = signal === "LONG" ? "open_long" : "open_short";
        const holdSide = signal === "LONG" ? "long" : "short";

        // ── Buka posisi + embed preset SL/TP atomik (CCXT v4.5 Bitget V2) ──────
        const order = await this.client.openPosition(
          this.config.symbol, side, finalSize, "USDT", sl.toFixed(2), tp.toFixed(2)
        );
        this._log("trade", `Order terkirim! ID: ${order?.orderId || "N/A"}`);

        // Reservasi margin di koordinator akun bersama (#5)
        if (this.config.coordinator) {
          this.config.coordinator.reserve(botKey, {
            symbol: this.config.symbol, margin: requiredMargin,
            groupKey: this.config.groupKey ?? null,
            strategyKey: this.config.strategyKey ?? null,
            direction: signal,
          });
        }

        const pos = {
          id: order?.orderId, side: signal, entry: price, sl, tp, size: finalSize, openTime, atr, manualSLTP: false,
          marginReserved: requiredMargin,
          // SL+ tracking
          remainingSize: finalSize,
          R:             slDist,   // 1R = jarak SL asli dari entry
          slCurrent:     sl,       // SL aktif saat ini (bergerak setelah milestone)
          m1: false,               // +1R milestone: partial 40%, SL → BEP
          m2: false,               // +2R milestone: partial 27.5%, SL → +1R
          m3: false,               // +3R: biarkan menuju TP
        };

        // Verifikasi apakah preset SL/TP berhasil di-embed
        if (order?.presetSLTP) {
          this._log("trade", `SL/TP di-embed dalam order ✓ | SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)}`);
        } else {
          // Fallback: pasang SL/TP terpisah jika preset tidak tersupport / gagal
          this._log("info", `Preset SL/TP tidak terkonfirmasi, pasang terpisah via plan order...`);
          await new Promise(r => setTimeout(r, 2000));

          let slOk = false, tpOk = false;
          let slErr = "", tpErr = "";

          for (let attempt = 1; attempt <= 3; attempt++) {
            if (!slOk) {
              const r = await this.client.setTPSL(this.config.symbol, "loss_plan",   sl.toFixed(2), holdSide, finalSize);
              slOk = r.success;
              if (!slOk) slErr = r.message || "unknown";
            }
            if (!tpOk) {
              const r = await this.client.setTPSL(this.config.symbol, "profit_plan", tp.toFixed(2), holdSide, finalSize);
              tpOk = r.success;
              if (!tpOk) tpErr = r.message || "unknown";
            }
            if (slOk && tpOk) break;
            if (attempt < 3) {
              this._log("info", `SL/TP attempt ${attempt} gagal, retry dalam 3s...`);
              await new Promise(r => setTimeout(r, 3000));
            }
          }

          if (slOk && tpOk) {
            this._log("trade", `SL/TP dipasang ✓ | SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)}`);
          } else if (!slOk) {
            // SL TIDAK terkonfirmasi = posisi telanjang (kerugian tak terbatas).
            // Perlakukan sebagai kondisi fatal: TUTUP posisi segera, jangan andalkan
            // monitor manual (bergantung tick ≤60s + harga basi). (SEV1 #4)
            if (!slOk) this._log("error", `SL gagal: ${slErr}`);
            if (!tpOk) this._log("error", `TP gagal: ${tpErr}`);
            this._log("error", `🚨 SL tidak terkonfirmasi — TUTUP posisi darurat (anti naked position)`);
            try {
              const closeSide = signal === "LONG" ? "close_long" : "close_short";
              await this.client.closePosition(this.config.symbol, closeSide, finalSize);
              this._log("warn", `Posisi ${signal} ditutup darurat ✓ — tidak ada order tanpa SL`);
              // Posisi sudah ditutup → lepas reservasi margin di koordinator (#5)
              if (this.config.coordinator) this.config.coordinator.release(botKey);
              notifier.notifyClose?.({
                symbol: this.config.symbol, side: signal, entryPrice: price,
                exitPrice: price, pnl: 0, pnlPct: 0, reason: "SL_FAILED_EMERGENCY_CLOSE",
                dryRun: false,
              });
            } catch (closeErr) {
              // Gagal tutup pun → JANGAN catat sebagai posisi sehat. Tandai manual +
              // alert keras agar operator turun tangan.
              this._log("error", `‼️ GAGAL tutup darurat: ${closeErr.message} — INTERVENSI MANUAL DIPERLUKAN di exchange!`);
              pos.manualSLTP = true;
              pos.slFailed   = true;
            }
            // Jika berhasil ditutup, hentikan pemrosesan posisi ini (jangan simpan/track)
            if (!pos.slFailed) return;
          } else {
            // TP gagal tapi SL OK — tidak fatal (downside terlindungi). Monitor manual TP.
            this._log("error", `TP gagal: ${tpErr}`);
            this._log("warn", `⚠️ TP GAGAL (SL ✓) — bot monitor TP manual`);
            pos.manualSLTP = true;
          }
        }

        // Simpan ke DB
        if (this.sessionId) {
          pos.dbId = await db.insertTrade({
            sessionId:  this.sessionId,
            exchange:   this.config.exchange,
            symbol:     this.config.symbol,
            side:       signal,
            entryPrice: price,
            sl, tp, size: finalSize, openTime, atr,
            dryRun:     false,
            orderId:    order?.orderId,
            indicators: enrichedSnapshot,
          });
        }

        this.state.openPositions.push(pos);

        // Notifikasi Telegram — open posisi live
        notifier.notifyOpen({
          symbol:     this.config.symbol,
          side:       signal,
          entryPrice: price,
          size:       finalSize,
          sl, tp,
          leverage:   this.config.leverage,
          dryRun:     false,
        });
      } catch (err) {
        this._log("error", `Gagal buka posisi: ${err.message}`);
      }
    } else {
      this._log("trade", "[DRY RUN] Order tidak dikirim ke exchange");
      // Margin yang "dikunci" disimpan persis di posisi (#9) agar saat close
      // dikembalikan dalam jumlah yang sama — sebelumnya open & close memakai
      // rumus berbeda → equity simulasi drift.
      const marginReserved = availCap * actualRiskPct;
      this.state.capital -= marginReserved;

      const pos = {
        id: `dry_${openTime}`, side: signal, entry: price, sl, tp, size: finalSize, openTime, atr,
        marginReserved,        // margin terkunci, dikembalikan tepat saat close
        // SL+ tracking
        remainingSize: finalSize,
        R:             slDist,
        slCurrent:     sl,
        m1: false, m2: false, m3: false,
      };

      // Dry-run multi-strategi: reservasi di koordinator agar direction lock (AC-05)
      // terlihat oleh engine strategi lain pada koin yang sama. Dilepas otomatis
      // saat flat via _releaseMarginIfFlat(). Legacy dry-run (tanpa groupKey) tidak
      // mereservasi apa pun — perilaku lama tidak berubah.
      if (this.config.groupKey && this.config.coordinator) {
        this.config.coordinator.reserve(botKey, {
          symbol: this.config.symbol, margin: marginReserved,
          groupKey: this.config.groupKey, strategyKey: this.config.strategyKey, direction: signal,
        });
      }

      // Simpan ke DB (dry run)
      if (this.sessionId) {
        pos.dbId = await db.insertTrade({
          sessionId:  this.sessionId,
          exchange:   this.config.exchange,
          symbol:     this.config.symbol,
          side:       signal,
          entryPrice: price,
          sl, tp, size: finalSize, openTime, atr,
          dryRun:     true,
          orderId:    pos.id,
          indicators: indicatorSnapshot,
        });
      }

      this.state.openPositions.push(pos);

      // Notifikasi Telegram — open posisi dry run
      notifier.notifyOpen({
        symbol:     this.config.symbol,
        side:       signal,
        entryPrice: price,
        size:       finalSize,
        sl, tp,
        leverage:   this.config.leverage,
        dryRun:     true,
      });
    }
  }

  // ─────────────────────────────────────────────
  // SIDEWAYS MODE — BREAKOUT (Strat B) + RETEST (Strat C)
  // ─────────────────────────────────────────────

  /**
   * Handler utama saat HTF = SIDEWAYS.
   * Dipanggil dari _tick() menggantikan detectSignal() biasa.
   *
   * Strat A (PDF_SCALPING)    → diam total, 1m terlalu noise saat 15m sideways
   * Strat B (PDF_DAYTRADING)  → breakout langsung jika candle HTF close keluar range
   * Strat C (PDF_SWING)       → tunggu breakout valid, lalu entry setelah retest
   */
  async _checkSidewaysEntry(htfCandles, price, atr, indicators, lastIdx, emaF, emaS, emaTrend, rsi) {
    const signalType = this.config.signalType;

    // ── Strat A: diam total ────────────────────────────────────────────────────
    if (signalType === "PDF_SCALPING") {
      if (this.state.checkCount % 10 === 1) {
        this._log("info", `📊 [${this.config.strategyKey}] HTF ${this.config.higherTf} SIDEWAYS — menunggu trend jelas (Strat A diam)`);
      }
      return;
    }

    const boConfig = {
      rangeLookback:  this.config.sidewaysRangeLookback,
      volMultiplier:  this.config.sidewaysBreakoutVolMult,
      bufferAtrMult:  this.config.sidewaysBreakoutBufMult,
      htfEmaFast:     this.config.htfEmaFast,
      htfEmaSlow:     this.config.htfEmaSlow,
    };

    // ── Strat B: breakout langsung ─────────────────────────────────────────────
    if (signalType === "PDF_DAYTRADING") {
      const bo = detectSidewaysBreakout(htfCandles, boConfig);

      if (!bo) {
        if (this.state.checkCount % 10 === 1) {
          this._log("info", `📊 [${this.config.strategyKey}] HTF ${this.config.higherTf} SIDEWAYS — menunggu breakout range`);
        }
        return;
      }

      // Pastikan sinyal tidak duplikat dari entry terakhir
      if (bo.signal === this.state.lastSignal) return;

      this._log("trade",
        `🔥 BREAKOUT SIDEWAYS ${bo.signal}! ` +
        `Range [${bo.rangeLow.toFixed(2)}–${bo.rangeHigh.toFixed(2)}] ditembus`
      );

      // SL ditempatkan di balik tepi range (bukan ATR dari entry)
      const slDist = Math.abs(price - bo.rangeEdge) + bo.atr * 0.5;

      const vol    = indicators.volumes[lastIdx] ?? 0;
      const volSMA = indicators.volSMA[lastIdx]  ?? 1;
      const snap   = {
        rsi:          rsi  != null ? parseFloat(rsi.toFixed(2))   : null,
        atr:          atr  != null ? parseFloat(atr.toFixed(4))   : null,
        atrPct:       atr && price ? parseFloat(((atr / price) * 100).toFixed(3)) : null,
        emaFast:      emaF != null ? parseFloat(emaF.toFixed(4))  : null,
        emaSlow:      emaS != null ? parseFloat(emaS.toFixed(4))  : null,
        emaTrendVal:  emaTrend != null ? parseFloat(emaTrend.toFixed(4)) : null,
        emaTrendBias: emaTrend != null ? (price > emaTrend ? "bullish" : "bearish") : null,
        volumeRatio:  volSMA > 0 ? parseFloat((vol / volSMA).toFixed(2)) : null,
        htfTrend:     "SIDEWAYS",
        strategy:     this.config.strategyKey,
        entryMode:    "sideways_breakout",
        rangeHigh:    +bo.rangeHigh.toFixed(4),
        rangeLow:     +bo.rangeLow.toFixed(4),
      };

      await this._handleSignal(bo.signal, price, atr, snap, { slDist });
      this.state.lastSignal = bo.signal;
      return;
    }

    // ── Strat C: retest entry ──────────────────────────────────────────────────
    if (signalType === "PDF_SWING") {
      // Belum ada breakout tersimpan → cari dulu
      if (!this.state.sidewaysBreakout) {
        const bo = detectSidewaysBreakout(htfCandles, boConfig);
        if (bo) {
          this.state.sidewaysBreakout = { ...bo, detectedAt: Date.now() };
          this._log("info",
            `⏳ [${this.config.strategyKey}] Breakout ${bo.signal} terdeteksi ` +
            `@ range edge ${bo.rangeEdge.toFixed(2)} — menunggu retest...`
          );
        } else if (this.state.checkCount % 10 === 1) {
          this._log("info", `📊 [${this.config.strategyKey}] HTF ${this.config.higherTf} SIDEWAYS — menunggu breakout + retest`);
        }
        return;
      }

      // Ada breakout tersimpan: timeout check (10 × checkInterval)
      const timeout = this.config.checkInterval * 10;
      if (Date.now() - this.state.sidewaysBreakout.detectedAt > timeout) {
        this._log("info", `⏰ [${this.config.strategyKey}] Breakout timeout — reset state sideways`);
        this.state.sidewaysBreakout = null;
        return;
      }

      // Cek retest atau false breakout
      const retestResult = this._checkRetestEntry(price, atr);

      if (retestResult === null) {
        // False breakout: harga kembali ke dalam range
        this._log("warn",
          `❌ [${this.config.strategyKey}] Breakout ${this.state.sidewaysBreakout.signal} INVALID ` +
          `— harga balik ke range. Reset.`
        );
        this.state.sidewaysBreakout = null;
        return;
      }

      if (retestResult === false) {
        // Belum retest, masih dalam mode tunggu
        if (this.state.checkCount % 5 === 1) {
          const bo = this.state.sidewaysBreakout;
          this._log("info",
            `⏳ [${this.config.strategyKey}] Menunggu retest ke ` +
            `${bo.signal === "LONG" ? `area ${bo.rangeHigh.toFixed(2)}` : `area ${bo.rangeLow.toFixed(2)}`}...`
          );
        }
        return;
      }

      // Retest valid → entry!
      const bo     = this.state.sidewaysBreakout;
      const slDist = bo.signal === "LONG"
        ? price - (bo.rangeLow - bo.atr * 0.3)         // SL di bawah range low
        : (bo.rangeHigh + bo.atr * 0.3) - price;       // SL di atas range high

      this._log("trade",
        `🎯 [${this.config.strategyKey}] RETEST VALID! ${bo.signal} @ $${price.toFixed(2)} ` +
        `(range edge: $${bo.rangeEdge.toFixed(2)} | SL dist: $${slDist.toFixed(2)})`
      );

      const vol    = indicators.volumes[lastIdx] ?? 0;
      const volSMA = indicators.volSMA[lastIdx]  ?? 1;
      const snap   = {
        rsi:          rsi  != null ? parseFloat(rsi.toFixed(2))   : null,
        atr:          atr  != null ? parseFloat(atr.toFixed(4))   : null,
        atrPct:       atr && price ? parseFloat(((atr / price) * 100).toFixed(3)) : null,
        emaFast:      emaF != null ? parseFloat(emaF.toFixed(4))  : null,
        emaSlow:      emaS != null ? parseFloat(emaS.toFixed(4))  : null,
        emaTrendVal:  emaTrend != null ? parseFloat(emaTrend.toFixed(4)) : null,
        emaTrendBias: emaTrend != null ? (price > emaTrend ? "bullish" : "bearish") : null,
        volumeRatio:  volSMA > 0 ? parseFloat((vol / volSMA).toFixed(2)) : null,
        htfTrend:     "SIDEWAYS",
        strategy:     this.config.strategyKey,
        entryMode:    "sideways_retest",
        rangeHigh:    +bo.rangeHigh.toFixed(4),
        rangeLow:     +bo.rangeLow.toFixed(4),
      };

      this.state.sidewaysBreakout = null;   // clear setelah entry
      await this._handleSignal(bo.signal, price, atr, snap, { slDist });
      this.state.lastSignal = bo.signal;
    }
  }

  /**
   * Cek apakah harga sudah memasuki zona retest dari breakout tersimpan.
   *
   * @returns {true}  — retest valid, lanjut entry
   * @returns {false} — belum retest, masih tunggu
   * @returns {null}  — false breakout (harga balik ke dalam range), harus reset
   */
  _checkRetestEntry(price, atr) {
    const bo = this.state.sidewaysBreakout;
    if (!bo) return null;

    const { signal, rangeHigh, rangeLow, buffer, atr: boAtr } = bo;
    const retestTolerance = (boAtr || atr) * 0.5;  // seberapa dekat ke range edge = valid retest

    if (signal === "LONG") {
      // False breakout: harga balik jauh ke dalam range (di bawah rangeLow + buffer)
      if (price < rangeLow + buffer) return null;

      // Retest zone: harga kembali mendekati rangeHigh dari atas
      // [rangeHigh - tolerance, rangeHigh + buffer]
      const retestLow  = rangeHigh - retestTolerance;
      const retestHigh = rangeHigh + buffer;
      if (price >= retestLow && price <= retestHigh) return true;

      return false;  // Masih di atas range, belum pullback ke retest area
    }

    if (signal === "SHORT") {
      // False breakout: harga balik jauh ke dalam range (di atas rangeHigh - buffer)
      if (price > rangeHigh - buffer) return null;

      // Retest zone: harga kembali mendekati rangeLow dari bawah
      // [rangeLow - buffer, rangeLow + tolerance]
      const retestLow  = rangeLow - buffer;
      const retestHigh = rangeLow + retestTolerance;
      if (price >= retestLow && price <= retestHigh) return true;

      return false;  // Masih di bawah range, belum pullback ke retest area
    }

    return false;
  }

  // ─────────────────────────────────────────────
  // SL+ — TRAILING PARTIAL TAKE PROFIT
  // Dipanggil setiap tick untuk setiap posisi terbuka.
  // ─────────────────────────────────────────────

  /**
   * Periksa milestone +1R / +2R / +3R dan eksekusi partial close + geser SL.
   * @param {object} pos   — item dari this.state.openPositions
   * @param {number} price — harga penutupan candle terakhir
   */
  async _checkSLPlusMilestones(pos, price) {
    if (!this.config.slPlusEnabled) return;
    if (pos.remainingSize <= 0) return;

    const R     = pos.R;
    const gain  = pos.side === "LONG" ? price - pos.entry : pos.entry - price;
    const rMult = gain / R;

    // Minimum lot per simbol — partial di bawah ini ditolak exchange
    const MIN_LOT = { BTCUSDT: 0.001, ETHUSDT: 0.01, SOLUSDT: 0.1, BNBUSDT: 0.01 };
    const sym     = (this.config.symbol || "").replace("/", "").replace(":USDT", "");
    const minLot  = MIN_LOT[sym] ?? 0.001;

    // ── Milestone 1: +1R → partial 40%, SL ke BEP ───────────────────────────
    if (!pos.m1 && rMult >= 1.0) {
      const pct     = this.config.slPlusPartial1Pct;
      const partial = parseFloat((pos.size * pct).toFixed(8));
      const newSL   = pos.entry; // Break-Even Point
      pos.m1 = true;

      if (partial >= minLot) {
        await this._executePartialClose(pos, price, partial, "Partial_1R", newSL, "BEP");
      } else {
        // Size terlalu kecil untuk partial — geser SL ke BEP saja agar tetap terlindungi
        this._log("info",
          `SL+ M1: partial ${partial.toFixed(4)} < min lot ${minLot} ${sym} ` +
          `— skip partial, SL digeser ke BEP $${newSL.toFixed(2)} ✓`
        );
        pos.slCurrent = newSL;
        if (!this.config.dryRun) await this._updateSLOnExchange(pos, newSL);
      }
    }

    // ── Milestone 2: +2R → partial 27.5% of ORIGINAL, SL ke +1R ────────────
    if (pos.m1 && !pos.m2 && rMult >= 2.0) {
      const pct          = this.config.slPlusPartial2Pct;
      const fromOriginal = parseFloat((pos.size * pct).toFixed(8));
      const partial      = Math.min(fromOriginal, parseFloat((pos.remainingSize * 0.90).toFixed(8)));
      const newSL        = pos.side === "LONG" ? pos.entry + R : pos.entry - R; // +1R
      pos.m2 = true;

      if (partial >= minLot) {
        await this._executePartialClose(pos, price, partial, "Partial_2R", newSL, "+1R");
      } else {
        this._log("info",
          `SL+ M2: partial ${partial.toFixed(4)} < min lot ${minLot} ${sym} ` +
          `— skip partial, SL digeser ke +1R $${newSL.toFixed(2)} ✓`
        );
        pos.slCurrent = newSL;
        if (!this.config.dryRun) await this._updateSLOnExchange(pos, newSL);
      }
    }

    // ── Milestone 3: +3R → log saja, biarkan sisa ke TP ────────────────────
    if (pos.m1 && pos.m2 && !pos.m3 && rMult >= 3.0) {
      pos.m3 = true;
      const remaining = pos.remainingSize;
      this._sep(`SL+ MILESTONE +3R`);
      this._log("trade", `🎯 ${pos.side} +3R tercapai! Sisa ${remaining.toFixed(4)} unit menuju TP $${pos.tp?.toFixed(2) || "N/A"}`);
      this._log("info",  `SL terkunci di +1R ($${pos.slCurrent?.toFixed(2)}) — posisi tidak bisa rugi`);
    }
  }

  /**
   * Eksekusi partial close + geser SL ke level baru.
   */
  async _executePartialClose(pos, price, partialSize, reason, newSL, newSLLabel) {
    if (partialSize <= 0) return;

    const pnl    = pos.side === "LONG"
      ? (price - pos.entry) * partialSize
      : (pos.entry - price) * partialSize;
    const pnlPct = ((price - pos.entry) / pos.entry) * 100 * (pos.side === "LONG" ? 1 : -1);
    const fee    = await this._resolveFee(pos, price, partialSize);

    this._sep(`SL+ ${reason}`);
    this._log("trade", `PARTIAL CLOSE [${reason}] ${pos.side} — ${partialSize.toFixed(4)} unit @ $${price.toFixed(2)}`);
    this._log("trade", `PnL partial gross: +$${pnl.toFixed(2)} | Fee: -$${fee.toFixed(4)} | Net: +$${(pnl - fee).toFixed(2)} | SL → $${newSL.toFixed(2)} (${newSLLabel})`);

    if (!this.config.dryRun) {
      // ── Partial close di exchange ──────────────────────────────────────────
      try {
        const closeSide = pos.side === "LONG" ? "close_long" : "close_short";
        await this.client.closePosition(this.config.symbol, closeSide, partialSize);
        this._log("trade", `Partial close terkirim ke exchange ✓`);
      } catch (e) {
        this._log("error", `Partial close gagal: ${e.message} — skip milestone`);
        return; // jangan geser SL jika partial close gagal
      }

      // ── Update SL di exchange ──────────────────────────────────────────────
      await this._updateSLOnExchange(pos, newSL);
    }

    // ── Update state posisi ──────────────────────────────────────────────────
    pos.remainingSize = parseFloat((pos.remainingSize - partialSize).toFixed(8));
    pos.slCurrent     = newSL;
    pos.sl            = newSL; // update SL aktif (dry-run monitoring pakai pos.sl)

    // ── Catat partial di state.trades ────────────────────────────────────────
    this.state.trades.push({
      ...pos,
      size:      partialSize,
      exit:      price,
      pnl,
      pnlPct,
      fee,
      reason,
      closedAt:  Date.now(),
      partial:   true,
    });
    this._updateRiskAfterClose(pnl);

    // ── Catat ke DB (insert + langsung close) ────────────────────────────────
    if (this.sessionId) {
      try {
        const partialDbId = await db.insertTrade({
          sessionId:  this.sessionId,
          exchange:   this.config.exchange,
          symbol:     this.config.symbol,
          side:       pos.side,
          entryPrice: pos.entry,
          sl:         pos.sl,
          tp:         pos.tp,
          size:       partialSize,
          openTime:   pos.openTime,
          atr:        pos.atr,
          dryRun:     this.config.dryRun,
          orderId:    `${pos.id}_${reason}`,
        });
        await db.closeTrade(partialDbId, {
          exitPrice: price,
          pnl,
          pnlPct,
          fee,
          reason,
          closeTime: new Date().toISOString(),
        });
      } catch { /* jangan crash */ }
    }

    // ── Notifikasi Telegram ──────────────────────────────────────────────────
    notifier.notifyClose({
      symbol:     this.config.symbol,
      side:       pos.side,
      entryPrice: pos.entry,
      exitPrice:  price,
      pnl,
      pnlPct,
      reason:     `${reason} — SL pindah ke ${newSLLabel} ($${newSL.toFixed(2)})`,
      dryRun:     this.config.dryRun,
    });
  }

  /**
   * Cancel SL lama di Bitget lalu pasang SL baru.
   * TP di-repassang agar tidak hilang saat cancel.
   */
  async _updateSLOnExchange(pos, newSL) {
    const holdSide  = pos.side === "LONG" ? "long" : "short";
    const remaining = pos.remainingSize;

    try {
      // Cancel semua plan order (SL + TP) yang ada
      await this.client.cancelAllPlanOrders(this.config.symbol);
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      this._log("warn", `Cancel plan orders: ${e.message}`);
    }

    // Re-pasang SL baru
    const slRes = await this.client.setTPSL(this.config.symbol, "loss_plan", newSL.toFixed(2), holdSide, remaining);
    if (slRes.success) {
      this._log("trade", `SL baru terpasang @ $${newSL.toFixed(2)} ✓`);
    } else {
      this._log("warn", `SL update gagal: ${slRes.message}`);
    }

    // Re-pasang TP asli (untuk sisa posisi)
    if (pos.tp) {
      await this.client.setTPSL(this.config.symbol, "profit_plan", pos.tp.toFixed(2), holdSide, remaining);
    }
  }

  // ─────────────────────────────────────────────
  // CHECK OPEN POSITIONS — tutup trade di DB
  // ─────────────────────────────────────────────
  async _checkOpenPositions(price, atr) {
    if (this.state.openPositions.length === 0) return;

    if (!this.config.dryRun) {
      try {
        const live      = await this.client.getPositions(this.config.symbol);
        const liveByKey = new Map(live.map(p => [p.side, p]));

        // Posisi yang ada di state tapi tidak lagi di exchange (SL/TP hit)
        const closedLocal = this.state.openPositions.filter(p => !liveByKey.has(p.side));
        // Set sesi yang perlu di-recalc (cross-session restoration)
        const sessionsToRecalc = new Set();

        for (const pos of closedLocal) {
          const remaining = pos.remainingSize > 0 ? pos.remainingSize : pos.size;

          // ── Dapatkan exit price AKTUAL + resolve reason ke "TP" / "SL" ─────────
          // Penting: frontend hanya kenal reason "TP", "SL", "Exchange".
          // Backend harus resolve ke salah satu dari 3 string ini.
          let exitPrice   = null;
          let exitReason  = "Exchange";   // default: tidak tahu SL atau TP
          let priceSource = "tick";

          const posSL = pos.sl || 0;
          const posTP = pos.tp || 0;

          // Util: tentukan reason berdasarkan harga vs SL/TP posisi
          const resolveReason = (px) => {
            if (!posSL || !posTP) return "Exchange";
            // Toleransi 0.5% dari entry untuk menganggap "hit"
            const tol = pos.entry * 0.005;
            if (Math.abs(px - posTP) <= tol) return "TP";
            if (Math.abs(px - posSL) <= tol) return "SL";
            // Fallback: paling dekat ke mana?
            return Math.abs(px - posSL) < Math.abs(px - posTP) ? "SL" : "TP";
          };

          // 1. Coba ambil actual fill price dari exchange
          if (this.client.getRecentFillPrice) {
            exitPrice = await this.client.getRecentFillPrice(
              this.config.symbol,
              pos.side,
              typeof pos.openTime === "number" ? pos.openTime : Date.parse(pos.openTime || 0)
            );
            if (exitPrice) {
              priceSource = "exchange_fill";
              exitReason  = resolveReason(exitPrice);
            }
          }

          // 2. Fill price tidak tersedia → estimasi dari SL/TP berdasarkan harga tick
          if (!exitPrice) {
            if (posSL && posTP) {
              const dSL = Math.abs(price - posSL);
              const dTP = Math.abs(price - posTP);
              if (dSL < dTP) {
                exitPrice  = posSL;
                exitReason = "SL";
              } else {
                exitPrice  = posTP;
                exitReason = "TP";
              }
              priceSource = "sl_tp_estimate";
            } else {
              exitPrice   = price;
              exitReason  = "Exchange";
              priceSource = "tick_fallback";
            }
          }

          const pnl = pos.side === "LONG"
            ? (exitPrice - pos.entry) * remaining
            : (pos.entry - exitPrice) * remaining;
          const fee = await this._resolveFee(pos, exitPrice, remaining);

          this._sep(`POSISI DITUTUP — SL/TP Hit di Bitget`);
          this._log("trade", `CLOSE ${pos.side} — ditutup oleh exchange`);
          this._log("trade", `Entry: $${pos.entry} | Exit: $${exitPrice.toFixed(2)} [${priceSource}] | Size sisa: ${remaining.toFixed(4)}`);
          this._log("trade", `PnL gross: ${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)} | Fee: -$${fee.toFixed(4)} | Net: ${pnl - fee > 0 ? "+" : ""}$${(pnl - fee).toFixed(2)} — balance dari exchange`);
          if (pos.m1 || pos.m2) {
            const partialPnL = this.state.trades.filter(t => t.partial && t.id === pos.id).reduce((s, t) => s + (t.pnl || 0), 0);
            this._log("trade", `Total PnL trade ini (partial + sisa): $${(partialPnL + pnl).toFixed(2)}`);
          }

          // Tutup trade record di DB
          if (pos.dbId) {
            try { await db.closeTrade(pos.dbId, { exitPrice, pnl, fee, reason: exitReason, closeTime: new Date().toISOString() }); } catch {}
          }

          // Notifikasi Telegram — SELALU dikirim terlepas dari cross-session atau tidak
          const pnlPct = pos.entry > 0 ? ((exitPrice - pos.entry) / pos.entry * 100 * (pos.side === "LONG" ? 1 : -1)) : 0;
          notifier.notifyClose({
            symbol:     this.config.symbol,
            side:       pos.side,
            entryPrice: pos.entry,
            exitPrice,
            pnl,
            pnlPct,
            reason:     exitReason,
            dryRun:     this.config.dryRun,
          });

          // Catat sesi mana yang perlu diupdate statsnya
          // pos.restoredFrom = sesi asal trade ini (bisa berbeda dari sesi aktif)
          const ownerSession = pos.restoredFrom || this.sessionId;
          sessionsToRecalc.add(ownerSession);

          if (pos.restoredFrom && pos.restoredFrom !== this.sessionId) {
            // Trade dibuka di sesi lama — jangan masuk ke state.trades sesi ini
            // agar _syncSessionStats tidak salah menghitung wins sesi saat ini
            this._log("info", `Trade sesi #${pos.restoredFrom} ditutup di sesi #${this.sessionId} (cross-session) — update sesi asal`);
          } else {
            // Trade milik sesi saat ini — masukkan ke state.trades normal
            this.state.trades.push({ ...pos, size: remaining, exit: exitPrice, pnl, fee, reason: "Exchange", closedAt: Date.now() });
          }

          this._updateRiskAfterClose(pnl);
        }

        // Update stats untuk SETIAP sesi yang terlibat
        for (const sid of sessionsToRecalc) {
          if (sid === this.sessionId) {
            this._syncSessionStats(); // update via state.trades (cepat)
          } else {
            db.recalcSessionStats(sid); // hitung ulang dari DB (untuk sesi lama)
          }
        }

        // Update state: hanya posisi yang masih ada di exchange
        this.state.openPositions = this.state.openPositions.filter(p => liveByKey.has(p.side));
        this._releaseMarginIfFlat(); // lepas margin di koordinator bila sudah flat (#5)

        // Update unrealized PnL + markPrice dari exchange, lalu cek SL+ milestones
        for (const pos of this.state.openPositions) {
          const lp = liveByKey.get(pos.side);
          if (lp) {
            pos.markPrice = lp.markPrice || price;
            // Hitung PnL manual sebagai fallback jika exchange return 0
            const upnlExchange = lp.unrealizedPL ?? 0;
            const markPx       = pos.markPrice;
            const sz           = pos.remainingSize || pos.size || 0;
            const upnlCalc     = markPx > 0 && pos.entry > 0
              ? (pos.side === "LONG"
                  ? (markPx - pos.entry) * sz
                  : (pos.entry - markPx) * sz)
              : 0;
            pos.unrealizedPL = upnlExchange !== 0 ? upnlExchange : upnlCalc;
          }

          // ── SL+ milestone check ────────────────────────────────────────────
          await this._checkSLPlusMilestones(pos, price);

          // Jika SL/TP gagal dipasang tadi, monitor manual sekarang
          if (pos.manualSLTP) {
            const hitSL = pos.side === "LONG" ? price <= pos.sl : price >= pos.sl;
            const hitTP = pos.side === "LONG" ? price >= pos.tp : price <= pos.tp;
            if (hitSL || hitTP) {
              const reason = hitTP ? "TP ✅" : "SL ❌";
              this._log("warn", `Manual close ${pos.side} — ${reason} (manual monitor) @ $${price.toFixed(2)}`);
              try {
                await this.client.closePosition(
                  this.config.symbol,
                  pos.side === "LONG" ? "close_long" : "close_short",
                  pos.size,
                );
                this._log("trade", `Posisi ditutup manual ✓`);
              } catch (e) {
                const isAlreadyClosed =
                  e.message?.includes("22002") ||
                  e.message?.toLowerCase().includes("no position to close") ||
                  e.message?.includes("position not exist");

                if (isAlreadyClosed) {
                  this._log("info", `Posisi ${pos.side} sudah ditutup oleh exchange ✓ (state sync)`);
                  // Coba ambil fill price aktual; fallback ke SL/TP estimate
                  let exitPrice = null;
                  if (this.client.getRecentFillPrice) {
                    exitPrice = await this.client.getRecentFillPrice(
                      this.config.symbol, pos.side,
                      typeof pos.openTime === "number" ? pos.openTime : Date.parse(pos.openTime || 0)
                    );
                  }
                  if (!exitPrice) {
                    // manualSLTP sudah tahu sisi mana yang hit
                    exitPrice = hitTP ? (pos.tp || price) : (pos.sl || price);
                  }
                  const pnl = pos.side === "LONG"
                    ? (exitPrice - pos.entry) * pos.size
                    : (pos.entry - exitPrice) * pos.size;
                  const fee = await this._resolveFee(pos, exitPrice, pos.size);
                  if (pos.dbId) {
                    try { await db.closeTrade(pos.dbId, { exitPrice, pnl, fee, reason: hitTP ? "TP" : "SL", closeTime: new Date().toISOString() }); } catch {}
                  }
                  const ownerSid = pos.restoredFrom || this.sessionId;
                  if (!pos.restoredFrom || pos.restoredFrom === this.sessionId) {
                    this.state.trades.push({ ...pos, exit: exitPrice, pnl, fee, reason: "Exchange", closedAt: Date.now() });
                  }
                  this._updateRiskAfterClose(pnl);
                  this.state.openPositions = this.state.openPositions.filter(p => p.id !== pos.id);
                  this._releaseMarginIfFlat(); // lepas margin di koordinator (#5)
                  if (ownerSid === this.sessionId) this._syncSessionStats();
                  else db.recalcSessionStats(ownerSid);
                } else {
                  this._log("error", `Manual close gagal: ${e.message}`);
                }
              }
            }
          }
        }
      } catch (err) {
        this._log("warn", `Sync positions error: ${err.message} — pakai state lokal`);
      }
      return;
    }

    const toClose = [];
    for (const pos of this.state.openPositions) {
      // ── SL+ milestone check (dry run) ─────────────────────────────────────
      await this._checkSLPlusMilestones(pos, price);

      // Cek SL / TP dengan harga & SL terkini (pos.sl sudah diperbarui oleh milestone)
      const hitTP = pos.side === "LONG" ? price >= pos.tp : price <= pos.tp;
      const hitSL = pos.side === "LONG" ? price <= pos.sl : price >= pos.sl;

      if (hitTP || hitSL) {
        const exitPrice = hitTP ? pos.tp : pos.sl;
        // Pakai remainingSize (bukan size asli) — partial sudah dicatat terpisah
        const remaining = pos.remainingSize > 0 ? pos.remainingSize : pos.size;
        const pnl       = pos.side === "LONG"
          ? (exitPrice - pos.entry) * remaining
          : (pos.entry - exitPrice) * remaining;
        const pnlPct    = ((pnl / (pos.entry * remaining)) * 100);
        const fee       = await this._resolveFee(pos, exitPrice, remaining);

        // Modal pakai NET (#9): kembalikan margin yang DIKUNCI saat open (persis,
        // bukan rumus berbeda), tambah pnl gross, potong fee. Fallback ke rumus
        // lama untuk posisi yang dipulihkan tanpa marginReserved.
        const marginBack = pos.marginReserved != null
          ? pos.marginReserved
          : pos.entry * remaining * this.config.riskPerTrade;
        this.state.capital += pnl - fee + marginBack;
        const reason    = hitTP ? "TP" : "SL";
        const closeTime = Date.now();

        this._sep(`POSISI DITUTUP — ${hitTP ? "TAKE PROFIT ✅" : "STOP LOSS ❌"}`);
        this._log("trade", `CLOSE ${pos.side} — ${hitTP ? "TAKE PROFIT ✅" : "STOP LOSS ❌"}`);
        this._log("trade", `Entry: $${pos.entry} | Exit: $${exitPrice.toFixed(2)} | Size: ${remaining.toFixed(4)}`);
        this._log("trade", `PnL gross: ${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)} | Fee: -$${fee.toFixed(4)} | Net: ${pnl - fee > 0 ? "+" : ""}$${(pnl - fee).toFixed(2)} | Modal: $${this.state.capital.toFixed(2)}`);
        if (pos.m1 || pos.m2) {
          const partialPnL = this.state.trades.filter(t => t.partial && t.id === pos.id).reduce((s, t) => s + (t.pnl || 0), 0);
          this._log("trade", `Total PnL trade ini (partial + sisa): $${(partialPnL + pnl).toFixed(2)}`);
        }

        if (this.sessionId && pos.dbId) {
          try {
            await db.closeTrade(pos.dbId, { exitPrice, pnl, pnlPct, fee, reason, closeTime: new Date(closeTime).toISOString() });
          } catch { /* jangan crash */ }
        }

        notifier.notifyClose({
          symbol:     this.config.symbol,
          side:       pos.side,
          entryPrice: pos.entry,
          exitPrice,
          pnl,
          pnlPct,
          reason,
          dryRun:     this.config.dryRun,
        });

        this.state.trades.push({ ...pos, size: remaining, exit: exitPrice, pnl, pnlPct, fee, reason, closedAt: closeTime });
        this._updateRiskAfterClose(pnl);
        toClose.push(pos.id);
      }
    }
    this.state.openPositions = this.state.openPositions.filter(p => !toClose.includes(p.id));

    // Sync session stats ke DB setelah posisi ditutup (dry run)
    if (toClose.length > 0) this._syncSessionStats();
  }

  // ─────────────────────────────────────────────
  // FEE — estimasi & resolusi biaya trading
  // ─────────────────────────────────────────────
  /**
   * Estimasi fee trading round-trip (entry + exit) dari notional.
   * Fee Bitget dihitung atas notional penuh (harga × size), bukan margin.
   * Inilah penyebab gap "Net PnL gross" vs balance riil: fee tak pernah dikurangi.
   */
  _estimateFee(entryPrice, exitPrice, size) {
    const rate = this.config.feeRate ?? 0.0006;
    const notional = (Math.abs(entryPrice) + Math.abs(exitPrice)) * Math.abs(size);
    return notional * rate;
  }

  /**
   * Tentukan fee untuk satu close.
   * - LIVE: coba fee aktual dari exchange (fetchMyTrades); fallback estimasi.
   * - DRY-RUN/backtest: selalu estimasi notional × feeRate.
   * @returns {Promise<number>} fee absolut (≥0)
   */
  async _resolveFee(pos, exitPrice, size) {
    const estimate = this._estimateFee(pos.entry, exitPrice, size);
    if (this.config.dryRun || !this.client?.getRecentFillFee) return estimate;
    try {
      const openedAt = typeof pos.openTime === "number"
        ? pos.openTime
        : Date.parse(pos.openTime || 0);
      const actual = await this.client.getRecentFillFee(this.config.symbol, openedAt || 0);
      return Number.isFinite(actual) && actual > 0 ? actual : estimate;
    } catch {
      return estimate;
    }
  }

  /**
   * Lepas reservasi margin di koordinator akun bila bot ini sudah FLAT
   * (tidak ada posisi terbuka). Aman dipanggil berkali-kali (idempotent).
   * Tiap bot = 1 simbol = maksimal 1 posisi, jadi flat ⇒ margin bisa dilepas. (#5)
   */
  _releaseMarginIfFlat() {
    if (!this.config.coordinator) return;
    if (this.state.openPositions.length > 0) return;
    const botKey = this.config.botKey || `${this.config.userId ?? "anon"}:${this.config.symbol}`;
    this.config.coordinator.release(botKey);
  }

  // ─────────────────────────────────────────────
  // SYNC SESSION STATS — update DB setelah tiap trade tutup
  // ─────────────────────────────────────────────
  _syncSessionStats() {
    if (!this.sessionId) return;
    try {
      const closed    = this.state.trades.filter(t => !t.partial); // hanya trade utama (bukan partial SL+)
      const wins      = closed.filter(t => t.pnl > 0).length;
      const losses    = closed.filter(t => t.pnl <= 0).length;
      // total_trades = closed saja, open positions belum dihitung agar win rate tidak anomali
      const total     = closed.length;
      // final_capital pakai NET (pnl - fee - funding) agar cocok balance riil
      const tradeNet  = this.state.trades.reduce((s, t) => s + ((t.pnl || 0) - (t.fee || 0) - (t.funding || 0)), 0);
      const finalCap  = this.state.startCapital + tradeNet;
      db.updateSessionStats(this.sessionId, { finalCapital: finalCap, totalTrades: total, wins, losses });
    } catch { /* jangan crash */ }
  }

  // ─────────────────────────────────────────────
  // STATUS REPORT
  // ─────────────────────────────────────────────
  _statusReport() {
    const totalPnL = this.state.trades.reduce((s, t) => s + t.pnl, 0);
    const wins     = this.state.trades.filter(t => t.pnl > 0).length;
    this._sep("STATUS REPORT");
    this._log("info", `Capital: $${this.state.capital.toFixed(2)} | PnL: ${totalPnL > 0 ? "+" : ""}$${totalPnL.toFixed(2)}`);
    this._log("info", `Trades: ${this.state.trades.length} | Wins: ${wins} | WR: ${this._winRate()}%`);
    this._log("info", `Open positions: ${this.state.openPositions.length}`);
    this._sep();
  }

  _winRate() {
    if (this.state.trades.length === 0) return 0;
    const wins = this.state.trades.filter(t => t.pnl > 0).length;
    return ((wins / this.state.trades.length) * 100).toFixed(1);
  }
}

module.exports = BotEngine;
