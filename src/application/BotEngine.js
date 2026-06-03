// ─────────────────────────────────────────────
// src/application/BotEngine.js — Quantara BotEngine
// Class yang bisa di-start/stop oleh server
// Memancarkan event 'log' untuk streaming ke WS
// ─────────────────────────────────────────────

const EventEmitter = require("events");
const { createExchangeClient, getExchangeInfo } = require("../infrastructure/exchange");
const { calcIndicators, detectSignal, detectHTFTrend, calcPositionSize } = require("../domain/indicators");
const { getStrategy } = require("../domain/strategies");
const db       = require("../infrastructure/db/database");
const notifier = require("../infrastructure/notifications/TelegramNotifier");

class BotEngine extends EventEmitter {
  /**
   * @param {object} configOverrides  — override nilai default dari .env
   *   Contoh: new BotEngine({ symbol: "ETHUSDT", capital: 200 })
   */
  constructor(configOverrides = {}) {
    super();
    const ei   = getExchangeInfo();
    const strat = getStrategy(configOverrides.strategy || process.env.STRATEGY);

    this.config = {
      exchange:      ei.id,
      exchangeLabel: ei.label,
      symbol:        process.env.SYMBOL || "BTCUSDT",
      marginCoin:    process.env.MARGIN_COIN      || "USDT",
      capital:       parseFloat(process.env.CAPITAL)       || 500,
      // Gunakan nilai dari strategi sebagai default, bisa di-override oleh .env
      emaFast:       parseInt(process.env.EMA_FAST)        || strat.emaFast,
      emaSlow:       parseInt(process.env.EMA_SLOW)        || strat.emaSlow,
      emaTrend:      strat.emaTrend || 0,
      rsiPeriod:     parseInt(process.env.RSI_PERIOD)      || strat.rsiPeriod,
      rsiOverbought: parseInt(process.env.RSI_OVERBOUGHT)  || strat.rsiOverbought,
      rsiOversold:   parseInt(process.env.RSI_OVERSOLD)    || strat.rsiOversold,
      // RSI zona entry (dari PDF per strategi)
      rsiLongMin:    strat.rsiLongMin  || 50,
      rsiLongMax:    strat.rsiLongMax  || 70,
      rsiShortMin:   strat.rsiShortMin || 30,
      rsiShortMax:   strat.rsiShortMax || 50,
      atrPeriod:     parseInt(process.env.ATR_PERIOD)      || strat.atrPeriod,
      atrMultiplier: parseFloat(process.env.ATR_MULTIPLIER)|| strat.atrMultiplier,
      riskReward:    parseFloat(process.env.RISK_REWARD)   || strat.riskReward,
      riskPerTrade:  parseFloat(process.env.RISK_PER_TRADE)|| strat.riskPerTrade,
      maxPositions:  parseInt(process.env.MAX_OPEN_POSITIONS)|| 1,
      leverage:      parseInt(process.env.LEVERAGE)        || strat.leverage,
      useBothSides:  process.env.USE_BOTH_SIDES === "true",
      // Interval dari strategi sebagai default (bisa di-override .env)
      interval:      process.env.CANDLE_INTERVAL           || strat.interval || "15m",
      checkInterval: strat.checkInterval || parseInt(process.env.CHECK_INTERVAL_MS) || 60000,
      dryRun:        process.env.DRY_RUN !== "false",
      // Strategy info
      strategyKey:   strat.name,
      strategyLabel: strat.label,
      signalType:    strat.signalType,

      // HTF trend filter
      higherTf:             strat.higherTf      || null,
      htfEmaFast:           strat.htfEmaFast    || 9,
      htfEmaSlow:           strat.htfEmaSlow    || 21,
      sidewaysThresholdPct: strat.sidewaysThresholdPct || 0.2,

      // ATR filter — pastikan pasar tidak terlalu sepi/liar
      atrMinMult:    strat.atrMinMult || 0.1,
      atrMaxMult:    strat.atrMaxMult || 5.0,

      // Volume filter multiplier
      volSmaMultiplier: strat.volSmaMultiplier || 1.0,

      // Risk management harian
      maxDailyLossPct:   strat.maxDailyLossPct  || 0.04,
      maxTradesPerDay:   strat.maxTradesPerDay   || 10,
      cooldownAfterLoss: strat.cooldownAfterLoss || 5,   // menit
      maxConsecLoss:     strat.maxConsecLoss     || 3,

      // Override config per-instance (e.g. symbol berbeda per bot)
      ...configOverrides,
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
    };

    this.logs      = [];   // circular buffer max 1000 (WS streaming)
    this.sessionId = null; // DB session ID saat ini
    this.client    = createExchangeClient();
    this._interval = null;
    this._reportInterval = null;
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

    // Persist ke DB hanya level penting
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
      totalPnL:      this.state.trades.reduce((s, t) => s + (t.pnl || 0), 0),
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
        riskReward:    this.config.riskReward,
        riskPerTrade:  this.config.riskPerTrade,
        leverage:      this.config.leverage,
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
    this.sessionId = db.openSession({
      exchange:       this.config.exchange,
      symbol:         this.config.symbol,
      mode:           this.config.dryRun ? "dry_run" : "live",
      initialCapital: this.state.startCapital,
      config:         this.config,
    });
    this._log("info", `Session DB #${this.sessionId} dibuat`);

    // ── Restore posisi terbuka dari SEMUA sesi lama (lintas sesi) ─────────
    // Cari trades dengan close_time IS NULL untuk symbol ini di semua sesi
    try {
      const orphans = db.getOpenTradesBySymbol(this.config.symbol);
      if (orphans.length > 0) {
        this._log("info", `${orphans.length} posisi open dari sesi lama ditemukan — sinkronisasi dengan exchange...`);

        if (!this.config.dryRun) {
          try {
            const livePosns = await this.client.getPositions(this.config.symbol);
            const liveByKey = new Map(livePosns.map(p => [p.side, p]));

            for (const dbTrade of orphans) {
              if (liveByKey.has(dbTrade.side)) {
                // Masih terbuka di exchange → angkat ke state sesi ini
                const lp = liveByKey.get(dbTrade.side);
                this.state.openPositions.push({
                  id:           dbTrade.order_id || `restored_${dbTrade.id}`,
                  dbId:         dbTrade.id,        // tetap pakai id trade lama di DB
                  side:         dbTrade.side,
                  entry:        dbTrade.entry_price,
                  sl:           dbTrade.sl,
                  tp:           dbTrade.tp,
                  size:         dbTrade.size,
                  openTime:     new Date(dbTrade.open_time).getTime(),
                  atr:          dbTrade.atr,
                  manualSLTP:   false,
                  unrealizedPL: lp.unrealizedPL ?? 0,
                  markPrice:    lp.markPrice    ?? dbTrade.entry_price,
                  restoredFrom: dbTrade.session_id, // info debug
                });
                this._log("trade", `✓ Posisi ${dbTrade.side} @$${dbTrade.entry_price} dipulihkan (sesi #${dbTrade.session_id})`);
              } else {
                // Tidak ada di exchange → tutup di DB (kena SL/TP saat offline)
                const exitPrice = this.state.lastPrice || dbTrade.entry_price;
                const pnl       = dbTrade.side === "LONG"
                  ? (exitPrice - dbTrade.entry_price) * (dbTrade.size || 0)
                  : (dbTrade.entry_price - exitPrice) * (dbTrade.size || 0);
                this._log("warn", `Posisi ${dbTrade.side} sesi #${dbTrade.session_id} sudah ditutup di exchange saat offline — PnL ≈ $${pnl.toFixed(2)}`);
                try {
                  db.closeTrade(dbTrade.id, {
                    exitPrice,
                    pnl,
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

      db.closeSession(this.sessionId, {
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

    const apiKey = process.env.BITGET_API_KEY || "";
    const noKey  = !apiKey || apiKey === "your_api_key_here" || apiKey === "your_bitget_api_key";

    if (noKey) {
      if (!this.config.dryRun) throw new Error("BITGET_API_KEY belum diisi di .env — set DRY_RUN=true untuk simulasi");
      this._log("warn", "API Key kosong — DRY RUN tanpa koneksi exchange");
      this.state.capital = this.state.startCapital = 500;
    } else {
      try {
        const bal = await this.client.getBalance(this.config.marginCoin);
        if (this.config.dryRun && (!bal.available || bal.available <= 0)) {
          this.state.capital = this.state.startCapital = 500;
          this._log("warn", "Balance kosong, gunakan simulasi dengan modal $500");
        } else {
          this.state.capital      = bal.available;
          this.state.startCapital = bal.available;
          this._log("info", `Balance    : $${bal.available.toFixed(2)} USDT`);
        }
        if (!this.config.dryRun) {
          await this.client.setLeverage(this.config.symbol, this.config.leverage);
          await this.client.setMarginMode(this.config.symbol, "crossed");
          this._log("info", `Leverage   : ${this.config.leverage}x diset ✓`);
        }
      } catch (err) {
        this._log("error", `Gagal connect ke ${this.config.exchangeLabel}: ${err.message}`);
        if (!this.config.dryRun) throw err;
        this.state.capital = this.state.startCapital = 500;
        this._log("warn", "Fallback ke DRY RUN dengan modal $500");
      }
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

    // 4. Daily loss limit
    const dailyLossPct = this.state.capital > 0
      ? this.state.dailyLoss / (this.state.dailyStartCapital || this.state.capital)
      : 0;
    if (dailyLossPct >= this.config.maxDailyLossPct) {
      return {
        ok: false,
        reason: `Daily loss ${(dailyLossPct * 100).toFixed(2)}% sudah melewati batas ${(this.config.maxDailyLossPct * 100)}%`,
      };
    }

    // 5. HTF Sideways
    if (this.state.htfTrend === "SIDEWAYS") {
      return { ok: false, reason: `HTF ${this.config.higherTf} = SIDEWAYS — tidak ada trade` };
    }

    // 6. ATR range filter
    if (atr && price) {
      const atrPct = (atr / price) * 100;
      const minPct = this.config.atrMinMult * 0.1; // atrMinMult sebagai batas bawah ATR%
      const maxPct = this.config.atrMaxMult * 0.1;
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
      if (this.config.higherTf) {
        try {
          const htfCandles = await this.client.getCandles(
            this.config.symbol, this.config.higherTf,
            Math.max(this.config.htfEmaSlow + 10, 50)
          );
          this.state.htfTrend = detectHTFTrend(htfCandles, {
            htfEmaFast:           this.config.htfEmaFast,
            htfEmaSlow:           this.config.htfEmaSlow,
            sidewaysThresholdPct: this.config.sidewaysThresholdPct,
          });
        } catch {
          this.state.htfTrend = "UNKNOWN"; // Tidak bisa fetch HTF → allow trade
        }
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

      await this._checkOpenPositions(price, atr);

      if (this.state.openPositions.length < this.config.maxPositions) {
        // ── STEP 1: Risk gates (daily loss, cooldown, max trades, ATR, HTF) ──
        const gate = this._checkRiskGates(atr, price);
        if (!gate.ok) {
          if (this.state.checkCount % 10 === 1) {
            this._log("info", `🚫 Skip entry: ${gate.reason}`);
          }
        } else {
          // ── STEP 2: Deteksi sinyal entry di TF utama ────────────────────────
          const signal = detectSignal(indicators, lastIdx, {
            rsiOverbought: this.config.rsiOverbought,
            rsiOversold:   this.config.rsiOversold,
            rsiLongMin:    this.config.rsiLongMin,
            rsiLongMax:    this.config.rsiLongMax,
            rsiShortMin:   this.config.rsiShortMin,
            rsiShortMax:   this.config.rsiShortMax,
            useBothSides:  this.config.useBothSides,
            signalType:    this.config.signalType,
          });

          // ── STEP 3: Saring sinyal berdasarkan HTF trend ─────────────────────
          let filteredSignal = signal;
          if (signal && this.state.htfTrend !== "UNKNOWN") {
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
            await this._handleSignal(filteredSignal, price, atr);
            this.state.lastSignal = filteredSignal;
          } else if (!filteredSignal) {
            this.state.lastSignal = null;
          }
        }
      }

      this.state.errors = 0;

      // Refresh capital dari exchange setiap 5 menit (live mode)
      if (!this.config.dryRun && this.state.checkCount % 5 === 0) {
        try {
          const bal = await this.client.getBalance(this.config.marginCoin);
          if (bal.available > 0) this.state.capital = bal.available;
        } catch { /* silent — pakai nilai sebelumnya */ }
      }

      // Snapshot equity ke DB setiap tick
      if (this.sessionId) {
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
      this._log("error", `Tick error (${this.state.errors}): ${err.message}`);
      if (this.state.errors >= 5) {
        this._log("error", "5 error berturut-turut! Bot berhenti.");
        await this.stop();
      }
    }
  }

  // ─────────────────────────────────────────────
  // FETCH CANDLES — dengan cache DB
  // ─────────────────────────────────────────────
  async _fetchCandles() {
    const apiKey = process.env.BITGET_API_KEY || "";
    const noKey  = !apiKey || apiKey === "your_api_key_here" || apiKey === "your_bitget_api_key";

    if (this.config.dryRun && noKey) {
      return this._generateDryRunCandles();
    }

    // 1. Coba cache dulu (valid 15 menit)
    try {
      const cached = db.getCachedCandles(this.config.exchange, this.config.symbol, this.config.interval, 900);
      if (cached && cached.length >= this.config.emaSlow + 20) {
        return cached;
      }
    } catch { /* cache error tidak masalah */ }

    // 2. Fetch dari exchange API
    try {
      const timeframe = this.config.interval.toLowerCase();
      const candles   = await this.client.getCandles(this.config.symbol, timeframe, 200);

      // Simpan ke cache
      try {
        db.cacheCandles(this.config.exchange, this.config.symbol, this.config.interval, candles);
      } catch { /* cache write error tidak masalah */ }

      return candles;
    } catch (err) {
      this._log("warn", `Gagal ambil candles dari API, pakai simulasi: ${err.message}`);
      return this._generateDryRunCandles();
    }
  }

  _generateDryRunCandles(n = 200) {
    let price = 65000;
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
  async _handleSignal(signal, price, atr) {
    if (!atr) { this._log("warn", "ATR tidak tersedia, skip signal"); return; }

    const slDist = atr * this.config.atrMultiplier;
    const tpDist = slDist * this.config.riskReward;
    const sl = signal === "LONG" ? price - slDist : price + slDist;
    const tp = signal === "LONG" ? price + tpDist : price - tpDist;

    let availCap = this.config.dryRun ? this.state.capital : 500;
    try {
      if (!this.config.dryRun) {
        const bal = await this.client.getBalance(this.config.marginCoin);
        availCap  = bal.available;
      }
    } catch { /* pakai default */ }

    const size = calcPositionSize(availCap, this.config.riskPerTrade, price, sl);
    if (size <= 0) { this._log("warn", "Position size terlalu kecil, skip signal"); return; }

    // Increment trade counter harian
    this.state.dailyTradeCount += 1;

    this._sep(`SINYAL ${signal}`);
    this._log("trade", `SINYAL: ${signal} ${this.config.symbol}`);
    this._log("trade", `Entry: $${price.toLocaleString()} | SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)} | Size: ${size}`);
    this._log("info",  `📊 Trade hari ini: ${this.state.dailyTradeCount}/${this.config.maxTradesPerDay} | Loss beruntun: ${this.state.consecLoss}/${this.config.maxConsecLoss}`);

    const openTime = Date.now();

    if (!this.config.dryRun) {
      try {
        const side     = signal === "LONG" ? "open_long" : "open_short";
        const holdSide = signal === "LONG" ? "long" : "short";

        // ── Buka posisi + embed preset SL/TP atomik (CCXT v4.5 Bitget V2) ──────
        const order = await this.client.openPosition(
          this.config.symbol, side, size, "USDT", sl.toFixed(2), tp.toFixed(2)
        );
        this._log("trade", `Order terkirim! ID: ${order?.orderId || "N/A"}`);

        const pos = { id: order?.orderId, side: signal, entry: price, sl, tp, size, openTime, atr, manualSLTP: false };

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
              const r = await this.client.setTPSL(this.config.symbol, "loss_plan",   sl.toFixed(2), holdSide, size);
              slOk = r.success;
              if (!slOk) slErr = r.message || "unknown";
            }
            if (!tpOk) {
              const r = await this.client.setTPSL(this.config.symbol, "profit_plan", tp.toFixed(2), holdSide, size);
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
          } else {
            if (!slOk) this._log("error", `SL gagal: ${slErr}`);
            if (!tpOk) this._log("error", `TP gagal: ${tpErr}`);
            this._log("warn", `⚠️ SL: ${slOk ? "✓" : "GAGAL"} | TP: ${tpOk ? "✓" : "GAGAL"} — bot monitor manual`);
            pos.manualSLTP = true;
          }
        }

        // Simpan ke DB
        if (this.sessionId) {
          pos.dbId = db.insertTrade({
            sessionId:  this.sessionId,
            exchange:   this.config.exchange,
            symbol:     this.config.symbol,
            side:       signal,
            entryPrice: price,
            sl, tp, size, openTime, atr,
            dryRun:     false,
            orderId:    order?.orderId,
          });
        }

        this.state.openPositions.push(pos);

        // Notifikasi WhatsApp — open posisi live
        notifier.notifyOpen({
          symbol:     this.config.symbol,
          side:       signal,
          entryPrice: price,
          size,
          sl, tp,
          leverage:   this.config.leverage,
          dryRun:     false,
        });
      } catch (err) {
        this._log("error", `Gagal buka posisi: ${err.message}`);
      }
    } else {
      this._log("trade", "[DRY RUN] Order tidak dikirim ke exchange");
      this.state.capital -= availCap * this.config.riskPerTrade;

      const pos = { id: `dry_${openTime}`, side: signal, entry: price, sl, tp, size, openTime, atr };

      // Simpan ke DB (dry run)
      if (this.sessionId) {
        pos.dbId = db.insertTrade({
          sessionId:  this.sessionId,
          exchange:   this.config.exchange,
          symbol:     this.config.symbol,
          side:       signal,
          entryPrice: price,
          sl, tp, size, openTime, atr,
          dryRun: true,
          orderId: pos.id,
        });
      }

      this.state.openPositions.push(pos);

      // Notifikasi WhatsApp — open posisi dry run
      notifier.notifyOpen({
        symbol:     this.config.symbol,
        side:       signal,
        entryPrice: price,
        size,
        sl, tp,
        leverage:   this.config.leverage,
        dryRun:     true,
      });
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
        for (const pos of closedLocal) {
          const exitPrice = price;
          const pnl       = pos.side === "LONG"
            ? (exitPrice - pos.entry) * pos.size
            : (pos.entry - exitPrice) * pos.size;

          this._sep(`POSISI DITUTUP — SL/TP Hit di Bitget`);
          this._log("trade", `CLOSE ${pos.side} — ditutup oleh exchange`);
          this._log("trade", `Entry: $${pos.entry} | Exit: ~$${exitPrice.toFixed(2)} | PnL: ${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)}`);
          this._log("trade", `Modal sekarang: $${(this.state.capital + pnl).toFixed(2)}`);

          this.state.capital += pnl;
          this.state.trades.push({ ...pos, exit: exitPrice, pnl, reason: "Exchange", closedAt: Date.now() });
          this._updateRiskAfterClose(pnl);

          if (this.sessionId && pos.dbId) {
            try { db.closeTrade(pos.dbId, { exitPrice, pnl, reason: "Exchange", closeTime: new Date().toISOString() }); } catch {}
          }
        }

        // Sync session stats ke DB jika ada posisi yang baru ditutup
        if (closedLocal.length > 0) this._syncSessionStats();

        // Update state: hanya posisi yang masih ada di exchange
        this.state.openPositions = this.state.openPositions.filter(p => liveByKey.has(p.side));

        // Update unrealized PnL + markPrice dari exchange
        for (const pos of this.state.openPositions) {
          const lp = liveByKey.get(pos.side);
          if (lp) { pos.unrealizedPL = lp.unrealizedPL; pos.markPrice = lp.markPrice; }

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
                  // Exchange sudah menutup posisi (SL/TP exchange order kena duluan)
                  // Hapus dari state agar tidak jadi "ghost position"
                  this._log("info", `Posisi ${pos.side} sudah ditutup oleh exchange ✓ (state sync)`);
                  const exitPrice = price;
                  const pnl = pos.side === "LONG"
                    ? (exitPrice - pos.entry) * pos.size
                    : (pos.entry - exitPrice) * pos.size;
                  this.state.trades.push({ ...pos, exit: exitPrice, pnl, reason: "Exchange", closedAt: Date.now() });
                  this._updateRiskAfterClose(pnl);
                  if (this.sessionId && pos.dbId) {
                    try { db.closeTrade(pos.dbId, { exitPrice, pnl, reason: "Exchange", closeTime: new Date().toISOString() }); } catch {}
                  }
                  this.state.openPositions = this.state.openPositions.filter(p => p.id !== pos.id);
                  this._syncSessionStats();
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
      const hitTP = pos.side === "LONG" ? price >= pos.tp : price <= pos.tp;
      const hitSL = pos.side === "LONG" ? price <= pos.sl : price >= pos.sl;

      if (hitTP || hitSL) {
        const exitPrice = hitTP ? pos.tp : pos.sl;
        const pnl       = pos.side === "LONG"
          ? (exitPrice - pos.entry) * pos.size
          : (pos.entry - exitPrice) * pos.size;
        const pnlPct    = ((pnl / (pos.entry * pos.size)) * 100);

        this.state.capital += pnl + pos.entry * pos.size * this.config.riskPerTrade;
        const reason    = hitTP ? "TP" : "SL";
        const closeTime = Date.now();

        this._sep(`POSISI DITUTUP — ${hitTP ? "TAKE PROFIT ✅" : "STOP LOSS ❌"}`);
        this._log("trade", `CLOSE ${pos.side} — ${hitTP ? "TAKE PROFIT ✅" : "STOP LOSS ❌"}`);
        this._log("trade", `Entry: $${pos.entry} | Exit: $${exitPrice.toFixed(2)} | PnL: ${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)}`);
        this._log("trade", `Modal sekarang: $${this.state.capital.toFixed(2)}`);

        // Tutup di DB
        if (this.sessionId && pos.dbId) {
          try {
            db.closeTrade(pos.dbId, { exitPrice, pnl, reason, closeTime: new Date(closeTime).toISOString() });
          } catch { /* jangan crash */ }
        }

        // Notifikasi WhatsApp — close posisi
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

        this.state.trades.push({ ...pos, exit: exitPrice, pnl, pnlPct, reason, closedAt: closeTime });
        this._updateRiskAfterClose(pnl);  // Update daily loss, cooldown, consecLoss
        toClose.push(pos.id);
      }
    }
    this.state.openPositions = this.state.openPositions.filter(p => !toClose.includes(p.id));

    // Sync session stats ke DB setelah posisi ditutup (dry run)
    if (toClose.length > 0) this._syncSessionStats();
  }

  // ─────────────────────────────────────────────
  // SYNC SESSION STATS — update DB setelah tiap trade tutup
  // ─────────────────────────────────────────────
  _syncSessionStats() {
    if (!this.sessionId) return;
    try {
      const wins      = this.state.trades.filter(t => t.pnl > 0).length;
      const losses    = this.state.trades.filter(t => t.pnl <= 0).length;
      const total     = this.state.trades.length + this.state.openPositions.length;
      const tradePnL  = this.state.trades.reduce((s, t) => s + (t.pnl || 0), 0);
      const finalCap  = this.state.startCapital + tradePnL;
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
