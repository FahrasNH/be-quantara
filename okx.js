// ─────────────────────────────────────────────
// okx.js — OKX REST API V5 Client
// Handles authentication, signing, dan semua
// endpoint yang dibutuhkan bot (Perpetual Swap)
//
// OKX specific notes:
//   - Symbol format : "BTC-USDT-SWAP" (bukan "BTCUSDT")
//   - Auth timestamp: ISO 8601 (bukan Unix ms)
//   - Demo trading  : tambah header x-simulated-trading: 1
//   - sz (size)     : jumlah contracts (1 BTC-USDT-SWAP = 0.01 BTC)
//   - posSide       : "long" | "short" (hedge mode)
//   - Response OK   : code === "0" (bukan "00000" seperti Bitget)
// ─────────────────────────────────────────────

const axios  = require("axios");
const crypto = require("crypto");

const BASE_URL = "https://www.okx.com";

// Map interval → OKX bar
const BAR_MAP = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1H": "1H", "2H": "2H", "4H": "4H", "6H": "6H", "12H": "12H",
  "1D": "1D", "1W": "1W",
};

/**
 * Convert symbol BTCUSDT → BTC-USDT-SWAP
 * Bisa juga terima langsung "BTC-USDT-SWAP"
 */
function toInstId(symbol) {
  if (symbol.includes("-")) return symbol; // sudah dalam format OKX
  const base = symbol.replace("USDT", "").replace("BUSD", "");
  return `${base}-USDT-SWAP`;
}

class OKXClient {
  /**
   * @param {string}  apiKey
   * @param {string}  secretKey
   * @param {string}  passphrase
   * @param {boolean} demo       true = Paper Trading (demo), false = Live
   */
  constructor(apiKey, secretKey, passphrase, demo = false) {
    this.apiKey     = apiKey;
    this.secretKey  = secretKey;
    this.passphrase = passphrase;
    this.demo       = demo;
  }

  // ── Signature (HMAC-SHA256, Base64) ──
  _sign(timestamp, method, path, body = "") {
    const message = timestamp + method.toUpperCase() + path + body;
    return crypto
      .createHmac("sha256", this.secretKey)
      .update(message)
      .digest("base64");
  }

  // ── Auth headers ──
  _headers(method, path, body = "") {
    const timestamp = new Date().toISOString(); // ISO 8601
    const sign      = this._sign(timestamp, method, path, body);
    const headers   = {
      "OK-ACCESS-KEY":       this.apiKey,
      "OK-ACCESS-SIGN":      sign,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.passphrase,
      "Content-Type":        "application/json",
    };
    if (this.demo) headers["x-simulated-trading"] = "1";
    return headers;
  }

  // ── Generic request (auth) ──
  async _request(method, path, params = {}, data = null) {
    try {
      let url        = BASE_URL + path;
      let pathFull   = path;

      if (method === "GET" && Object.keys(params).length > 0) {
        const qs    = "?" + new URLSearchParams(params).toString();
        url        += qs;
        pathFull   += qs;
      }

      const bodyStr = data ? JSON.stringify(data) : "";
      const headers = this._headers(method, pathFull, bodyStr);

      const response = await axios({
        method,
        url,
        headers,
        data: data || undefined,
        timeout: 10000,
      });

      const { code, msg, data: resData } = response.data;
      if (code !== "0") {
        throw new Error(`OKX API Error: ${msg} (code: ${code})`);
      }
      return resData;
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

  /**
   * Ambil OHLCV candles historis
   * @param {string} symbol   - "BTCUSDT" atau "BTC-USDT-SWAP"
   * @param {string} bar      - "4H", "1H", "1D", dll
   * @param {number} limit    - maks 300
   */
  async getCandles(symbol, bar = "4H", limit = 200) {
    const instId = toInstId(symbol);
    const okxBar = BAR_MAP[bar] || "4H";

    // OKX market data tidak perlu auth
    const extraHeaders = this.demo ? { "x-simulated-trading": "1" } : {};
    const response = await axios.get(`${BASE_URL}/api/v5/market/candles`, {
      params:  { instId, bar: okxBar, limit: limit.toString() },
      headers: extraHeaders,
      timeout: 10000,
    });

    const { code, msg, data } = response.data;
    if (code !== "0") throw new Error(`OKX candles error: ${msg} (${code})`);

    // OKX returns [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm], newest first
    return data.reverse().map(c => ({
      timestamp: parseInt(c[0]),
      date:      new Date(parseInt(c[0])).toISOString().slice(0, 10),
      open:      parseFloat(c[1]),
      high:      parseFloat(c[2]),
      low:       parseFloat(c[3]),
      close:     parseFloat(c[4]),
      volume:    parseFloat(c[5]),
    }));
  }

  /**
   * Harga real-time (last price, best bid/ask)
   */
  async getTicker(symbol) {
    const instId   = toInstId(symbol);
    const response = await axios.get(`${BASE_URL}/api/v5/market/ticker`, {
      params:  { instId },
      timeout: 5000,
    });

    const { code, msg, data } = response.data;
    if (code !== "0") throw new Error(`OKX ticker error: ${msg} (${code})`);

    const d = data[0];
    return {
      symbol,
      instId,
      last:      parseFloat(d.last),
      bestBid:   parseFloat(d.bidPx),
      bestAsk:   parseFloat(d.askPx),
      change24h: ((parseFloat(d.last) - parseFloat(d.open24h)) / parseFloat(d.open24h)) * 100,
    };
  }

  // ─────────────────────────────────────────────
  // ACCOUNT (butuh auth)
  // ─────────────────────────────────────────────

  /**
   * Saldo akun trading (USDT)
   */
  async getBalance(ccy = "USDT") {
    const data   = await this._request("GET", "/api/v5/account/balance", { ccy });
    const detail = data[0]?.details?.find(d => d.ccy === ccy);
    return {
      available:    parseFloat(detail?.availBal   ?? 0),
      equity:       parseFloat(detail?.eq         ?? 0),
      unrealizedPL: parseFloat(detail?.upl        ?? 0),
    };
  }

  /**
   * Semua posisi terbuka (Perpetual Swap)
   */
  async getPositions(symbol) {
    const instId = toInstId(symbol);
    const data   = await this._request("GET", "/api/v5/account/positions", {
      instType: "SWAP",
      instId,
    });

    if (!Array.isArray(data)) return [];
    return data
      .filter(p => parseFloat(p.pos) !== 0)
      .map(p => ({
        symbol:       symbol,
        instId:       p.instId,
        side:         p.posSide === "long" ? "LONG" : "SHORT",
        size:         Math.abs(parseFloat(p.pos)),           // contracts
        entryPrice:   parseFloat(p.avgPx),
        unrealizedPL: parseFloat(p.upl),
        leverage:     parseInt(p.lever),
        liquidationPrice: parseFloat(p.liqPx || 0),
      }));
  }

  /**
   * Riwayat order terakhir
   */
  async getOrderHistory(symbol, limit = 20) {
    const instId = toInstId(symbol);
    const data   = await this._request("GET", "/api/v5/trade/orders-history", {
      instType: "SWAP",
      instId,
      limit:    limit.toString(),
    });
    return Array.isArray(data) ? data : [];
  }

  // ─────────────────────────────────────────────
  // TRADING (butuh auth)
  // ─────────────────────────────────────────────

  /**
   * Set leverage
   */
  async setLeverage(symbol, leverage) {
    const instId = toInstId(symbol);
    return this._request("POST", "/api/v5/account/set-leverage", {}, {
      instId,
      lever:   leverage.toString(),
      mgnMode: "cross",
    });
  }

  /**
   * Set margin mode (cross/isolated)
   * OKX: setLeverage sudah mencakup mgnMode
   */
  async setMarginMode(symbol, mode = "cross") {
    return this.setLeverage(symbol, 3); // OKX set leverage = set mode sekaligus
  }

  /**
   * Buka posisi (market order, hedge mode)
   * @param {string} symbol
   * @param {string} side   - "open_long" | "open_short"
   * @param {number} sz     - jumlah contracts
   */
  async openPosition(symbol, side, sz) {
    const instId  = toInstId(symbol);
    const isLong  = side === "open_long";
    const data    = await this._request("POST", "/api/v5/trade/order", {}, {
      instId,
      tdMode:  "cross",
      side:    isLong ? "buy"  : "sell",
      posSide: isLong ? "long" : "short",
      ordType: "market",
      sz:      sz.toString(),
    });
    return data[0] ?? {};
  }

  /**
   * Tutup posisi (close-position endpoint — lebih aman dari market order)
   * @param {string} symbol
   * @param {string} side   - "close_long" | "close_short"
   * @param {number} sz     - jumlah contracts (optional, close all jika kosong)
   */
  async closePosition(symbol, side, sz) {
    const instId  = toInstId(symbol);
    const posSide = side === "close_long" ? "long" : "short";

    if (sz) {
      // Partial close via trade order
      const data = await this._request("POST", "/api/v5/trade/order", {}, {
        instId,
        tdMode:  "cross",
        side:    posSide === "long" ? "sell" : "buy",
        posSide,
        ordType: "market",
        sz:      sz.toString(),
      });
      return data[0] ?? {};
    }

    // Close all via close-position
    const data = await this._request("POST", "/api/v5/trade/close-position", {}, {
      instId,
      mgnMode: "cross",
      posSide,
    });
    return data[0] ?? {};
  }

  /**
   * Pasang TP & SL sekaligus (OCO algo order)
   * @param {string} symbol
   * @param {string} planType - "profit_plan" | "loss_plan" (tidak digunakan, OKX pakai OCO)
   * @param {string|number} triggerPrice
   * @param {string} holdSide - "long" | "short"
   * @param {number} sz       - contracts
   */
  async setTPSL(symbol, planType, triggerPrice, holdSide, sz) {
    // OKX: setTPSL dipanggil 2x dari index.js (profit_plan & loss_plan)
    // Kita map ke algo order tunggal per panggilan
    const instId  = toInstId(symbol);
    const isProfit = planType === "profit_plan";

    const body = {
      instId,
      tdMode:  "cross",
      side:    holdSide === "long" ? "sell" : "buy",
      posSide: holdSide,
      ordType: isProfit ? "conditional" : "conditional",
      sz:      sz.toString(),
    };

    if (isProfit) {
      body.tpTriggerPx  = triggerPrice.toString();
      body.tpTriggerPxType = "last";
      body.tpOrdPx      = "-1"; // market
    } else {
      body.slTriggerPx  = triggerPrice.toString();
      body.slTriggerPxType = "last";
      body.slOrdPx      = "-1"; // market
    }

    const data = await this._request("POST", "/api/v5/trade/order-algo", {}, body);
    return data[0] ?? {};
  }

  /**
   * Cancel semua algo orders (TP/SL) untuk posisi tertentu
   */
  async cancelAllPlanOrders(symbol) {
    const instId = toInstId(symbol);
    const data   = await this._request("POST", "/api/v5/trade/cancel-algos", {}, [
      { instId, algoId: "" }, // OKX butuh list, kosongkan algoId = cancel all
    ]);
    return data;
  }

  // ── Utility ──
  /** Hitung jumlah contracts dari USDT size */
  static calcContractSize(capitalUsdt, riskPct, entryPrice, slPrice, contractMult = 0.01) {
    const riskAmt   = capitalUsdt * riskPct;
    const slDist    = Math.abs(entryPrice - slPrice);
    const contracts = Math.floor(riskAmt / (slDist * contractMult));
    return Math.max(contracts, 1);
  }

  /** Expose toInstId untuk keperluan luar */
  static toInstId = toInstId;
}

module.exports = OKXClient;
