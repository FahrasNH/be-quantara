// ─────────────────────────────────────────────
// bitget.js — Bitget REST API Client
// Handles authentication, signing, dan semua
// endpoint yang dibutuhkan bot
// ─────────────────────────────────────────────

const axios = require("axios");
const crypto = require("crypto");

const BASE_URL = "https://api.bitget.com";

class BitgetClient {
  constructor(apiKey, secretKey, passphrase) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.passphrase = passphrase;
  }

  // ── Signature (HMAC-SHA256) ──
  _sign(timestamp, method, requestPath, body = "") {
    const message = timestamp + method.toUpperCase() + requestPath + body;
    return crypto
      .createHmac("sha256", this.secretKey)
      .update(message)
      .digest("base64");
  }

  // ── Headers ──
  _headers(method, path, body = "") {
    const timestamp = Date.now().toString();
    const sign = this._sign(timestamp, method, path, body);
    return {
      "ACCESS-KEY": this.apiKey,
      "ACCESS-SIGN": sign,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": this.passphrase,
      "Content-Type": "application/json",
      "locale": "en-US",
    };
  }

  // ── Generic request ──
  async _request(method, path, params = {}, data = null) {
    try {
      let url = BASE_URL + path;
      let queryString = "";

      if (method === "GET" && Object.keys(params).length > 0) {
        queryString = "?" + new URLSearchParams(params).toString();
        url += queryString;
        path += queryString;
      }

      const bodyStr = data ? JSON.stringify(data) : "";
      const headers = this._headers(method, path, bodyStr);

      const response = await axios({
        method,
        url,
        headers,
        data: data || undefined,
        timeout: 10000,
      });

      if (response.data.code !== "00000") {
        throw new Error(`Bitget API Error: ${response.data.msg} (code: ${response.data.code})`);
      }

      return response.data.data;
    } catch (err) {
      if (err.response) {
        throw new Error(`HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // MARKET DATA (tidak butuh auth)
  // ─────────────────────────────────────────────

  // Ambil OHLCV candles historis
  async getCandles(symbol, granularity = "4H", limit = 200) {
    // Map interval ke kode Bitget
    const granMap = {
      "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
      "1H": "1H", "4H": "4H", "6H": "6H", "12H": "12H",
      "1D": "1D", "1W": "1W",
    };
    const gran = granMap[granularity] || "4H";

    const response = await axios.get(
      `${BASE_URL}/api/mix/v1/market/candles`,
      {
        params: { symbol: symbol + "_UMCBL", granularity: gran, limit: limit.toString() },
        timeout: 10000,
      }
    );

    if (!response.data || !Array.isArray(response.data)) {
      throw new Error("Format candle tidak valid dari Bitget");
    }

    // Format: [timestamp, open, high, low, close, baseVol, quoteVol]
    return response.data.map(c => ({
      timestamp: parseInt(c[0]),
      date: new Date(parseInt(c[0])).toISOString(),
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    })).reverse(); // Bitget returns newest first
  }

  // Harga real-time
  async getTicker(symbol) {
    const response = await axios.get(
      `${BASE_URL}/api/mix/v1/market/ticker`,
      { params: { symbol: symbol + "_UMCBL" }, timeout: 5000 }
    );
    return {
      symbol,
      last:   parseFloat(response.data.data.last),
      bestBid: parseFloat(response.data.data.bestBid),
      bestAsk: parseFloat(response.data.data.bestAsk),
      change24h: parseFloat(response.data.data.chgUtc),
    };
  }

  // ─────────────────────────────────────────────
  // ACCOUNT (butuh auth)
  // ─────────────────────────────────────────────

  // Saldo akun futures
  async getBalance(marginCoin = "USDT") {
    const data = await this._request("GET", "/api/mix/v1/account/account", {
      symbol: "BTCUSDT_UMCBL",
      marginCoin,
    });
    return {
      available: parseFloat(data.available),
      equity:    parseFloat(data.equity),
      unrealizedPL: parseFloat(data.unrealizedPL),
    };
  }

  // Posisi yang sedang terbuka
  async getPositions(symbol, productType = "umcbl") {
    const data = await this._request("GET", "/api/mix/v1/position/allPosition-v2", {
      productType,
      marginCoin: "USDT",
    });

    if (!Array.isArray(data)) return [];
    return data
      .filter(p => p.symbol === symbol + "_UMCBL" && parseFloat(p.total) > 0)
      .map(p => ({
        symbol: p.symbol,
        side: p.holdSide === "long" ? "LONG" : "SHORT",
        size: parseFloat(p.total),
        entryPrice: parseFloat(p.averageOpenPrice),
        unrealizedPL: parseFloat(p.unrealizedPL),
        leverage: parseInt(p.leverage),
        liquidationPrice: parseFloat(p.liquidationPrice),
      }));
  }

  // Riwayat order
  async getOrderHistory(symbol, limit = 20) {
    const data = await this._request("GET", "/api/mix/v1/order/history", {
      symbol: symbol + "_UMCBL",
      startTime: (Date.now() - 7 * 24 * 60 * 60 * 1000).toString(),
      endTime: Date.now().toString(),
      pageSize: limit.toString(),
    });
    return Array.isArray(data?.orderList) ? data.orderList : [];
  }

  // ─────────────────────────────────────────────
  // TRADING (butuh auth)
  // ─────────────────────────────────────────────

  // Set leverage
  async setLeverage(symbol, leverage, marginCoin = "USDT") {
    return this._request("POST", "/api/mix/v1/account/setLeverage", {}, {
      symbol: symbol + "_UMCBL",
      marginCoin,
      leverage: leverage.toString(),
      holdSide: "long_short",
    });
  }

  // Set margin mode
  async setMarginMode(symbol, mode = "crossed", marginCoin = "USDT") {
    return this._request("POST", "/api/mix/v1/account/setMarginMode", {}, {
      symbol: symbol + "_UMCBL",
      marginCoin,
      marginMode: mode, // crossed atau fixed
    });
  }

  // Buka posisi (market order)
  async openPosition(symbol, side, size, marginCoin = "USDT") {
    // side: "open_long" | "open_short"
    return this._request("POST", "/api/mix/v1/order/placeOrder", {}, {
      symbol:       symbol + "_UMCBL",
      marginCoin,
      size:         size.toString(),
      side,
      orderType:    "market",
      timeInForceValue: "normal",
    });
  }

  // Tutup posisi (market order)
  async closePosition(symbol, side, size, marginCoin = "USDT") {
    // side: "close_long" | "close_short"
    return this._request("POST", "/api/mix/v1/order/placeOrder", {}, {
      symbol:       symbol + "_UMCBL",
      marginCoin,
      size:         size.toString(),
      side,
      orderType:    "market",
      timeInForceValue: "normal",
    });
  }

  // Pasang Stop Loss & Take Profit (plan order)
  async setTPSL(symbol, planType, triggerPrice, holdSide, size, marginCoin = "USDT") {
    // planType: "profit_plan" | "loss_plan"
    return this._request("POST", "/api/mix/v1/plan/placeTPSL", {}, {
      symbol:       symbol + "_UMCBL",
      marginCoin,
      planType,
      triggerPrice: triggerPrice.toString(),
      triggerType:  "market_price",
      holdSide,
      size:         size.toString(),
    });
  }

  // Cancel semua plan orders (TP/SL)
  async cancelAllPlanOrders(symbol, planType = "profit_loss", marginCoin = "USDT") {
    return this._request("POST", "/api/mix/v1/plan/cancelAllPlan", {}, {
      symbol:    symbol + "_UMCBL",
      marginCoin,
      planType,
    });
  }
}

module.exports = BitgetClient;
