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
    // Map interval ke kode Bitget V2
    const granMap = {
      "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
      "1H": "1h", "4H": "4h", "6H": "6h", "12H": "12h",
      "1D": "1d", "1W": "1w",
    };
    const gran = granMap[granularity] || "4h";

    const response = await axios.get(
      `${BASE_URL}/api/mix/v2/market/candles`,
      {
        params: {
          symbol: symbol + "_UMCBL",
          granularity: gran,
          limit: Math.min(limit, 200).toString()
        },
        timeout: 10000,
      }
    );

    if (!response.data?.data || !Array.isArray(response.data.data)) {
      throw new Error("Format candle tidak valid dari Bitget V2");
    }

    // V2 Format: [timestamp, open, high, low, close, baseVol, quoteVol]
    return response.data.data.map(c => ({
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
      `${BASE_URL}/api/mix/v2/market/ticker`,
      { params: { symbol: symbol + "_UMCBL" }, timeout: 5000 }
    );
    return {
      symbol,
      last:   parseFloat(response.data.data[0]?.last || 0),
      bestBid: parseFloat(response.data.data[0]?.bidPx || 0),
      bestAsk: parseFloat(response.data.data[0]?.askPx || 0),
      change24h: parseFloat(response.data.data[0]?.changeUtc24h || 0),
    };
  }

  // ─────────────────────────────────────────────
  // ACCOUNT (butuh auth)
  // ─────────────────────────────────────────────

  // Saldo akun futures
  async getBalance(marginCoin = "USDT") {
    const data = await this._request("GET", "/api/mix/v2/account/account", {
      productType: "umcbl",
      marginCoin,
    });
    // V2 returns array, ambil index 0
    const acct = Array.isArray(data) ? data[0] : data;
    return {
      available: parseFloat(acct?.available || 0),
      equity:    parseFloat(acct?.equity || 0),
      unrealizedPL: parseFloat(acct?.unrealizedPL || 0),
    };
  }

  // Posisi yang sedang terbuka
  async getPositions(symbol, productType = "umcbl") {
    const data = await this._request("GET", "/api/mix/v2/positions", {
      productType,
      marginCoin: "USDT",
    });

    if (!Array.isArray(data)) return [];
    return data
      .filter(p => p.instId === symbol + "_UMCBL" && parseFloat(p.positionQty || p.total || 0) > 0)
      .map(p => ({
        symbol: p.instId || p.symbol,
        side: (p.posSide || p.holdSide) === "long" ? "LONG" : "SHORT",
        size: parseFloat(p.positionQty || p.total || 0),
        entryPrice: parseFloat(p.openPrice || p.averageOpenPrice || 0),
        unrealizedPL: parseFloat(p.unrealizedPL || 0),
        leverage: parseInt(p.leverage || 0),
        liquidationPrice: parseFloat(p.liqPrice || p.liquidationPrice || 0),
      }));
  }

  // Riwayat order
  async getOrderHistory(symbol, limit = 20) {
    const data = await this._request("GET", "/api/mix/v2/orders-history", {
      instId: symbol + "_UMCBL",
      after: (Date.now() - 7 * 24 * 60 * 60 * 1000).toString(),
      before: Date.now().toString(),
      limit: Math.min(limit, 100).toString(),
    });
    return Array.isArray(data) ? data : [];
  }

  // ─────────────────────────────────────────────
  // TRADING (butuh auth)
  // ─────────────────────────────────────────────

  // Set leverage
  async setLeverage(symbol, leverage, marginCoin = "USDT") {
    return this._request("POST", "/api/mix/v2/account/set-leverage", {}, {
      instId: symbol + "_UMCBL",
      marginCoin,
      leverage: leverage.toString(),
      posSide: "long_short",
    });
  }

  // Set margin mode
  async setMarginMode(symbol, mode = "crossed", marginCoin = "USDT") {
    return this._request("POST", "/api/mix/v2/account/set-margin-mode", {}, {
      instId: symbol + "_UMCBL",
      marginCoin,
      marginMode: mode, // crossed atau fixed
    });
  }

  // Buka posisi (market order)
  async openPosition(symbol, side, size, marginCoin = "USDT") {
    // side: "open_long" | "open_short"
    // Map V1 side ke V2 format
    const sideMap = {
      "open_long": { side: "buy", posSide: "long" },
      "open_short": { side: "sell", posSide: "short" },
    };
    const sideInfo = sideMap[side] || { side: "buy", posSide: "long" };

    return this._request("POST", "/api/mix/v2/orders/place-order", {}, {
      instId:       symbol + "_UMCBL",
      marginCoin,
      size:         size.toString(),
      side:         sideInfo.side,
      posSide:      sideInfo.posSide,
      orderType:    "market",
      force:        "net_mode",
    });
  }

  // Tutup posisi (market order)
  async closePosition(symbol, side, size, marginCoin = "USDT") {
    // side: "close_long" | "close_short"
    // Map V1 side ke V2 format
    const sideMap = {
      "close_long": { side: "sell", posSide: "long" },
      "close_short": { side: "buy", posSide: "short" },
    };
    const sideInfo = sideMap[side] || { side: "sell", posSide: "long" };

    return this._request("POST", "/api/mix/v2/orders/place-order", {}, {
      instId:       symbol + "_UMCBL",
      marginCoin,
      size:         size.toString(),
      side:         sideInfo.side,
      posSide:      sideInfo.posSide,
      orderType:    "market",
      force:        "net_mode",
    });
  }

  // Pasang Stop Loss & Take Profit (plan order)
  async setTPSL(symbol, planType, triggerPrice, posSide, size, marginCoin = "USDT") {
    // planType: "profit_plan" | "loss_plan"
    // Map to V2 format (plan types are similar)
    const typeMap = {
      "profit_plan": "profit_plan",
      "loss_plan": "loss_plan",
    };
    const pType = typeMap[planType] || planType;

    return this._request("POST", "/api/mix/v2/orders/place-plan-order", {}, {
      instId:        symbol + "_UMCBL",
      marginCoin,
      planType:      pType,
      triggerPrice:  triggerPrice.toString(),
      triggerType:   "market_price",
      posSide,
      size:          size.toString(),
    });
  }

  // Cancel semua plan orders (TP/SL)
  async cancelAllPlanOrders(symbol, planType = "profit_loss", marginCoin = "USDT") {
    return this._request("POST", "/api/mix/v2/orders/cancel-all-plan-orders", {}, {
      instId:    symbol + "_UMCBL",
      marginCoin,
      planType,
    });
  }
}

module.exports = BitgetClient;
