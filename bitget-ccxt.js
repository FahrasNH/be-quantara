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

  async getCandles(symbol, timeframe = "4h", limit = 200) {
    try {
      // CCXT format untuk Bitget futures
      const marketSymbol = symbol.includes("_") ? symbol : `${symbol}:USDT`;

      const candles = await this.exchange.fetchOHLCV(
        marketSymbol,
        timeframe,
        undefined,
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
      const ticker = await this.exchange.fetchTicker(symbol);
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
      const positions = await this.exchange.fetchPositions([symbol]);

      if (!Array.isArray(positions) || positions.length === 0) {
        return [];
      }

      return positions
        .filter(p => p.percentage && Math.abs(p.percentage) > 0)
        .map(p => ({
          symbol: p.symbol,
          side: p.side === "long" ? "LONG" : "SHORT",
          size: Math.abs(p.contracts || 0),
          entryPrice: p.markPrice || p.contractSize || 0,
          unrealizedPL: p.unrealizedPnl || 0,
          leverage: p.leverage || 1,
          liquidationPrice: p.liquidationPrice || 0,
        }));
    } catch (err) {
      throw new Error(`getPositions error: ${err.message}`);
    }
  }

  async getOrderHistory(symbol, limit = 20) {
    try {
      const orders = await this.exchange.fetchClosedOrders(symbol, undefined, limit);
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
      return await this.exchange.setLeverage(leverage, symbol);
    } catch (err) {
      throw new Error(`setLeverage error: ${err.message}`);
    }
  }

  async setMarginMode(symbol, mode = "crossed", marginCoin = "USDT") {
    try {
      // mode: "isolated" atau "crossed"
      const marginMode = mode === "crossed" ? "cross" : "isolated";
      return await this.exchange.setMarginType(marginMode, symbol);
    } catch (err) {
      throw new Error(`setMarginMode error: ${err.message}`);
    }
  }

  async openPosition(symbol, side, size, marginCoin = "USDT") {
    try {
      // side: "open_long" -> "long", "open_short" -> "short"
      const orderSide = side.includes("long") ? "long" : "short";

      const order = await this.exchange.createMarketOrder(
        symbol,
        orderSide === "long" ? "buy" : "sell",
        size
      );

      return {
        orderId: order.id,
        ...order,
      };
    } catch (err) {
      throw new Error(`openPosition error: ${err.message}`);
    }
  }

  async closePosition(symbol, side, size, marginCoin = "USDT") {
    try {
      // side: "close_long" -> sell, "close_short" -> buy
      const orderSide = side.includes("long") ? "sell" : "buy";

      const order = await this.exchange.createMarketOrder(
        symbol,
        orderSide,
        size
      );

      return {
        orderId: order.id,
        ...order,
      };
    } catch (err) {
      throw new Error(`closePosition error: ${err.message}`);
    }
  }

  async setTPSL(symbol, planType, triggerPrice, holdSide, size, marginCoin = "USDT") {
    try {
      // planType: "profit_plan" | "loss_plan"
      // holdSide: "long" | "short"

      const params = {
        triggerPrice,
        type: planType === "profit_plan" ? "takeProfit" : "stopLoss",
        side: holdSide,
      };

      return await this.exchange.createOrder(symbol, "limit", "sell", size, triggerPrice, params);
    } catch (err) {
      // CCXT mungkin tidak support plan orders, fallback
      console.warn(`setTPSL warning: ${err.message}`);
      return { success: false, message: "Plan orders tidak fully supported" };
    }
  }

  async cancelAllPlanOrders(symbol, planType = "profit_loss", marginCoin = "USDT") {
    try {
      return await this.exchange.cancelAllOrders(symbol);
    } catch (err) {
      throw new Error(`cancelAllPlanOrders error: ${err.message}`);
    }
  }
}

module.exports = BitgetCCXTClient;
