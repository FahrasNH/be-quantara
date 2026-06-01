// ─────────────────────────────────────────────
// bot-engine.js — Modular Bot Instance
// Satu instance = satu bot yang bisa berjalan independent
// ─────────────────────────────────────────────

const { createExchangeClient } = require("./exchange-factory");
const { calcIndicators, detectSignal, calcPositionSize } = require("./indicators");
const logger = require("./logger");

class BotEngine {
  constructor(botId, config) {
    this.botId = botId;
    this.config = config;
    this.state = {
      running: false,
      symbol: config.symbol,
      exchange: config.exchange,
      capital: 0,
      startCapital: 0,
      openPositions: [],
      trades: [],
      lastSignal: null,
      checkCount: 0,
      errors: 0,
      lastPrice: 0,
      lastUpdate: Date.now(),
    };

    this.client = null;
    this.interval = null;
    this.reportInterval = null;
    this.listeners = {}; // Event listeners
  }

  // ── Event Management ──
  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => cb(data));
    }
  }

  // ── Lifecycle ──
  async start() {
    try {
      logger.separator(`BOT STARTED: ${this.config.symbol}`);

      this.client = createExchangeClient();
      this.state.running = true;

      // Get initial balance
      try {
        const balance = await this.client.getBalance(this.config.marginCoin);
        this.state.capital = balance.available;
        this.state.startCapital = balance.available;
        logger.info(`[${this.botId}] Balance: $${balance.available.toFixed(2)}`);
        this.emit("balance", { capital: this.state.capital });
      } catch (err) {
        logger.warn(`[${this.botId}] Gagal ambil balance:`, err.message);
        this.state.capital = this.config.dryRun ? 500 : 0;
        this.state.startCapital = this.state.capital;
      }

      // Jalankan tick pertama langsung
      await this.tick();

      // Main loop
      this.interval = setInterval(() => this.tick(), this.config.checkInterval);

      // Status report setiap 1 jam
      this.reportInterval = setInterval(() => this.printStatusReport(), 60 * 60 * 1000);

      this.emit("started", { botId: this.botId });
      logger.info(`[${this.botId}] Bot berjalan (check interval: ${this.config.checkInterval}ms)`);
    } catch (err) {
      logger.error(`[${this.botId}] Start error:`, err.message);
      this.state.running = false;
      this.emit("error", { message: err.message });
    }
  }

  async stop() {
    this.state.running = false;

    if (this.interval) clearInterval(this.interval);
    if (this.reportInterval) clearInterval(this.reportInterval);

    this.printStatusReport();

    if (this.state.openPositions.length > 0 && !this.config.dryRun) {
      logger.warn(`[${this.botId}] ⚠️ Ada ${this.state.openPositions.length} posisi terbuka!`);
    }

    logger.info(`[${this.botId}] Bot stopped`);
    this.emit("stopped", { botId: this.botId });
  }

  // ── Main tick loop ──
  async tick() {
    this.state.checkCount++;

    try {
      // 1. Fetch candles
      const candles = await this.fetchCandles();
      if (!candles || candles.length < this.config.emaSlow + 20) {
        logger.warn(`[${this.botId}] Candle tidak cukup`);
        return;
      }

      // 2. Calculate indicators
      const indicators = calcIndicators(candles, {
        emaFast: this.config.emaFast,
        emaSlow: this.config.emaSlow,
        rsiPeriod: this.config.rsiPeriod,
        atrPeriod: this.config.atrPeriod,
      });

      const lastIdx = candles.length - 2;
      const lastCandle = candles[lastIdx];
      const price = lastCandle.close;
      const emaF = indicators.emaFast[lastIdx];
      const emaS = indicators.emaSlow[lastIdx];
      const rsi = indicators.rsi[lastIdx];
      const atr = indicators.atr[lastIdx];

      this.state.lastPrice = price;
      this.state.lastUpdate = Date.now();

      // 3. Log setiap 5 tick
      if (this.state.checkCount % 5 === 1) {
        const trend = emaF > emaS ? "↑ BULLISH" : "↓ BEARISH";
        logger.price(
          `[${this.botId}] ${this.config.symbol} $${price.toLocaleString()} |`,
          `EMA=${emaF?.toFixed(2)}/${emaS?.toFixed(2)} | RSI=${rsi?.toFixed(1)} | ${trend}`
        );
        this.emit("price", { symbol: this.config.symbol, price, emaF, emaS, rsi, trend });
      }

      // 4. Check open positions
      await this.checkOpenPositions(price, atr);

      // 5. Detect new signal
      if (this.state.openPositions.length < this.config.maxPositions) {
        const signal = detectSignal(indicators, lastIdx, {
          rsiOverbought: this.config.rsiOverbought,
          rsiOversold: this.config.rsiOversold,
          useBothSides: this.config.useBothSides,
        });

        if (signal && signal !== this.state.lastSignal) {
          await this.handleSignal(signal, price, atr);
          this.state.lastSignal = signal;
        } else if (!signal) {
          this.state.lastSignal = null;
        }
      }

      this.state.errors = 0;
    } catch (err) {
      this.state.errors++;
      logger.error(`[${this.botId}] Tick error (${this.state.errors}):`, err.message);

      if (this.state.errors >= 5) {
        logger.error(`[${this.botId}] 5 errors, stopping bot`);
        await this.stop();
      }

      this.emit("error", { message: err.message, count: this.state.errors });
    }
  }

  async fetchCandles() {
    if (this.config.dryRun) {
      return this.generateDryRunCandles();
    }

    try {
      return await this.client.getCandles(
        this.config.symbol,
        this.config.interval,
        200
      );
    } catch (err) {
      logger.warn(`[${this.botId}] Gagal fetch candles, pakai dry run:`, err.message);
      return this.generateDryRunCandles();
    }
  }

  generateDryRunCandles(n = 200) {
    let price = 65000;
    const candles = [];
    const now = Date.now();
    const intervalMs =
      this.config.interval === "1H" ? 3600000
      : this.config.interval === "4H" ? 14400000
      : this.config.interval === "1D" ? 86400000
      : 14400000;

    let trend = 0.0005;
    for (let i = n; i >= 0; i--) {
      if (i % 40 === 0) trend = (Math.random() - 0.5) * 0.003;
      const change = trend + (Math.random() - 0.5) * 0.025;
      const open = price;
      const close = Math.max(price * (1 + change), price * 0.8);
      const high = Math.max(open, close) * (1 + Math.random() * 0.008);
      const low = Math.min(open, close) * (1 - Math.random() * 0.008);

      candles.push({
        timestamp: now - i * intervalMs,
        date: new Date(now - i * intervalMs).toISOString(),
        open: +open.toFixed(2),
        high: +high.toFixed(2),
        low: +low.toFixed(2),
        close: +close.toFixed(2),
        volume: Math.random() * 1000,
      });
      price = close;
    }
    return candles;
  }

  async handleSignal(signal, price, atr) {
    if (!atr) {
      logger.warn(`[${this.botId}] ATR null, skip signal`);
      return;
    }

    const slDistance = atr * this.config.atrMultiplier;
    const tpDistance = slDistance * this.config.riskReward;
    const sl = signal === "LONG" ? price - slDistance : price + slDistance;
    const tp = signal === "LONG" ? price + tpDistance : price - tpDistance;

    const availableCapital = this.config.dryRun
      ? this.state.capital
      : (await this.client.getBalance(this.config.marginCoin)).available;

    const size = calcPositionSize(availableCapital, this.config.riskPerTrade, price, sl);

    if (size <= 0) {
      logger.warn(`[${this.botId}] Position size terlalu kecil`);
      return;
    }

    logger.separator(`📡 SIGNAL ${signal}`);
    logger.trade(
      `[${this.botId}] ${signal} ${this.config.symbol} @ $${price.toLocaleString()}`
    );

    if (!this.config.dryRun) {
      try {
        const side = signal === "LONG" ? "open_long" : "open_short";
        const order = await this.client.openPosition(this.config.symbol, side, size);

        const holdSide = signal === "LONG" ? "long" : "short";
        await this.client.setTPSL(
          this.config.symbol,
          "loss_plan",
          sl.toFixed(2),
          holdSide,
          size
        );
        await this.client.setTPSL(
          this.config.symbol,
          "profit_plan",
          tp.toFixed(2),
          holdSide,
          size
        );

        this.state.openPositions.push({
          id: order?.orderId,
          side: signal,
          entry: price,
          sl,
          tp,
          size,
          openTime: Date.now(),
          atr,
        });

        logger.trade(`✅ Order sent: ${order?.orderId}`);
      } catch (err) {
        logger.error(`[${this.botId}] Failed to open position:`, err.message);
      }
    } else {
      logger.trade(`🟡 [DRY RUN] Order not sent`);
      this.state.capital -= availableCapital * this.config.riskPerTrade;
      this.state.openPositions.push({
        id: `dry_${Date.now()}`,
        side: signal,
        entry: price,
        sl,
        tp,
        size,
        openTime: Date.now(),
        atr,
      });
    }

    this.emit("trade", {
      action: "OPEN",
      symbol: this.config.symbol,
      signal,
      price,
      size,
    });

    await logger.notifyTrade("OPEN", this.config.symbol, signal, price, size);
  }

  async checkOpenPositions(currentPrice, atr) {
    if (this.state.openPositions.length === 0) return;

    if (!this.config.dryRun) {
      try {
        const livePositions = await this.client.getPositions(this.config.symbol);
        this.state.openPositions = this.state.openPositions.filter(p =>
          livePositions.some(lp => lp.side === p.side)
        );
        return;
      } catch {
        // Use local state
      }
    }

    const toClose = [];
    for (const pos of this.state.openPositions) {
      const hitTP = pos.side === "LONG" ? currentPrice >= pos.tp : currentPrice <= pos.tp;
      const hitSL = pos.side === "LONG" ? currentPrice <= pos.sl : currentPrice >= pos.sl;

      if (hitTP || hitSL) {
        const exitPrice = hitTP ? pos.tp : pos.sl;
        const pnl =
          pos.side === "LONG"
            ? (exitPrice - pos.entry) * pos.size
            : (pos.entry - exitPrice) * pos.size;

        this.state.capital += pnl;
        this.state.capital += pos.entry * pos.size * this.config.riskPerTrade;

        const reason = hitTP ? "TAKE PROFIT ✅" : "STOP LOSS ❌";
        const duration = Math.round((Date.now() - pos.openTime) / 60000);

        logger.separator(`POSITION CLOSED — ${reason}`);
        logger.trade(`[${this.botId}] ${hitTP ? "✅" : "❌"} CLOSE ${pos.side}`);
        logger.trade(`   Entry: $${pos.entry.toLocaleString()}`);
        logger.trade(`   Exit: $${exitPrice.toFixed(2)}`);
        logger.trade(`   PnL: ${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)}`);
        logger.trade(`   Duration: ${duration}m`);

        this.state.trades.push({
          ...pos,
          exit: exitPrice,
          pnl,
          reason,
          closedAt: Date.now(),
        });

        toClose.push(pos.id);

        this.emit("trade", {
          action: "CLOSE",
          symbol: this.config.symbol,
          side: pos.side,
          exitPrice,
          size: pos.size,
          pnl,
        });

        await logger.notifyTrade("CLOSE", this.config.symbol, pos.side, exitPrice, pos.size, pnl);
      }
    }

    this.state.openPositions = this.state.openPositions.filter(
      p => !toClose.includes(p.id)
    );
  }

  printStatusReport() {
    const totalPnL = this.state.trades.reduce((s, t) => s + t.pnl, 0);
    const wins = this.state.trades.filter(t => t.pnl > 0).length;
    const losses = this.state.trades.filter(t => t.pnl <= 0).length;
    const winRate =
      this.state.trades.length > 0 ? (wins / this.state.trades.length * 100).toFixed(1) : "N/A";

    logger.separator(`[${this.botId}] STATUS REPORT`);
    logger.info(`Capital: $${this.state.capital.toFixed(2)} (start: $${this.state.startCapital.toFixed(2)})`);
    logger.info(`Total PnL: ${totalPnL > 0 ? "+" : ""}$${totalPnL.toFixed(2)}`);
    logger.info(`Trades: ${this.state.trades.length} total | ${wins}W / ${losses}L | WR ${winRate}%`);
    logger.info(`Open: ${this.state.openPositions.length} | Checks: ${this.state.checkCount}`);
    logger.separator();
  }

  getSnapshot() {
    const totalPnL = this.state.trades.reduce((s, t) => s + t.pnl, 0);
    return {
      botId: this.botId,
      symbol: this.config.symbol,
      exchange: this.config.exchange,
      running: this.state.running,
      capital: this.state.capital,
      startCapital: this.state.startCapital,
      openPositions: this.state.openPositions.length,
      totalTrades: this.state.trades.length,
      totalPnL,
      lastPrice: this.state.lastPrice,
      lastUpdate: this.state.lastUpdate,
      checkCount: this.state.checkCount,
      errors: this.state.errors,
    };
  }
}

module.exports = BotEngine;
