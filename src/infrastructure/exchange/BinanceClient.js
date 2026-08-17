const log = require("#shared/logger").child({ component: "BinanceClient" });
// ─────────────────────────────────────────────────────────────────────────────
// BinanceClient.js — Binance USDT-M Futures via CCXT
// ─────────────────────────────────────────────────────────────────────────────

const CcxtFuturesClient = require("./CcxtFuturesClient");
const { toRawSymbol, toCcxtSymbol } = require("./ccxtSymbol");

class BinanceClient extends CcxtFuturesClient {
  constructor(apiKey, secretKey) {
    super("binance", apiKey, secretKey, "", { defaultType: "future" });
  }

  async getPerpetualSymbols() {
    const markets = await this.exchange.loadMarkets();
    const out = [];
    for (const m of Object.values(markets)) {
      if (!m.swap || !m.linear) continue;
      if (m.quote !== "USDT") continue;
      if (m.active === false) continue;
      out.push({
        symbol: `${m.base}USDT`,
        baseAsset: m.base,
        quoteAsset: m.quote,
        minQty: m.limits?.amount?.min ?? null,
      });
    }
    out.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return out;
  }

  /**
   * Override setTPSL for Binance USDT-M Futures.
   *
   * ⚠️ BUG FIX (naked-position incident, LAB/USDT live): the previous version passed
   * type:"stopMarket" / "takeProfitMarket" as the CCXT order type. CCXT does NOT
   * recognise those as unified types — it uppercases to "STOPMARKET", which is not in
   * the market's `info.orderTypes`, so Binance rejects with
   *   "binance stopMarket is not a valid order type for the X market".
   * SL/TP then never placed → position ran naked → BotEngine emergency-closed in a
   * loop (5×/6min). See binance.js createOrderRequest: STOP_MARKET / TAKE_PROFIT_MARKET
   * are reached ONLY via the unified `stopLossPrice` / `takeProfitPrice` PARAM on a
   * `market` order (isStopLoss / isTakeProfit), never via a type string.
   *
   * Correct Binance-native approach:
   *   - type:"market" + stopLossPrice|takeProfitPrice → CCXT maps to STOP_MARKET / TAKE_PROFIT_MARKET
   *   - closePosition:true  → close the FULL position on trigger (no quantity → no lot-size mismatch;
   *                           binance.js keeps quantityIsRequired=false when closePosition is set)
   *   - workingType:MARK_PRICE → trigger on mark price (anti-manipulation)
   *   - priceProtect:true   → reject triggers too close to mark price
   *
   * Falls back to explicit size+reduceOnly if closePosition is rejected (e.g. the
   * position was partially filled before the SL is placed).
   */
  async setTPSL(symbol, planType, triggerPrice, holdSide, size) {
    const isTP     = planType === "profit_plan";
    const isLong   = holdSide === "long";
    const closeSide = isLong ? "sell" : "buy";
    const marketSymbol = this._marketSymbol(symbol);
    const trigPrice = this._fmtPrice(marketSymbol, triggerPrice);
    // The unified param that CCXT translates into STOP_MARKET / TAKE_PROFIT_MARKET.
    const priceKey = isTP ? "takeProfitPrice" : "stopLossPrice";
    const errors = [];

    // ── Pendekatan 1: closePosition (tidak perlu size — paling robust) ────────
    try {
      const order = await this.exchange.createOrder(
        marketSymbol,
        "market",
        closeSide,
        undefined,  // no quantity when closePosition=true
        undefined,
        {
          [priceKey]:    trigPrice,
          closePosition: "true",
          workingType:   "MARK_PRICE",
          priceProtect:  "true",
        }
      );
      return { success: true, method: "binanceClosePosition", orderId: order.id };
    } catch (e1) {
      errors.push(`binanceClosePosition: ${e1.message}`);
    }

    // ── Pendekatan 2: size + reduceOnly (fallback jika closePosition ditolak) ─
    try {
      const order = await this.exchange.createOrder(
        marketSymbol,
        "market",
        closeSide,
        size,
        undefined,
        {
          [priceKey]:  trigPrice,
          reduceOnly:  true,
          workingType: "MARK_PRICE",
        }
      );
      return { success: true, method: "binanceReduceOnly", orderId: order.id };
    } catch (e2) {
      errors.push(`binanceReduceOnly: ${e2.message}`);
    }

    const detail = errors.join(" | ");
    log.warn(`[setTPSL Binance] Semua pendekatan gagal (${planType}): ${detail}`);
    return { success: false, message: detail };
  }

  /**
   * Map a raw Binance/CCXT error to a SPECIFIC, actionable diagnosis.
   *
   * Why: the previous implementation emitted ONE generic message ("periksa key /
   * IP whitelist / Futures") for EVERY failure mode. Clock drift, geo-block and
   * network timeouts have nothing to do with the key or the IP whitelist, so the
   * message actively pointed users at the wrong thing. Mirrors the per-code
   * mapping OkxClient already does (50110 → IP whitelist).
   *
   * @param {Error} err
   * @returns {{ code: string, message: string }}
   */
  static diagnoseError(err) {
    const raw = String(err?.message || "");
    const status = err?.httpStatus ?? err?.statusCode ?? null;

    // Clock drift — the single most common VPS failure, and NOT a key/IP issue.
    if (/-1021/.test(raw) || /timestamp for this request/i.test(raw) || /recvWindow/i.test(raw)) {
      return {
        code: "BINANCE_CLOCK_DRIFT",
        message:
          "Jam server tidak sinkron dengan Binance (error -1021). Ini BUKAN masalah API key atau IP whitelist. "
          + "Perbaiki dengan menyalakan NTP di server: `timedatectl set-ntp true` lalu coba lagi.",
      };
    }

    // Signature mismatch — usually a mangled secret (trailing space / wrong key pair).
    if (/-1022/.test(raw) || /signature for this request is not valid/i.test(raw)) {
      return {
        code: "BINANCE_BAD_SIGNATURE",
        message:
          "Signature ditolak Binance (error -1022). Secret key kemungkinan salah atau tersalin tidak lengkap. "
          + "Salin ulang API secret dari Binance tanpa spasi tambahan.",
      };
    }

    // Geo-restriction — Binance answers 451 for blocked jurisdictions.
    if (status === 451 || /restricted location/i.test(raw) || /eligibility/i.test(raw)) {
      return {
        code: "BINANCE_GEO_RESTRICTED",
        message:
          "Binance memblokir permintaan dari lokasi server ini (HTTP 451). Ini BUKAN masalah API key. "
          + "Gunakan server di region yang diizinkan Binance.",
      };
    }

    // Network / DNS — nothing to do with credentials.
    if (/ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket hang up|network|timeout/i.test(raw)) {
      return {
        code: "BINANCE_NETWORK_ERROR",
        message:
          "Server tidak bisa menjangkau Binance (masalah jaringan/DNS). Ini BUKAN masalah API key. "
          + "Cek koneksi keluar server ke api.binance.com dan fapi.binance.com.",
      };
    }

    // Genuine key / IP / permission rejection.
    if (/-2015/.test(raw) || /invalid api-key/i.test(raw) || /-2008/.test(raw)) {
      return {
        code: "BINANCE_KEY_OR_IP_REJECTED",
        message:
          "Binance menolak API key (error -2015). Periksa: (1) API key/secret benar, "
          + "(2) IP publik server ada di whitelist API key, (3) 'Enable Futures' aktif. "
          + "Catatan: perubahan whitelist Binance butuh beberapa menit untuk aktif.",
      };
    }

    if (/-2014/.test(raw) || /api-key format invalid/i.test(raw)) {
      return {
        code: "BINANCE_KEY_FORMAT_INVALID",
        message: "Format API key tidak valid (error -2014). Salin ulang API key dari Binance.",
      };
    }

    return {
      code: "BINANCE_VALIDATION_FAILED",
      message: `Gagal memverifikasi API key Binance: ${raw || "penyebab tidak diketahui"}`,
    };
  }

  /**
   * Validate that the key can do what the bot actually needs.
   *
   * Order matters (changed deliberately):
   *   1. FUTURES capability via fapi (fetchBalance) — this is the real gate; it
   *      proves the key works on the domain the bot trades on.
   *   2. Withdrawal restriction via SAPI (api.binance.com, SPOT domain) — a
   *      security check, kept, but no longer able to block a perfectly good
   *      futures key when the SPOT domain is the thing that's failing.
   *
   * Previously step 2 was the ONLY gate, so a key that could trade futures fine
   * was still rejected whenever the unrelated SPOT endpoint failed.
   */
  async validatePermissions() {
    // ── 1. Futures capability (fapi.binance.com) — the gate that matters ──────
    try {
      await this.exchange.fetchBalance({ type: "future" });
    } catch (err) {
      const diag = BinanceClient.diagnoseError(err);
      const e = new Error(diag.message);
      e.statusCode = 400;
      e.code = diag.code;
      e.originalMessage = err.message;
      throw e;
    }

    // ── 2. Withdrawal permission (sapi / SPOT domain) — security check ────────
    const truthy = (v) => v === true || v === "true" || v === 1 || v === "1";
    let restrictions = null;
    let withdrawalCheckSkipped = null;

    try {
      const fetchRestrictions = this.exchange.sapiGetAccountApiRestrictions;
      if (typeof fetchRestrictions !== "function") {
        throw new Error("CCXT Binance SAPI apiRestrictions method unavailable");
      }
      restrictions = await fetchRestrictions.call(this.exchange);
    } catch (err) {
      // Futures already proved the key is valid and reachable, so a SPOT-domain
      // failure must NOT block onboarding. Surface it instead of hiding it: the
      // caller audits `withdrawalCheckSkipped` so a skipped security check is
      // never silent.
      withdrawalCheckSkipped = BinanceClient.diagnoseError(err).message;
      log.warn(`[Binance validate] Withdrawal check dilewati — ${withdrawalCheckSkipped}`);
      return { ok: true, futures: true, withdrawal: null, withdrawalCheckSkipped };
    }

    if (truthy(restrictions?.enableWithdrawals)) {
      const e = new Error(
        "Withdrawal permission terdeteksi pada API key. Cabut izin withdrawal di pengaturan API Binance sebelum menghubungkan."
      );
      e.statusCode = 400;
      e.code = "WITHDRAWAL_PERMISSION_DETECTED";
      throw e;
    }

    // Futures already verified live above; this flag is only a secondary signal.
    if (!truthy(restrictions?.enableFutures)) {
      log.warn("[Binance validate] apiRestrictions.enableFutures=false tetapi fapi balance berhasil — mengikuti hasil fapi.");
    }

    return { ok: true, futures: true, withdrawal: false };
  }
}

module.exports = BinanceClient;
module.exports.toRawSymbol = toRawSymbol;
module.exports.toCcxtSymbol = toCcxtSymbol;
