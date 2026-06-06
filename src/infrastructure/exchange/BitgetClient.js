// ─────────────────────────────────────────────
// bitget-ccxt.js — Bitget Client menggunakan CCXT
// CCXT adalah library unified yang support Bitget V2
// ─────────────────────────────────────────────

const ccxt = require("ccxt");

class BitgetCCXTClient {
  constructor(apiKey, secretKey, passphrase) {
    this.exchange = new ccxt.bitget({
      apiKey,
      secret: secretKey,
      password: passphrase,
      enableRateLimit: true,
      rateLimit: 100,
      sandbox: false,
    });
    this.symbol = null;
  }

  // ─────────────────────────────────────────────
  // MARKET DATA
  // ─────────────────────────────────────────────

  async getCandles(symbol, timeframe = "4h", limit = 200, since = undefined) {
    try {
      // CCXT Bitget format: BTC/USDT:USDT (untuk swap/futures)
      let marketSymbol = symbol;
      if (!marketSymbol.includes("/")) {
        // Convert BTCUSDT -> BTC/USDT
        const base = marketSymbol.slice(0, -4); // Remove USDT suffix
        marketSymbol = `${base}/USDT:USDT`;
      }

      const candles = await this.exchange.fetchOHLCV(
        marketSymbol,
        timeframe,
        since,
        Math.min(limit, 500)
      );

      if (!Array.isArray(candles) || candles.length === 0) {
        throw new Error("No candles data received");
      }

      return candles.map(c => ({
        timestamp: c[0],
        date: new Date(c[0]).toISOString(),
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }));
    } catch (err) {
      throw new Error(`getCandles error: ${err.message}`);
    }
  }

  async getTicker(symbol) {
    try {
      let marketSymbol = symbol;
      if (!marketSymbol.includes("/")) {
        const base = marketSymbol.slice(0, -4);
        marketSymbol = `${base}/USDT:USDT`;
      }

      const ticker = await this.exchange.fetchTicker(marketSymbol);
      return {
        symbol,
        last: ticker.last,
        bestBid: ticker.bid,
        bestAsk: ticker.ask,
        change24h: ticker.percentage || 0,
      };
    } catch (err) {
      throw new Error(`getTicker error: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────
  // ACCOUNT
  // ─────────────────────────────────────────────

  async getBalance(marginCoin = "USDT") {
    try {
      // type:"swap" → futures USDT-M wallet (umcbl), bukan spot
      const balance = await this.exchange.fetchBalance({ type: "swap" });

      // CCXT Bitget kadang mengembalikan key "USDT" atau "total"/"free"/"used" di root.
      // Coba berbagai path agar robust.
      const coin = balance[marginCoin]
        || balance?.info?.data?.find?.(d => d.marginCoin === marginCoin)
        || null;

      if (!coin) {
        // Fallback: baca dari balance.total / balance.free langsung
        const free  = balance?.free?.[marginCoin]  ?? 0;
        const used  = balance?.used?.[marginCoin]  ?? 0;
        const total = balance?.total?.[marginCoin] ?? 0;
        if (total > 0 || free > 0) {
          return { available: free, equity: total || free + used, unrealizedPL: 0 };
        }
        return { available: 0, equity: 0, unrealizedPL: 0 };
      }

      const available = coin.free   ?? coin.available ?? 0;
      const equity    = coin.total  ?? (available + (coin.used ?? 0));
      const upnl      = coin.unrealizedPnl ?? 0;

      return { available, equity, unrealizedPL: upnl };
    } catch (err) {
      throw new Error(`getBalance error: ${err.message}`);
    }
  }

  async getPositions(symbol, productType = "umcbl") {
    try {
      let marketSymbol = symbol;
      if (!marketSymbol.includes("/")) {
        const base = marketSymbol.slice(0, -4);
        marketSymbol = `${base}/USDT:USDT`;
      }

      const positions = await this.exchange.fetchPositions([marketSymbol]);

      if (!Array.isArray(positions) || positions.length === 0) {
        return [];
      }

      // FIX: filter by contracts (bukan percentage yang bisa null/0)
      return positions
        .filter(p => p.contracts && Math.abs(parseFloat(p.contracts)) > 0)
        .map(p => ({
          symbol:           p.symbol,
          side:             p.side === "long" ? "LONG" : "SHORT",
          size:             Math.abs(parseFloat(p.contracts) || 0),
          // FIX: entryPrice bukan markPrice
          entryPrice:       parseFloat(p.entryPrice || p.info?.averageOpenPrice || p.info?.openPriceAvg || 0),
          markPrice:        parseFloat(p.markPrice || 0),
          unrealizedPL:     parseFloat(p.unrealizedPnl || 0),
          leverage:         parseFloat(p.leverage || 1),
          liquidationPrice: parseFloat(p.liquidationPrice || 0),
          percentage:       parseFloat(p.percentage || 0),
        }));
    } catch (err) {
      throw new Error(`getPositions error: ${err.message}`);
    }
  }

  async getOrderHistory(symbol, limit = 20) {
    try {
      let marketSymbol = symbol;
      if (!marketSymbol.includes("/")) {
        const base = marketSymbol.slice(0, -4);
        marketSymbol = `${base}/USDT:USDT`;
      }
      const orders = await this.exchange.fetchClosedOrders(marketSymbol, undefined, limit);
      return Array.isArray(orders) ? orders : [];
    } catch (err) {
      throw new Error(`getOrderHistory error: ${err.message}`);
    }
  }

  /**
   * Ambil harga fill aktual dari exchange untuk posisi yang baru ditutup.
   * Digunakan setelah deteksi posisi hilang dari getPositions() agar exit price
   * yang dicatat = harga SL/TP nyata, bukan tick price saat deteksi.
   *
   * @param {string} symbol  — e.g. "SOLUSDT"
   * @param {string} side    — "LONG" | "SHORT" (posisi yang ditutup)
   * @param {number} openedAt — timestamp ms saat posisi dibuka (untuk filter)
   * @returns {number|null}  — fill price, atau null jika tidak bisa diambil
   */
  async getRecentFillPrice(symbol, side, openedAt = 0) {
    try {
      let marketSymbol = symbol;
      if (!marketSymbol.includes("/")) {
        const base = marketSymbol.slice(0, -4);
        marketSymbol = `${base}/USDT:USDT`;
      }

      // fetchMyTrades mengembalikan actual fills (bukan order), lebih akurat
      let fills = [];
      try {
        fills = await this.exchange.fetchMyTrades(marketSymbol, openedAt || undefined, 10);
      } catch {
        // Beberapa exchange config tidak support fetchMyTrades — fallback ke closed orders
        const orders = await this.exchange.fetchClosedOrders(marketSymbol, openedAt || undefined, 10);
        fills = orders
          .filter(o => o.filled > 0 && o.average)
          .map(o => ({ price: o.average, timestamp: o.timestamp, side: o.side }));
      }

      if (!Array.isArray(fills) || fills.length === 0) return null;

      // Closing trade adalah order di sisi berlawanan dari posisi
      // LONG ditutup via SELL order; SHORT ditutup via BUY order
      const closingSide = side === "LONG" ? "sell" : "buy";

      // Cari fill terbaru setelah posisi dibuka yang arahnya menutup posisi ini
      const relevant = fills
        .filter(f => {
          const fSide = (f.side || "").toLowerCase();
          const fTs   = f.timestamp || 0;
          return fSide === closingSide && fTs >= (openedAt || 0);
        })
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      if (relevant.length === 0) return null;

      const fillPrice = parseFloat(relevant[0].price || relevant[0].cost / relevant[0].amount || 0);
      return fillPrice > 0 ? fillPrice : null;
    } catch {
      return null; // non-fatal — caller akan fallback ke SL/TP estimate
    }
  }

  // ─────────────────────────────────────────────
  // TRADING
  // ─────────────────────────────────────────────

  async setLeverage(symbol, leverage, marginCoin = "USDT") {
    try {
      let marketSymbol = symbol;
      if (!marketSymbol.includes("/")) {
        const base = marketSymbol.slice(0, -4);
        marketSymbol = `${base}/USDT:USDT`;
      }
      return await this.exchange.setLeverage(leverage, marketSymbol, {
        marginCoin: marginCoin,
      });
    } catch (err) {
      throw new Error(`setLeverage error: ${err.message}`);
    }
  }

  async setMarginMode(symbol, mode = "crossed", marginCoin = "USDT") {
    try {
      // CCXT Bitget mungkin tidak support setMarginType langsung
      // Fallback: assume margin mode already set via Bitget dashboard
      console.warn(`[WARN] setMarginMode fallback - margin mode harus di-set di Bitget dashboard`);
      return { success: true, mode: mode };
    } catch (err) {
      console.warn(`setMarginMode warning: ${err.message}`);
      return { success: true, mode: mode };
    }
  }

  async openPosition(symbol, side, size, marginCoin = "USDT", slPrice = undefined, tpPrice = undefined) {
    try {
      // side: "open_long" -> buy, "open_short" -> sell
      let marketSymbol = symbol;
      if (!marketSymbol.includes("/")) {
        const base = marketSymbol.slice(0, -4);
        marketSymbol = `${base}/USDT:USDT`;
      }

      const isBuy     = side.includes("long");
      const direction = isBuy ? "buy" : "sell";

      const extraParams = { tradeSide: "open" };

      // Embed SL/TP atomik dalam order entry (CCXT v4.5 Bitget V2 support)
      // presetStopLossPrice & presetStopSurplusPrice dikirim bersamaan order masuk
      if (slPrice) {
        extraParams.stopLoss = { triggerPrice: parseFloat(slPrice) };
      }
      if (tpPrice) {
        extraParams.takeProfit = { triggerPrice: parseFloat(tpPrice) };
      }

      const order = await this.exchange.createMarketOrder(
        marketSymbol,
        direction,
        size,
        undefined,
        extraParams
      );

      return { orderId: order.id, presetSLTP: !!(slPrice && tpPrice), ...order };
    } catch (err) {
      throw new Error(`openPosition error: ${err.message}`);
    }
  }

  async closePosition(symbol, side, size, marginCoin = "USDT") {
    try {
      let marketSymbol = symbol;
      if (!marketSymbol.includes("/")) {
        const base = marketSymbol.slice(0, -4);
        marketSymbol = `${base}/USDT:USDT`;
      }

      // close_long → sell, close_short → buy
      const direction = side.includes("long") ? "sell" : "buy";

      // FIX: tradeSide: close + reduceOnly supaya tidak buka posisi baru
      const order = await this.exchange.createMarketOrder(
        marketSymbol,
        direction,
        size,
        undefined,
        { tradeSide: "close", reduceOnly: true }
      );

      return { orderId: order.id, ...order };
    } catch (err) {
      throw new Error(`closePosition error: ${err.message}`);
    }
  }

  async setTPSL(symbol, planType, triggerPrice, holdSide, size, marginCoin = "USDT") {
    // planType: "profit_plan" | "loss_plan"
    // holdSide: "long" | "short"
    const isTP      = planType === "profit_plan";
    const isLong    = holdSide === "long";
    const closeSide = isLong ? "sell" : "buy";
    const trigPrice = parseFloat(triggerPrice);

    // Format symbol
    let marketSymbol = symbol;
    let rawSymbol    = symbol; // e.g. SOLUSDT (tanpa slash)
    if (!marketSymbol.includes("/")) {
      const base   = marketSymbol.slice(0, -4);
      marketSymbol = `${base}/USDT:USDT`;
    } else {
      rawSymbol = symbol.replace("/", "").replace(":USDT", "");
    }

    const errors = [];

    // ── Pendekatan 0: Bitget V2 direct — pos_loss / pos_profit ───────────────
    // Ini adalah tipe yang sama dengan preset SL/TP yang di-embed saat openPosition.
    // Memanggil endpoint ini akan REPLACE preset stop yang ada (tidak konflik).
    try {
      await this.exchange.privateMixPostV2MixOrderPlaceTpslOrder({
        symbol:        rawSymbol,
        productType:   "USDT-FUTURES",
        marginCoin,
        planType:      isTP ? "pos_profit" : "pos_loss",
        triggerPrice:  String(trigPrice),
        triggerType:   "mark_price",
        holdSide,
        size:          String(size),
        clientOid:     `tpsl_${Date.now()}`,
      });
      return { success: true, method: "bitgetV2PosTPSL" };
    } catch (e0) {
      errors.push(`bitgetV2PosTPSL: ${e0.message}`);
    }

    // ── Pendekatan 1: CCXT V2 — stopLossPrice / takeProfitPrice ──────────────
    try {
      const priceKey = isTP ? "takeProfitPrice" : "stopLossPrice";
      const order = await this.exchange.createOrder(
        marketSymbol,
        "market",
        closeSide,
        size,
        undefined,
        { [priceKey]: trigPrice, reduceOnly: true }
      );
      return { success: true, method: "ccxtV2TPSL", orderId: order.id };
    } catch (e1) {
      errors.push(`ccxtV2TPSL: ${e1.message}`);
    }

    // ── Pendekatan 2: CCXT takeProfitMarket / stopMarket ─────────────────────
    try {
      const order = await this.exchange.createOrder(
        marketSymbol,
        isTP ? "takeProfitMarket" : "stopMarket",
        closeSide,
        size,
        trigPrice,
        { triggerPrice: trigPrice, reduceOnly: true }
      );
      return { success: true, method: "ccxtStopMarket", orderId: order.id };
    } catch (e2) {
      errors.push(`ccxtStopMarket: ${e2.message}`);
    }

    // ── Pendekatan 3: CCXT takeProfit / stop ─────────────────────────────────
    try {
      const order = await this.exchange.createOrder(
        marketSymbol,
        isTP ? "takeProfit" : "stop",
        closeSide,
        size,
        trigPrice,
        { stopPrice: trigPrice, reduceOnly: true }
      );
      return { success: true, method: "ccxtStop", orderId: order.id };
    } catch (e3) {
      errors.push(`ccxtStop: ${e3.message}`);
    }

    const detail = errors.join(" | ");
    console.warn(`[setTPSL] Semua pendekatan gagal (${planType}): ${detail}`);
    return { success: false, message: detail };
  }

  async cancelAllPlanOrders(symbol, planType = "profit_loss", marginCoin = "USDT") {
    let marketSymbol = symbol;
    if (!marketSymbol.includes("/")) {
      const base = marketSymbol.slice(0, -4);
      marketSymbol = `${base}/USDT:USDT`;
    }

    try {
      return await this.exchange.cancelAllOrders(marketSymbol);
    } catch (err) {
      // 22001 = no order to cancel — bukan error kritis, return sukses
      if (err.message && err.message.includes("22001")) return { success: true, skipped: true };
      throw new Error(`cancelAllPlanOrders error: ${err.message}`);
    }
  }
}

module.exports = BitgetCCXTClient;
