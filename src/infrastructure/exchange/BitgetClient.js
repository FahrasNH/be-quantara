// ─────────────────────────────────────────────
// bitget-ccxt.js — Bitget Client menggunakan CCXT
// CCXT adalah library unified yang support Bitget V2
// ─────────────────────────────────────────────

const ccxt = require("ccxt");
const axios = require("axios");
const https = require("https");

const BITGET_BASE = "https://api.bitget.com";
const { withExchangeGate } = require("./exchangeRateGate");
const RETRYABLE_RE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|socket disconnected|TLS|timeout|network|aborted/i;
// Rate-limit signals — Bitget's vocabulary (HTTP 429 / code 30007 "request over limit"
// / "too many requests" / "too frequent"). Same class of bug as the OKX 50011 candle
// incident; retried with backoff in getCandles so a burst degrades gracefully, not hard.
const RATE_LIMIT_RE = /Too many requests|too frequent|over limit|rate.?limit|ratelimit|\b429\b|\b30007\b/i;

// Paksa IPv4 — sering lebih stabil dari IPv6 untuk api.bitget.com di beberapa jaringan.
const httpsAgent = new https.Agent({ family: 4, keepAlive: true });

async function bitgetGet(path, params, { retries = 3, timeout = 25_000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const { data } = await axios.get(`${BITGET_BASE}${path}`, {
        params,
        timeout,
        httpsAgent,
        headers: { "User-Agent": "QuantaraBot/2.0" },
      });
      return data;
    } catch (err) {
      lastErr = err;
      const msg = err.message || "";
      if (attempt < retries - 1 && RETRYABLE_RE.test(msg)) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function isNetworkError(err) {
  return RETRYABLE_RE.test(err?.message || "");
}
const TF_MAP = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "12h": "12H",
  "1d": "1D", "1w": "1W",
};

function toRawSymbol(symbol) {
  if (!symbol) return "BTCUSDT";
  if (symbol.includes("/")) return symbol.split("/")[0].toUpperCase() + "USDT";
  return symbol.toUpperCase();
}

class BitgetCCXTClient {
  constructor(apiKey, secretKey, passphrase) {
    // Trim kredensial — spasi/newline tersembunyi saat paste = signature gagal.
    const trim = (v) => (typeof v === "string" ? v.trim() : v);
    apiKey     = trim(apiKey);
    secretKey  = trim(secretKey);
    passphrase = trim(passphrase);

    this.exchange = new ccxt.bitget({
      apiKey,
      secret: secretKey,
      password: passphrase,
      enableRateLimit: true,
      rateLimit: 100,
      sandbox: false,
      options: {
        defaultType: "swap",
        defaultSettle: "USDT",
      },
    });
    this.symbol = null;
  }

  /**
   * Format harga ke presisi tick-size market. Fallback ke angka mentah bila
   * market belum dimuat — jangan paksa 2 desimal (merusak SL/TP koin murah).
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

  /** Public market data via Bitget Mix API — hindari CCXT loadMarkets (spot/coins). */
  async _fetchMixCandles(symbol, timeframe = "4h", limit = 200, since = undefined) {
    const params = {
      symbol: toRawSymbol(symbol),
      productType: "USDT-FUTURES",
      granularity: TF_MAP[String(timeframe).toLowerCase()] || timeframe,
      limit: Math.min(limit, 500),
    };
    if (since) params.startTime = String(since);

    const data = await bitgetGet("/api/v2/mix/market/candles", params);

    if (data?.code !== "00000" || !Array.isArray(data.data) || data.data.length === 0) {
      throw new Error(data?.msg || "No candles data received");
    }

    return data.data.map((c) => ({
      timestamp: parseInt(c[0], 10),
      date: new Date(parseInt(c[0], 10)).toISOString(),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  }

  async _fetchMixTicker(symbol) {
    const data = await bitgetGet("/api/v2/mix/market/ticker", {
      symbol: toRawSymbol(symbol),
      productType: "USDT-FUTURES",
    });

    if (data?.code !== "00000" || !Array.isArray(data.data) || !data.data[0]) {
      throw new Error(data?.msg || "No ticker data received");
    }

    const t = data.data[0];
    return {
      symbol: toRawSymbol(symbol),
      last: parseFloat(t.lastPr || t.close || 0),
      bestBid: parseFloat(t.bidPr || 0),
      bestAsk: parseFloat(t.askPr || 0),
      change24h: parseFloat(t.change24h || t.changeUtc24h || 0),
    };
  }

  // ─────────────────────────────────────────────
  // MARKET DATA
  // ─────────────────────────────────────────────

  async getCandles(symbol, timeframe = "4h", limit = 200, since = undefined) {
    for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await withExchangeGate("bitget", () =>
        this._fetchMixCandles(symbol, timeframe, limit, since)
      );
    } catch (directErr) {
      // Rate-limit (Bitget 429 / over-limit): backoff & retry endpoint langsung
      // sebelum degradasi — mirror fix getCandles OKX/Binance (insiden HBAR 50011).
      if (attempt < 2 && RATE_LIMIT_RE.test(directErr.message || "")) {
        await new Promise((r) => setTimeout(r, 600 * Math.pow(3, attempt)));
        continue;
      }
      // Jangan fallback ke CCXT untuk error jaringan — endpoint sama, hanya lebih lambat.
      if (isNetworkError(directErr)) {
        throw new Error(`getCandles error: ${directErr.message}`);
      }
      try {
        let marketSymbol = symbol;
        if (!marketSymbol.includes("/")) {
          const base = marketSymbol.slice(0, -4);
          marketSymbol = `${base}/USDT:USDT`;
        }
        const candles = await withExchangeGate("bitget", () =>
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
      } catch {
        throw new Error(`getCandles error: ${directErr.message}`);
      }
    }
    }
  }

  async getTicker(symbol) {
    try {
      return await this._fetchMixTicker(symbol);
    } catch (directErr) {
      if (isNetworkError(directErr)) {
        throw new Error(`getTicker error: ${directErr.message}`);
      }
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
      } catch {
        throw new Error(`getTicker error: ${directErr.message}`);
      }
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

      // Unrealized PnL nyata (#8) — defensif dari berbagai sumber termasuk
      // raw Bitget `info.data[]` (CCXT sering tidak mengisi coin.unrealizedPnl).
      const unrealizedPL = this._extractUnrealizedPL(balance, marginCoin);

      if (!coin) {
        // Fallback (dari HEAD): objek coin tak ketemu → baca peta root-level
        // balance.free/used/total[marginCoin] langsung agar tetap robust.
        const free  = balance?.free?.[marginCoin]  ?? 0;
        const used  = balance?.used?.[marginCoin]  ?? 0;
        const total = balance?.total?.[marginCoin] ?? 0;
        if (total > 0 || free > 0) {
          return { available: free, equity: total || (free + used + unrealizedPL), unrealizedPL };
        }
        return { available: 0, equity: 0, unrealizedPL: 0 };
      }

      // Equity = saldo + margin terkunci + floating PnL. `coin.total` (free+used)
      // dari CCXT umumnya SUDAH termasuk unrealized untuk swap; jika tidak, kita
      // jadikan equity = total bila tersedia, else (free+used)+unrealized.
      const free  = coin.free ?? coin.available ?? 0;
      const used  = coin.used ?? 0;
      const total = Number.isFinite(coin.total) ? coin.total : free + used;
      const equity = total > 0 ? total : free + used + unrealizedPL;

      return { available: free, equity, unrealizedPL };
    } catch (err) {
      throw new Error(`getBalance error: ${err.message}`);
    }
  }

  /**
   * Ekstrak unrealized PnL (USDT) dari respons fetchBalance Bitget secara defensif.
   * Bitget V2 mengembalikan array akun di `info.data[]` dengan field
   * `unrealizedPL`/`crossedUnrealizedPL`/`isolatedUnrealizedPL`.
   * @returns {number} 0 bila tak ditemukan.
   */
  _extractUnrealizedPL(balance, marginCoin = "USDT") {
    try {
      const coin = balance[marginCoin] || {};
      // 1) CCXT kadang sudah menyediakan langsung
      const direct = coin.unrealizedPnl ?? coin.unrealizedPL;
      if (Number.isFinite(Number(direct))) return Number(direct);

      // 2) Raw Bitget payload
      const data = balance?.info?.data;
      const rows = Array.isArray(data) ? data : (data ? [data] : []);
      const row  = rows.find(r => (r.marginCoin || r.coin) === marginCoin) || rows[0];
      if (row) {
        const u = row.unrealizedPL ?? row.crossedUnrealizedPL ?? row.isolatedUnrealizedPL
               ?? ((Number(row.crossedUnrealizedPL) || 0) + (Number(row.isolatedUnrealizedPL) || 0));
        if (Number.isFinite(Number(u))) return Number(u);
      }
    } catch { /* abaikan — fallback 0 */ }
    return 0;
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

  /**
   * Ambil total fee aktual (trading fee, dalam USDT) dari fills suatu posisi.
   * Menjumlahkan fee.cost dari fetchMyTrades sejak posisi dibuka — mencakup
   * fill entry maupun exit yang terjadi pada window tersebut.
   *
   * @param {string} symbol   — e.g. "SOLUSDT"
   * @param {number} openedAt — timestamp ms saat posisi dibuka
   * @returns {number|null}   — total fee absolut (≥0), atau null jika tak tersedia.
   *                            Caller wajib fallback ke estimasi notional × feeRate.
   */
  async getRecentFillFee(symbol, openedAt = 0) {
    try {
      let marketSymbol = symbol;
      if (!marketSymbol.includes("/")) {
        const base = marketSymbol.slice(0, -4);
        marketSymbol = `${base}/USDT:USDT`;
      }

      let fills = [];
      try {
        fills = await this.exchange.fetchMyTrades(marketSymbol, openedAt || undefined, 50);
      } catch {
        return null; // exchange tidak support → caller fallback ke estimasi
      }
      if (!Array.isArray(fills) || fills.length === 0) return null;

      const relevant = fills.filter(f => (f.timestamp || 0) >= (openedAt || 0));
      if (relevant.length === 0) return null;

      // CCXT menormalkan fee ke { cost, currency }. Bisa juga di array `fees`.
      let total = 0;
      let found = false;
      for (const f of relevant) {
        const single = f.fee && Number.isFinite(f.fee.cost) ? Math.abs(f.fee.cost) : 0;
        const multi  = Array.isArray(f.fees)
          ? f.fees.reduce((s, x) => s + (Number.isFinite(x?.cost) ? Math.abs(x.cost) : 0), 0)
          : 0;
        const fee = single || multi;
        if (fee > 0) { total += fee; found = true; }
      }
      return found ? total : null;
    } catch {
      return null; // non-fatal — caller fallback ke estimasi
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
    // Benar-benar set margin mode di exchange (#10) — sebelumnya no-op yang
    // mengembalikan success palsu, sehingga akun isolated bisa likuidasi beda
    // dari asumsi. CCXT memakai "cross"/"isolated".
    let marketSymbol = symbol;
    if (!marketSymbol.includes("/")) {
      const base = marketSymbol.slice(0, -4);
      marketSymbol = `${base}/USDT:USDT`;
    }
    const ccxtMode = mode === "crossed" ? "cross" : mode; // normalisasi istilah

    try {
      await this.exchange.setMarginMode(ccxtMode, marketSymbol, { marginCoin });
      return { success: true, mode: ccxtMode };
    } catch (err) {
      const msg = (err.message || "").toLowerCase();
      // Bitget menolak ubah mode bila SUDAH mode itu, atau ada posisi/order terbuka.
      // Kasus "tidak berubah" aman; kasus posisi terbuka → mode existing dipakai.
      const benign =
        msg.includes("no need") || msg.includes("not change") ||
        msg.includes("same") || msg.includes("already") ||
        msg.includes("position") || msg.includes("40797") || msg.includes("45117");
      if (benign) {
        return { success: true, mode: ccxtMode, note: "unchanged_or_has_position" };
      }
      console.warn(`setMarginMode gagal: ${err.message}`);
      return { success: false, mode: ccxtMode, error: err.message };
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
      // presetStopLossPrice & presetStopSurplusPrice dikirim bersamaan order masuk.
      // Pakai presisi tick-size, bukan parseFloat mentah, agar koin murah valid.
      if (slPrice) {
        extraParams.stopLoss = { triggerPrice: this._fmtPrice(marketSymbol, slPrice) };
      }
      if (tpPrice) {
        extraParams.takeProfit = { triggerPrice: this._fmtPrice(marketSymbol, tpPrice) };
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

  /**
   * FEE-02 — Entry maker/post-only dengan fallback taker.
   *
   * Pasang limit post-only di sisi PASIF (buy @ bestBid / sell @ bestAsk) agar
   * kena fee maker (~0.02%/sisi) bukan taker (~0.06%). Post-only TIDAK dijamin
   * fill → requote mengikuti harga beberapa kali; bila sampai timeout belum
   * penuh, SISA diselesaikan market (taker) supaya size tetap utuh (tidak ada
   * posisi setengah jadi). SL/TP TIDAK di-embed saat ada porsi maker — BotEngine
   * memasangnya terpisah setelah fill (presetSLTP:false). Caveat: post-only bisa
   * miss momentum → wajib A/B vs taker (lihat FEE-06). Default entryMode tetap
   * taker; rute ini hanya aktif saat entryMode="maker".
   *
   * @returns {{orderId, presetSLTP:boolean, entryFill:"maker"|"maker_partial"|"taker", filledMaker:number}}
   */
  async openPositionMaker(symbol, side, size, marginCoin = "USDT", slPrice = undefined, tpPrice = undefined, opts = {}) {
    const {
      maxRequotes    = 2,
      fillTimeoutMs  = 4000,
      pollIntervalMs = 700,
      fallbackTaker  = true,
    } = opts;

    let marketSymbol = symbol;
    if (!marketSymbol.includes("/")) {
      const base = marketSymbol.slice(0, -4);
      marketSymbol = `${base}/USDT:USDT`;
    }
    const isBuy     = side.includes("long");
    const direction = isBuy ? "buy" : "sell";
    const sleep     = (ms) => new Promise((r) => setTimeout(r, ms));

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
          { tradeSide: "open", postOnly: true }
        );
      } catch (err) {
        // Post-only yang akan langsung match ditolak exchange → requote lebih pasif.
        if (/post.?only|immediately|would match|40808|43025/i.test(err.message || "")) {
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
        } catch { /* terus polling — fetchOrder bisa gagal sementara */ }
      }

      if (status === "closed") {
        filledMaker = parseFloat((filledMaker + (filled || remaining)).toFixed(10));
        break;
      }

      // Belum penuh → batalkan sisa order yang masih open, lalu hitung fill final.
      try { await this.exchange.cancelOrder(order.id, marketSymbol); } catch { /* mungkin sudah ke-fill/cancel */ }
      try {
        const o = await this.exchange.fetchOrder(order.id, marketSymbol);
        filled = o.filled || filled;
      } catch { /* pakai nilai terakhir */ }
      filledMaker = parseFloat((filledMaker + (filled || 0)).toFixed(10));

      if (filled > 0) break; // partial fill → selesaikan sisa via taker, stop requote
    }

    const remaining = parseFloat((size - filledMaker).toFixed(10));

    if (remaining > 0 && fallbackTaker) {
      // Pure-taker (tak ada porsi maker) → aman embed SL/TP atomik. Bila sudah ada
      // porsi maker, biarkan BotEngine pasang SL/TP untuk SELURUH posisi terpisah.
      const embed = filledMaker <= 0;
      const taker = embed
        ? await this.openPosition(symbol, side, remaining, marginCoin, slPrice, tpPrice)
        : await this.openPosition(symbol, side, remaining, marginCoin);
      return {
        ...taker,
        orderId:    taker.orderId || lastOrderId,
        presetSLTP: embed ? !!(slPrice && tpPrice) && !!taker.presetSLTP : false,
        entryFill:  filledMaker > 0 ? "maker_partial" : "taker",
        filledMaker,
      };
    }

    return { orderId: lastOrderId, presetSLTP: false, entryFill: "maker", filledMaker };
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

    // Format symbol
    let marketSymbol = symbol;
    let rawSymbol    = symbol; // e.g. SOLUSDT (tanpa slash)
    if (!marketSymbol.includes("/")) {
      const base   = marketSymbol.slice(0, -4);
      marketSymbol = `${base}/USDT:USDT`;
    } else {
      rawSymbol = symbol.replace("/", "").replace(":USDT", "");
    }

    // Presisi tick-size, bukan 2-desimal paksa (rusak utk koin murah).
    const trigPrice = this._fmtPrice(marketSymbol, triggerPrice);

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
