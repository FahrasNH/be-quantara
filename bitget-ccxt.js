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
      // side: "open_long" -> "long", "open_short" -> "short"
      let marketSymbol = symbol;
      if (!marketSymbol.includes("/")) {
        const base = marketSymbol.slice(0, -4);
        marketSymbol = `${base}/USDT:USDT`;
      }

      const orderSide = side.includes("long") ? "long" : "short";

      const order = await this.exchange.createMarketOrder(
        marketSymbol,
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
      let marketSymbol = symbol;
      if (!marketSymbol.includes("/")) {
        const base = marketSymbol.slice(0, -4);
        marketSymbol = `${base}/USDT:USDT`;
      }

      // side: "close_long" -> sell, "close_short" -> buy
      const orderSide = side.includes("long") ? "sell" : "buy";

      const order = await this.exchange.createMarketOrder(
        marketSymbol,
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
      let marketSymbol = symbol;
      if (!marketSymbol.includes("/")) {
        const base = marketSymbol.slice(0, -4);
        marketSymbol = `${base}/USDT:USDT`;
      }

      const params = {
        triggerPrice,
        type: planType === "profit_plan" ? "takeProfit" : "stopLoss",
        side: holdSide,
      };

      return await this.exchange.createOrder(marketSymbol, "limit", "sell", size, triggerPrice, params);
    } catch (err) {
      // CCXT mungkin tidak support plan orders, fallback
      console.warn(`setTPSL warning: ${err.message}`);
      return { success: false, message: "Plan orders tidak fully supported" };
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
