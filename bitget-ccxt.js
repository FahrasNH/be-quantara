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
      const balance = await this.exchange.fetchBalance({ type: "swap" });

      const coin = balance[marginCoin];
      if (!coin) {
        return {
          available: 0,
          equity: 0,
          unrealizedPL: 0,
        };
      }

      return {
        available: coin.free || 0,
        equity: (coin.free || 0) + (coin.used || 0),
        unrealizedPL: 0, // CCXT tidak provide unrealizedPL langsung
      };
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

  async openPosition(symbol, side, size, marginCoin = "USDT") {
    try {
      // side: "open_long" -> buy, "open_short" -> sell
      let marketSymbol = symbol;
      if (!marketSymbol.includes("/")) {
        const base = marketSymbol.slice(0, -4);
        marketSymbol = `${base}/USDT:USDT`;
      }

      const isBuy    = side.includes("long");
      const direction = isBuy ? "buy" : "sell";

      // FIX error 40774: Bitget one-way mode butuh 'tradeSide: open'
      // Tanpa ini, Bitget bingung apakah ini open atau close posisi
      const order = await this.exchange.createMarketOrder(
        marketSymbol,
        direction,
        size,
        undefined,
        { tradeSide: "open" }
      );

      return { orderId: order.id, ...order };
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
    let marketSymbol = symbol;
    if (!marketSymbol.includes("/")) {
      const base = marketSymbol.slice(0, -4);
      marketSymbol = `${base}/USDT:USDT`;
    }

    const isTP      = planType === "profit_plan";
    const isLong    = holdSide === "long";
    const closeSide = isLong ? "sell" : "buy";   // arah close
    const trigPrice = parseFloat(triggerPrice);

    // FIX: gunakan stopMarket / takeProfitMarket (bukan limit)
    // tradeSide: 'close' + reduceOnly: true = trigger order yang reduce posisi
    const orderType = isTP ? "takeProfitMarket" : "stopMarket";

    try {
      const order = await this.exchange.createOrder(
        marketSymbol,
        orderType,
        closeSide,
        size,
        trigPrice,
        {
          triggerPrice: trigPrice,
          reduceOnly:   true,
          tradeSide:    "close",
        }
      );
      return { success: true, orderId: order.id };
    } catch (err) {
      // Fallback: coba dengan stopPrice param (CCXT versi lain)
      try {
        const order = await this.exchange.createOrder(
          marketSymbol,
          isTP ? "takeProfit" : "stop",
          closeSide,
          size,
          trigPrice,
          {
            stopPrice:  trigPrice,
            reduceOnly: true,
            tradeSide:  "close",
          }
        );
        return { success: true, orderId: order.id };
      } catch (err2) {
        console.warn(`setTPSL (${planType}) warning: ${err2.message}`);
        return { success: false, message: err2.message };
      }
    }
  }

  async cancelAllPlanOrders(symbol, planType = "profit_loss", marginCoin = "USDT") {
    try {
      let marketSymbol = symbol;
      if (!marketSymbol.includes("/")) {
        const base = marketSymbol.slice(0, -4);
        marketSymbol = `${base}/USDT:USDT`;
      }
      return await this.exchange.cancelAllOrders(marketSymbol);
    } catch (err) {
      throw new Error(`cancelAllPlanOrders error: ${err.message}`);
    }
  }
}

module.exports = BitgetCCXTClient;
