/**
 * historicalData.js — Loader OHLCV historis NYATA dari exchange (paginasi).
 *
 * Dipakai backtest mode --real untuk menarik banyak candle historis (lebih dari
 * limit per-request, default Bitget 500) dengan paginasi maju via startTime.
 *
 * CATATAN: butuh akses jaringan ke exchange. Di environment yang mem-proxy/blokir
 * exchange, jalankan di mesin yang bisa menjangkau API (mis. VPS produksi).
 *
 * @returns {Promise<Array<{timestamp,open,high,low,close,volume}>>} terurut naik
 */

"use strict";

const TF_MS = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000,
  "12h": 43_200_000, "1d": 86_400_000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{getCandles: Function}} client — exchange client (BitgetClient)
 * @param {string} symbol
 * @param {string} timeframe  mis. "15m", "1h"
 * @param {number} days       berapa hari ke belakang
 * @param {{batchLimit?:number, pauseMs?:number, onProgress?:Function}} [opts]
 */
async function fetchHistoricalCandles(client, symbol, timeframe, days, opts = {}) {
  const tf = String(timeframe).toLowerCase();
  const tfMs = TF_MS[tf];
  if (!tfMs) throw new Error(`Timeframe tidak didukung: ${timeframe}`);

  const batchLimit = opts.batchLimit || 500;
  const pauseMs    = opts.pauseMs ?? 150;
  const now        = Date.now();
  let start        = now - days * 86_400_000;

  const byTs = new Map(); // dedup by timestamp
  let guard = 0;
  const maxIters = Math.ceil((days * 86_400_000) / (tfMs * batchLimit)) + 5;

  while (start < now && guard++ < maxIters + 50) {
    let batch;
    try {
      batch = await client.getCandles(symbol, tf, batchLimit, start);
    } catch (e) {
      // Coba sekali lagi setelah jeda; kalau tetap gagal, hentikan dengan data sejauh ini.
      await sleep(500);
      try { batch = await client.getCandles(symbol, tf, batchLimit, start); }
      catch { break; }
    }
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const c of batch) byTs.set(c.timestamp, c);

    const lastTs = batch[batch.length - 1].timestamp;
    if (!Number.isFinite(lastTs) || lastTs <= start) break; // no progress → stop
    start = lastTs + tfMs;

    if (opts.onProgress) opts.onProgress(byTs.size, new Date(lastTs).toISOString());
    if (pauseMs) await sleep(pauseMs);
  }

  return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
}

module.exports = { fetchHistoricalCandles, TF_MS };
