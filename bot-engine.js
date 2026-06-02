// ─────────────────────────────────────────────
// bot-engine.js — Quantara BotEngine
// Class yang bisa di-start/stop oleh server.js
// Memancarkan event 'log' untuk streaming ke WS
// ─────────────────────────────────────────────

const EventEmitter = require("events");
const { createExchangeClient, getExchangeInfo } = require("./exchange-factory");
const { calcIndicators, detectSignal, calcPositionSize } = require("./indicators");

class BotEngine extends EventEmitter {
  constructor() {
    super();
    const ei = getExchangeInfo();

    this.config = {
      exchange:      ei.id,
      exchangeLabel: ei.label,
      symbol:        ei.id === "okx"
                       ? (process.env.OKX_INST_ID || "BTC-USDT-SWAP")
                       : (process.env.SYMBOL       || "BTCUSDT"),
      marginCoin:    process.env.MARGIN_COIN      || "USDT",
      emaFast:       parseInt(process.env.EMA_FAST)        || 9,
      emaSlow:       parseInt(process.env.EMA_SLOW)        || 21,
      rsiPeriod:     parseInt(process.env.RSI_PERIOD)      || 14,
      rsiOverbought: parseInt(process.env.RSI_OVERBOUGHT)  || 70,
      rsiOversold:   parseInt(process.env.RSI_OVERSOLD)    || 30,
      atrPeriod:     parseInt(process.env.ATR_PERIOD)      || 14,
      atrMultiplier: parseFloat(process.env.ATR_MULTIPLIER)|| 2,
      riskReward:    parseFloat(process.env.RISK_REWARD)   || 3,
      riskPerTrade:  parseFloat(process.env.RISK_PER_TRADE)|| 0.02,
      maxPositions:  parseInt(process.env.MAX_OPEN_POSITIONS)|| 1,
      leverage:      parseInt(process.env.LEVERAGE)        || 3,
      useBothSides:  process.env.USE_BOTH_SIDES === "true",
      interval:      process.env.CANDLE_INTERVAL           || "4H",
      checkInterval: parseInt(process.env.CHECK_INTERVAL_MS)|| 60000,
      dryRun:        process.env.DRY_RUN !== "false",
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
    };

    this.logs = [];        // circular buffer max 1000
    this.client = createExchangeClient();
    this._interval = null;
    this._reportInterval = null;
  }

  // ─────────────────────────────────────────────
  // INTERNAL LOGGER — console + emit event
  // ─────────────────────────────────────────────
  _log(level, ...args) {
    const msg  = args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    const time = new Date().toISOString();
    const entry = { time, level, msg };

    this.logs.push(entry);
    if (this.logs.length > 1000) this.logs.shift();
    this.emit("log", entry);

    const C = { info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m", trade: "\x1b[32m", price: "\x1b[34m" };
    const prefix = { info: "INFO ", warn: "WARN ", error: "ERROR", trade: "TRADE", price: "PRICE" };
    const ts = `\x1b[90m[${new Date().toLocaleTimeString("id-ID")}]\x1b[0m`;
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
      symbol:        this.config.symbol,
      exchange:      this.config.exchange,
      exchangeLabel: this.config.exchangeLabel,
      dryRun:        this.config.dryRun,
      capital:       this.state.capital,
      startCapital:  this.state.startCapital,
      openPositions: this.state.openPositions,
      trades:        this.state.trades.slice(-50),
      totalTrades:   this.state.trades.length,
      lastSignal:    this.state.lastSignal,
      checkCount:    this.state.checkCount,
      errors:        this.state.errors,
      lastTick:      this.state.lastTick,
      lastPrice:     this.state.lastPrice,
      totalPnL:      this.state.trades.reduce((s, t) => s + (t.pnl || 0), 0),
      winRate:       this._winRate(),
      params: {
        emaFast:       this.config.emaFast,
        emaSlow:       this.config.emaSlow,
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
    await this._startup();
    this.state.running = true;
    this.emit("status", this.getState());

    await this._tick();

    this._interval = setInterval(() => this._tick(), this.config.checkInterval);
    this._reportInterval = setInterval(() => this._statusReport(), 60 * 60 * 1000);

    this._log("info", `Bot berjalan — cek setiap ${this.config.checkInterval / 1000}s`);
  }

  async stop() {
    if (this._interval)       clearInterval(this._interval);
    if (this._reportInterval) clearInterval(this._reportInterval);
    this._interval       = null;
    this._reportInterval = null;
    this.state.running   = false;
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
    this._log("info", `Symbol     : ${this.config.symbol}`);
    this._log("info", `Interval   : ${this.config.interval}`);
    this._log("info", `EMA        : Fast(${this.config.emaFast}) / Slow(${this.config.emaSlow})`);
    this._log("info", `Risk/trade : ${(this.config.riskPerTrade * 100).toFixed(0)}%  |  Leverage: ${this.config.leverage}x`);
    this._sep();

    const apiKey = this.config.exchange === "okx" ? process.env.OKX_API_KEY : process.env.BITGET_API_KEY;
    const noKey  = !apiKey || apiKey === "your_api_key_here" || apiKey === "your_bitget_api_key";

    if (noKey) {
      if (!this.config.dryRun) throw new Error("API Key belum diisi di .env — set DRY_RUN=true untuk simulasi");
      this._log("warn", "API Key kosong — DRY RUN tanpa koneksi exchange");
      this.state.capital = this.state.startCapital = 500;
    } else {
      try {
        const bal = await this.client.getBalance(this.config.marginCoin);

        // DRY RUN: jika balance $0 atau error, gunakan $500 simulasi
        if (this.config.dryRun && (!bal.available || bal.available <= 0)) {
          this.state.capital = this.state.startCapital = 500;
          this._log("warn", `Balance kosong, gunakan simulasi dengan modal $500`);
        } else {
          this.state.capital = bal.available;
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
  // MAIN TICK
  // ─────────────────────────────────────────────
  async _tick() {
    this.state.checkCount++;
    this.state.lastTick = new Date().toISOString();

    try {
      const candles = await this._fetchCandles();
      if (!candles || candles.length < this.config.emaSlow + 20) {
        this._log("warn", "Candle tidak cukup untuk kalkulasi indikator");
        return;
      }

      const indicators = calcIndicators(candles, {
        emaFast:   this.config.emaFast,
        emaSlow:   this.config.emaSlow,
        rsiPeriod: this.config.rsiPeriod,
        atrPeriod: this.config.atrPeriod,
      });

      const lastIdx = candles.length - 2;
      const price   = candles[lastIdx].close;
      const emaF    = indicators.emaFast[lastIdx];
      const emaS    = indicators.emaSlow[lastIdx];
      const rsi     = indicators.rsi[lastIdx];
      const atr     = indicators.atr[lastIdx];

      this.state.lastPrice = price;

      if (this.state.checkCount % 5 === 1) {
        this._log("price",
          `${this.config.symbol} $${price.toLocaleString()} | ` +
          `EMA(${this.config.emaFast})=${emaF?.toFixed(2)} EMA(${this.config.emaSlow})=${emaS?.toFixed(2)} | ` +
          `RSI=${rsi?.toFixed(1)} ATR=${atr?.toFixed(2)} | ` +
          `Trend: ${emaF > emaS ? "↑ BULLISH" : "↓ BEARISH"}`
        );
      }

      await this._checkOpenPositions(price, atr);

      if (this.state.openPositions.length < this.config.maxPositions) {
        const signal = detectSignal(indicators, lastIdx, {
          rsiOverbought: this.config.rsiOverbought,
          rsiOversold:   this.config.rsiOversold,
          useBothSides:  this.config.useBothSides,
        });

        if (signal && signal !== this.state.lastSignal) {
          await this._handleSignal(signal, price, atr);
          this.state.lastSignal = signal;
        } else if (!signal) {
          this.state.lastSignal = null;
        }
      }

      this.state.errors = 0;
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
  // FETCH CANDLES
  // ─────────────────────────────────────────────
  async _fetchCandles() {
    const apiKey = this.config.exchange === "okx" ? process.env.OKX_API_KEY : process.env.BITGET_API_KEY;
    const noKey  = !apiKey || apiKey === "your_api_key_here" || apiKey === "your_bitget_api_key";

    if (this.config.dryRun && noKey) {
      return this._generateDryRunCandles();
    }
    try {
      // Convert interval ke lowercase untuk CCXT (4H -> 4h)
      const timeframe = this.config.interval.toLowerCase();
      return await this.client.getCandles(this.config.symbol, timeframe, 200);
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
  // HANDLE SIGNAL
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
        availCap = bal.available;
      }
    } catch { /* pakai default */ }

    const size = calcPositionSize(availCap, this.config.riskPerTrade, price, sl);
    if (size <= 0) { this._log("warn", "Position size terlalu kecil, skip signal"); return; }

    this._sep(`SINYAL ${signal}`);
    this._log("trade", `SINYAL: ${signal} ${this.config.symbol}`);
    this._log("trade", `Entry: $${price.toLocaleString()} | SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)} | Size: ${size}`);

    if (!this.config.dryRun) {
      try {
        const side  = signal === "LONG" ? "open_long" : "open_short";
        const order = await this.client.openPosition(this.config.symbol, side, size);
        this._log("trade", `Order terkirim! ID: ${order?.orderId || "N/A"}`);
        const holdSide = signal === "LONG" ? "long" : "short";
        await this.client.setTPSL(this.config.symbol, "loss_plan",   sl.toFixed(2), holdSide, size);
        await this.client.setTPSL(this.config.symbol, "profit_plan", tp.toFixed(2), holdSide, size);
        this._log("trade", "SL/TP dipasang ✓");
        this.state.openPositions.push({ id: order?.orderId, side: signal, entry: price, sl, tp, size, openTime: Date.now(), atr });
      } catch (err) {
        this._log("error", `Gagal buka posisi: ${err.message}`);
      }
    } else {
      this._log("trade", "[DRY RUN] Order tidak dikirim ke exchange");
      this.state.capital -= availCap * this.config.riskPerTrade;
      this.state.openPositions.push({ id: `dry_${Date.now()}`, side: signal, entry: price, sl, tp, size, openTime: Date.now(), atr });
    }
  }

  // ─────────────────────────────────────────────
  // CHECK OPEN POSITIONS
  // ─────────────────────────────────────────────
  async _checkOpenPositions(price, atr) {
    if (this.state.openPositions.length === 0) return;

    if (!this.config.dryRun) {
      try {
        const live = await this.client.getPositions(this.config.symbol);
        this.state.openPositions = this.state.openPositions.filter(p =>
          live.some(lp => lp.side === p.side)
        );
      } catch { /* pakai state lokal */ }
      return;
    }

    const toClose = [];
    for (const pos of this.state.openPositions) {
      const hitTP = pos.side === "LONG" ? price >= pos.tp : price <= pos.tp;
      const hitSL = pos.side === "LONG" ? price <= pos.sl : price >= pos.sl;

      if (hitTP || hitSL) {
        const exitPrice = hitTP ? pos.tp : pos.sl;
        const pnl = pos.side === "LONG"
          ? (exitPrice - pos.entry) * pos.size
          : (pos.entry - exitPrice) * pos.size;

        this.state.capital += pnl + pos.entry * pos.size * this.config.riskPerTrade;
        const reason = hitTP ? "TAKE PROFIT ✅" : "STOP LOSS ❌";

        this._sep(`POSISI DITUTUP — ${reason}`);
        this._log("trade", `CLOSE ${pos.side} — ${reason}`);
        this._log("trade", `Entry: $${pos.entry} | Exit: $${exitPrice.toFixed(2)} | PnL: ${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)}`);
        this._log("trade", `Modal sekarang: $${this.state.capital.toFixed(2)}`);

        this.state.trades.push({ ...pos, exit: exitPrice, pnl, reason, closedAt: Date.now() });
        toClose.push(pos.id);
      }
    }
    this.state.openPositions = this.state.openPositions.filter(p => !toClose.includes(p.id));
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
