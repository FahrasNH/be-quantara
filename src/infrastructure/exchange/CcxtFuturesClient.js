// ─────────────────────────────────────────────────────────────────────────────
// CcxtFuturesClient.js — Unified USDT-M perpetual trading via CCXT
// Dipakai oleh BinanceClient dan OkxClient; interface selaras dengan BitgetClient.
// ─────────────────────────────────────────────────────────────────────────────

const ccxt = require("ccxt");
const { toRawSymbol, toCcxtSymbol } = require("./ccxtSymbol");
const { withExchangeGate } = require("./exchangeRateGate");

const BALANCE_TYPE = {
  binance: "future",
  okx: "swap",
};

class CcxtFuturesClient {
  /**
   * @param {"binance"|"okx"} exchangeId
   * @param {string} apiKey
   * @param {string} secretKey
   * @param {string} [passphrase]
   * @param {object} [ccxtOptions]
   */
  constructor(exchangeId, apiKey, secretKey, passphrase = "", ccxtOptions = {}) {
    const ctor = ccxt[exchangeId];
    if (!ctor) throw new Error(`Exchange "${exchangeId}" tidak didukung oleh CCXT.`);

    // Trim kredensial — penyebab paling umum "Invalid Sign / Invalid Key" adalah
    // spasi/newline tersembunyi saat copy-paste API key, secret, atau passphrase.
    const trim = (v) => (typeof v === "string" ? v.trim() : v);
    apiKey     = trim(apiKey);
    secretKey  = trim(secretKey);
    passphrase = trim(passphrase);

    this.exchangeId = exchangeId;
    const config = {
      apiKey,
      secret: secretKey,
      enableRateLimit: true,
      options: ccxtOptions,
    };
    if (passphrase) config.password = passphrase;

    this.exchange = new ctor(config);
    this.symbol = null;
  }

  _marketSymbol(symbol) {
    return toCcxtSymbol(symbol);
  }

  /**
   * Format a price to the market's tick-size precision. Falls back to the raw
   * number if markets aren't loaded — never forces a fixed 2-decimal count,
   * which would corrupt SL/TP for low-priced coins (e.g. XPL @ $0.094 → $0.09).
   */
  _fmtPrice(marketSymbol, price) {
    const n = parseFloat(price);
    if (!Number.isFinite(n)) return n;
    try {
      return parseFloat(this.exchange.priceToPrecision(marketSymbol, n));
    } catch {
      return n;
    }
  }

  _orderParams(extra = {}) {
    const params = { ...extra };
    if (this.exchangeId === "okx") params.tdMode = params.tdMode || "cross";
    return params;
  }

  // ── MARKET DATA ───────────────────────────────────────────────────────────

  async getCandles(symbol, timeframe = "4h", limit = 200, since = undefined) {
    // OKX/Binance rate-limit per IP (OKX candles ≈ 40 req/2s). Beberapa koin ×
    // strategy-engine berbagi satu IP → burst memicu "Too many requests" (OKX 50011).
    // CCXT enableRateLimit hanya men-throttle PER client, tak terkoordinasi lintas N
    // client per-koin → retry error rate-limit dengan backoff sebelum menyerah ke
    // cache basi (yang membuat sinyal jadi stale). Error lain (simbol salah, jaringan
    // mati) gagal cepat agar fallback cache 24 jam tetap jalan.
    const RATE_LIMIT_RE = /Too many requests|rate.?limit|ratelimit|\b50011\b|\b429\b/i;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const marketSymbol = this._marketSymbol(symbol);
        const candles = await withExchangeGate(this.exchangeId, () =>
          this.exchange.fetchOHLCV(
            marketSymbol,
            timeframe,
            since,
            Math.min(limit, 500)
          )
        );
        if (!Array.isArray(candles) || candles.length === 0) {
          throw new Error("No candles data received");
        }
        return candles.map((c) => ({
          timestamp: c[0],
          date: new Date(c[0]).toISOString(),
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5]),
        }));
      } catch (err) {
        lastErr = err;
        // Hanya retry rate-limit; backoff 600ms → 1800ms beri waktu window OKX pulih.
        if (attempt < 2 && RATE_LIMIT_RE.test(err.message || "")) {
          await new Promise((r) => setTimeout(r, 600 * Math.pow(3, attempt)));
          continue;
        }
        throw new Error(`getCandles error: ${err.message}`);
      }
    }
    throw new Error(`getCandles error: ${lastErr && lastErr.message}`);
  }

  async getTicker(symbol) {
    try {
      const t = await this.exchange.fetchTicker(this._marketSymbol(symbol));
      return {
        symbol: toRawSymbol(symbol),
        last: t.last,
        bestBid: t.bid,
        bestAsk: t.ask,
        change24h: t.percentage || 0,
      };
    } catch (err) {
      throw new Error(`getTicker error: ${err.message}`);
    }
  }

  // ── ACCOUNT ───────────────────────────────────────────────────────────────

  async getBalance(marginCoin = "USDT") {
    try {
      const balanceType = BALANCE_TYPE[this.exchangeId] || "swap";
      const balance = await this.exchange.fetchBalance({ type: balanceType });
      const free = balance?.free?.[marginCoin] ?? 0;
      const used = balance?.used?.[marginCoin] ?? 0;
      const total = balance?.total?.[marginCoin] ?? free + used;

      let unrealizedPL = 0;
      const coin = balance[marginCoin];
      if (coin?.unrealizedPnl != null) unrealizedPL = Number(coin.unrealizedPnl) || 0;

      return { available: free, equity: total, unrealizedPL };
    } catch (err) {
      throw new Error(`getBalance error: ${err.message}`);
    }
  }

  async getPositions(symbol) {
    try {
      const marketSymbol = this._marketSymbol(symbol);
      const positions = await this.exchange.fetchPositions([marketSymbol]);

      if (!Array.isArray(positions) || positions.length === 0) return [];

      return positions
        .filter((p) => p.contracts && Math.abs(parseFloat(p.contracts)) > 0)
        .map((p) => ({
          symbol: p.symbol,
          side: p.side === "long" ? "LONG" : "SHORT",
          size: Math.abs(parseFloat(p.contracts) || 0),
          entryPrice: parseFloat(p.entryPrice || p.info?.avgPx || 0),
          markPrice: parseFloat(p.markPrice || 0),
          unrealizedPL: parseFloat(p.unrealizedPnl || 0),
          leverage: parseFloat(p.leverage || 1),
          liquidationPrice: parseFloat(p.liquidationPrice || 0),
          percentage: parseFloat(p.percentage || 0),
        }));
    } catch (err) {
      throw new Error(`getPositions error: ${err.message}`);
    }
  }

  async getOrderHistory(symbol, limit = 20) {
    try {
      const orders = await this.exchange.fetchClosedOrders(
        this._marketSymbol(symbol),
        undefined,
        limit
      );
      return Array.isArray(orders) ? orders : [];
    } catch (err) {
      throw new Error(`getOrderHistory error: ${err.message}`);
    }
  }

  async getRecentFillPrice(symbol, side, openedAt = 0) {
    try {
      const marketSymbol = this._marketSymbol(symbol);
      let fills = [];
      try {
        fills = await this.exchange.fetchMyTrades(marketSymbol, openedAt || undefined, 10);
      } catch {
        const orders = await this.exchange.fetchClosedOrders(marketSymbol, openedAt || undefined, 10);
        fills = orders
          .filter((o) => o.filled > 0 && o.average)
          .map((o) => ({ price: o.average, timestamp: o.timestamp, side: o.side }));
      }

      if (!Array.isArray(fills) || fills.length === 0) return null;

      const closingSide = side === "LONG" ? "sell" : "buy";
      const relevant = fills
        .filter((f) => {
          const fSide = (f.side || "").toLowerCase();
          const fTs = f.timestamp || 0;
          return fSide === closingSide && fTs >= (openedAt || 0);
        })
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      if (relevant.length === 0) return null;

      const fillPrice = parseFloat(relevant[0].price || relevant[0].cost / relevant[0].amount || 0);
      return fillPrice > 0 ? fillPrice : null;
    } catch {
      return null;
    }
  }

  async getRecentFillFee(symbol, openedAt = 0) {
    try {
      const marketSymbol = this._marketSymbol(symbol);
      let fills = [];
      try {
        fills = await this.exchange.fetchMyTrades(marketSymbol, openedAt || undefined, 50);
      } catch {
        return null;
      }
      if (!Array.isArray(fills) || fills.length === 0) return null;

      const relevant = fills.filter((f) => (f.timestamp || 0) >= (openedAt || 0));
      if (relevant.length === 0) return null;

      let total = 0;
      let found = false;
      for (const f of relevant) {
        const single = f.fee && Number.isFinite(f.fee.cost) ? Math.abs(f.fee.cost) : 0;
        const multi = Array.isArray(f.fees)
          ? f.fees.reduce((s, x) => s + (Number.isFinite(x?.cost) ? Math.abs(x.cost) : 0), 0)
          : 0;
        const fee = single || multi;
        if (fee > 0) { total += fee; found = true; }
      }
      return found ? total : null;
    } catch {
      return null;
    }
  }

  // ── TRADING ───────────────────────────────────────────────────────────────

  async setLeverage(symbol, leverage) {
    try {
      return await this.exchange.setLeverage(leverage, this._marketSymbol(symbol));
    } catch (err) {
      throw new Error(`setLeverage error: ${err.message}`);
    }
  }

  async setMarginMode(symbol, mode = "crossed") {
    const marketSymbol = this._marketSymbol(symbol);
    const ccxtMode = mode === "crossed" ? "cross" : mode;

    try {
      await this.exchange.setMarginMode(ccxtMode, marketSymbol, this._orderParams());
      return { success: true, mode: ccxtMode };
    } catch (err) {
      const msg = (err.message || "").toLowerCase();
      const benign =
        msg.includes("no need") || msg.includes("not change") ||
        msg.includes("same") || msg.includes("already") ||
        msg.includes("position") || msg.includes("margin type");
      if (benign) {
        return { success: true, mode: ccxtMode, note: "unchanged_or_has_position" };
      }
      console.warn(`setMarginMode gagal: ${err.message}`);
      return { success: false, mode: ccxtMode, error: err.message };
    }
  }

  async openPosition(symbol, side, size, _marginCoin = "USDT", slPrice = undefined, tpPrice = undefined) {
    try {
      const marketSymbol = this._marketSymbol(symbol);
      const isBuy = side.includes("long");
      const direction = isBuy ? "buy" : "sell";

      // Binance/OKX Futures do not support embedded SL/TP in a single createMarketOrder.
      // Return presetSLTP: false so BotEngine always uses the setTPSL fallback path.
      const order = await this.exchange.createMarketOrder(
        marketSymbol,
        direction,
        size,
        undefined,
        this._orderParams()
      );

      return { orderId: order.id, presetSLTP: false, ...order };
    } catch (err) {
      throw new Error(`openPosition error: ${err.message}`);
    }
  }

  /**
   * FEE-02 — Entry maker/post-only dengan fallback taker.
   *
   * Limit post-only di sisi pasif (buy @ bestBid / sell @ bestAsk) untuk kena fee
   * maker, bukan taker. Post-only tak dijamin fill → requote beberapa kali; bila
   * belum penuh sampai timeout, sisa diselesaikan market (taker) agar size utuh.
   * Binance/OKX tak mendukung embed SL/TP di market order → presetSLTP selalu
   * false (BotEngine pasang SL/TP terpisah). Default entryMode tetap taker;
   * rute ini hanya aktif saat entryMode="maker" (lihat A/B FEE-06).
   *
   * @returns {{orderId, presetSLTP:false, entryFill:"maker"|"maker_partial"|"taker", filledMaker:number}}
   */
  async openPositionMaker(symbol, side, size, _marginCoin = "USDT", _slPrice = undefined, _tpPrice = undefined, opts = {}) {
    const {
      maxRequotes    = 2,
      fillTimeoutMs  = 4000,
      pollIntervalMs = 700,
      fallbackTaker  = true,
    } = opts;

    const marketSymbol = this._marketSymbol(symbol);
    const isBuy        = side.includes("long");
    const direction    = isBuy ? "buy" : "sell";
    const sleep        = (ms) => new Promise((r) => setTimeout(r, ms));

    let filledMaker = 0;
    let lastOrderId = null;

    for (let attempt = 0; attempt <= maxRequotes; attempt++) {
      const remaining = parseFloat((size - filledMaker).toFixed(10));
      if (remaining <= 0) break;

      let quote;
      try { quote = await this.getTicker(symbol); } catch { break; }
      const passive = isBuy ? quote.bestBid : quote.bestAsk;
      if (!(passive > 0)) break;
      const limitPrice = this._fmtPrice(marketSymbol, passive);

      let order;
      try {
        order = await this.exchange.createOrder(
          marketSymbol, "limit", direction, remaining, limitPrice,
          this._orderParams({ postOnly: true })
        );
      } catch (err) {
        if (/post.?only|immediately|would match/i.test(err.message || "")) {
          await sleep(150);
          continue;
        }
        throw new Error(`openPositionMaker error: ${err.message}`);
      }
      lastOrderId = order.id;

      let status = order.status, filled = order.filled || 0;
      const deadline = Date.now() + fillTimeoutMs;
      while (Date.now() < deadline && status !== "closed" && status !== "canceled") {
        await sleep(pollIntervalMs);
        try {
          const o = await this.exchange.fetchOrder(order.id, marketSymbol);
          status = o.status; filled = o.filled || 0;
        } catch { /* terus polling */ }
      }

      if (status === "closed") {
        filledMaker = parseFloat((filledMaker + (filled || remaining)).toFixed(10));
        break;
      }

      try { await this.exchange.cancelOrder(order.id, marketSymbol); } catch { /* mungkin sudah ke-fill/cancel */ }
      try {
        const o = await this.exchange.fetchOrder(order.id, marketSymbol);
        filled = o.filled || filled;
      } catch { /* pakai nilai terakhir */ }
      filledMaker = parseFloat((filledMaker + (filled || 0)).toFixed(10));

      if (filled > 0) break;
    }

    const remaining = parseFloat((size - filledMaker).toFixed(10));

    if (remaining > 0 && fallbackTaker) {
      const taker = await this.openPosition(symbol, side, remaining, _marginCoin);
      return {
        ...taker,
        orderId:    taker.orderId || lastOrderId,
        presetSLTP: false,
        entryFill:  filledMaker > 0 ? "maker_partial" : "taker",
        filledMaker,
      };
    }

    return { orderId: lastOrderId, presetSLTP: false, entryFill: "maker", filledMaker };
  }

  async closePosition(symbol, side, size) {
    try {
      const marketSymbol = this._marketSymbol(symbol);
      const direction = side.includes("long") ? "sell" : "buy";
      const order = await this.exchange.createMarketOrder(
        marketSymbol,
        direction,
        size,
        undefined,
        this._orderParams({ reduceOnly: true })
      );
      return { orderId: order.id, ...order };
    } catch (err) {
      throw new Error(`closePosition error: ${err.message}`);
    }
  }

  async setTPSL(symbol, planType, triggerPrice, holdSide, size) {
    const isTP = planType === "profit_plan";
    const isLong = holdSide === "long";
    const closeSide = isLong ? "sell" : "buy";
    const marketSymbol = this._marketSymbol(symbol);
    const trigPrice = this._fmtPrice(marketSymbol, triggerPrice);
    const errors = [];

    try {
      const priceKey = isTP ? "takeProfitPrice" : "stopLossPrice";
      const order = await this.exchange.createOrder(
        marketSymbol,
        "market",
        closeSide,
        size,
        undefined,
        this._orderParams({ [priceKey]: trigPrice, reduceOnly: true })
      );
      return { success: true, method: "ccxtV2TPSL", orderId: order.id };
    } catch (e1) {
      errors.push(`ccxtV2TPSL: ${e1.message}`);
    }

    try {
      const order = await this.exchange.createOrder(
        marketSymbol,
        isTP ? "takeProfitMarket" : "stopMarket",
        closeSide,
        size,
        trigPrice,
        this._orderParams({ triggerPrice: trigPrice, reduceOnly: true })
      );
      return { success: true, method: "ccxtStopMarket", orderId: order.id };
    } catch (e2) {
      errors.push(`ccxtStopMarket: ${e2.message}`);
    }

    try {
      const order = await this.exchange.createOrder(
        marketSymbol,
        isTP ? "takeProfit" : "stop",
        closeSide,
        size,
        trigPrice,
        this._orderParams({ stopPrice: trigPrice, reduceOnly: true })
      );
      return { success: true, method: "ccxtStop", orderId: order.id };
    } catch (e3) {
      errors.push(`ccxtStop: ${e3.message}`);
    }

    const detail = errors.join(" | ");
    console.warn(`[setTPSL] Semua pendekatan gagal (${planType}): ${detail}`);
    return { success: false, message: detail };
  }

  async cancelAllPlanOrders(symbol) {
    try {
      return await this.exchange.cancelAllOrders(this._marketSymbol(symbol));
    } catch (err) {
      const msg = (err.message || "").toLowerCase();
      if (msg.includes("no order") || msg.includes("not found")) {
        return { success: true, skipped: true };
      }
      throw new Error(`cancelAllPlanOrders error: ${err.message}`);
    }
  }
}

module.exports = CcxtFuturesClient;
