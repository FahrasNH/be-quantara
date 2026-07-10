/**
 * TradeFeatureCollector.js — Feature Store (Sprint 1 / FS-3)
 *
 * Captures full market-state context (entryContext / exitContext) for every
 * trade and persists it into Trade.entryContext / Trade.exitContext via Prisma.
 *
 * Design principles:
 *  - Async-only: feature capture runs in a non-blocking queue
 *  - Silent-fail: errors are logged but NEVER propagate to the trading loop
 *  - Idempotent: safe to call multiple times for the same tradeId
 *
 * BotEngine integration (hook points):
 *  - Emit "beforeEntry" with ctx object → captureEntryFeatures(ctx)
 *  - Emit "beforeExit"  with ctx object → captureExitFeatures(ctx)
 */

"use strict";

const prisma = require("../../infrastructure/db/prismaClient");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Return last non-null value from an array, or null if none. */
function lastNN(arr) {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

/** Safe divide — returns null instead of Infinity/NaN. */
function safeDivide(a, b) {
  if (b == null || b === 0) return null;
  return a / b;
}

/**
 * Classify HTF regime from BotEngine htfTrend + indicator context.
 *
 * BotEngine exposes: htfTrend ("BULLISH"|"BEARISH"|"SIDEWAYS"|"UNKNOWN")
 * We map these to Feature Store vocabulary:
 *   BULLISH  → trending_up
 *   BEARISH  → trending_down
 *   SIDEWAYS → ranging
 *   UNKNOWN  → volatile (conservative label when no clear read)
 */
function classifyHtfRegime(htfTrend, adx) {
  const trend = String(htfTrend || "").toUpperCase();
  if (trend === "BULLISH")  return "trending_up";
  if (trend === "BEARISH")  return "trending_down";
  if (trend === "SIDEWAYS") return "ranging";
  // ADX-based fallback when BotEngine state is UNKNOWN
  if (adx != null) {
    if (adx >= 25) return "volatile";
    return "ranging";
  }
  return "volatile";
}

/**
 * Resolve trade type label from strategyKey.
 * Keeps parity with the tradeType vocabulary in FEATURE_STORE.md.
 */
function resolveTradeType(strategyKey) {
  const key = String(strategyKey || "").toUpperCase();
  if (key.includes("SCALP") || key === "PDF_SCALPING")  return "Scalping";
  if (key.includes("SWING"))                            return "Swing";
  return "Intraday";
}

// ─────────────────────────────────────────────────────────────────────────────
// TradeFeatureCollector
// ─────────────────────────────────────────────────────────────────────────────

class TradeFeatureCollector {
  constructor() {
    // Async queue: array of { fn } — drained sequentially without blocking caller
    this._queue = [];
    this._processing = false;
  }

  // ── Public capture API ────────────────────────────────────────────────────

  /**
   * Capture entry-context features from BotEngine context.
   *
   * @param {object} ctx  — { symbol, strategyKey, side, indicators, htfIndicators,
   *                          pairTier, config, capital, bot, htfTrend, confidence }
   * @returns {object} entryContext conforming to Feature Schema v1
   */
  async captureEntryFeatures(ctx) {
    try {
      const {
        symbol,
        strategyKey,
        indicators     = {},
        htfIndicators  = {},
        pairTier,
        config         = {},
        capital        = 0,
        htfTrend,
        confidence,
        signalComponents,
        afVotes,
      } = ctx || {};

      const price   = indicators.lastClose ?? indicators.close ?? config.lastPrice ?? 1;
      const atr     = indicators.atr   != null ? indicators.atr   : lastNN(indicators.atrArr);
      const rsi     = indicators.rsi   != null ? indicators.rsi   : lastNN(indicators.rsiArr);
      const ema9Val  = indicators.ema9  ?? indicators.emaFast  ?? lastNN(indicators.ema9Arr)  ?? null;
      const ema21Val = indicators.ema21 ?? indicators.emaMed   ?? lastNN(indicators.ema21Arr) ?? null;
      const ema50Val = indicators.ema50 ?? indicators.emaSlow  ?? lastNN(indicators.ema50Arr) ?? null;

      // Bollinger Band Width %: (upper - lower) / middle * 100
      const bbUpper  = indicators.bbUpper ?? lastNN(indicators.bbUpperArr);
      const bbLower  = indicators.bbLower ?? lastNN(indicators.bbLowerArr);
      const bbMiddle = indicators.bbMiddle ?? lastNN(indicators.bbMiddleArr);
      let bbWidth = 0;
      if (bbUpper != null && bbLower != null && bbMiddle != null && bbMiddle !== 0) {
        bbWidth = ((bbUpper - bbLower) / bbMiddle) * 100;
      }

      const volCurrent = indicators.volume ?? indicators.volumes?.[indicators.volumes.length - 1] ?? 0;
      const volAvg     = indicators.volSMA  ?? indicators.volAvg ?? lastNN(indicators.volSMAArr) ?? 1;
      const adx        = indicators.adx ?? htfIndicators.adx ?? null;

      const htfRegime = classifyHtfRegime(htfTrend ?? indicators.htfTrend, adx);

      // confidenceScore: normalise from 0-10 scale (Grok) or 0-100 as-is
      let confidenceScore = confidence ?? indicators.confidence ?? 50;
      if (confidenceScore > 0 && confidenceScore <= 10) confidenceScore = confidenceScore * 10;
      confidenceScore = Math.max(0, Math.min(100, Math.round(confidenceScore)));

      const entryContext = {
        capturedAt:       new Date().toISOString(),
        htfRegime,
        atr:              atr ?? 0,
        atrPct:           price > 0 ? +((atr ?? 0) / price * 100).toFixed(4) : 0,
        ema9:             ema9Val  ?? price,
        ema21:            ema21Val ?? price,
        ema50:            ema50Val ?? price,
        adx:              adx ?? null,
        rsi:              rsi ?? 50,
        bbWidth:          +bbWidth.toFixed(4),
        volume24h:        indicators.volume24h ?? volCurrent,
        volumeRatio:      +(safeDivide(volCurrent, volAvg) ?? 1).toFixed(4),
        spread:           indicators.spread ?? 0,
        fundingRate:      indicators.fundingRate ?? null,
        strategyKey:      strategyKey ?? config.strategyKey ?? "UNKNOWN",
        tradeType:        resolveTradeType(strategyKey ?? config.strategyKey),
        confidenceScore,
        signalComponents: signalComponents ?? indicators.signalComponents ?? {},
        afVotes:          afVotes ?? indicators.afVotes ?? null,
        pairTier:         pairTier ?? config.pairTier ?? "LIQUID",
        leverage:         config.leverage ?? 1,
        capitalAllocated: capital ?? config.capital ?? 0,
      };

      return entryContext;
    } catch (err) {
      console.error("[TradeFeatureCollector] captureEntryFeatures error:", err.message);
      return this._emptyEntryContext(ctx);
    }
  }

  /**
   * Capture exit-context features.
   *
   * @param {object} ctx  — { exitReason, exitPrice, entryPrice, side, enteredAt,
   *                          pnlPct, pnlUsd, htfTrend, indicators, maxAE, maxFE }
   * @returns {object} exitContext conforming to Feature Schema v1
   */
  async captureExitFeatures(ctx) {
    try {
      const {
        exitReason  = "manual",
        exitPrice   = 0,
        entryPrice  = 0,
        enteredAt,
        pnlPct      = 0,
        pnlUsd      = 0,
        htfTrend,
        indicators  = {},
        maxAE       = 0,  // max adverse excursion (negative %)
        maxFE       = 0,  // max favorable excursion (positive %)
      } = ctx || {};

      const now = Date.now();
      const holdingDurationMs = enteredAt ? now - new Date(enteredAt).getTime() : 0;

      const atrAtExit = indicators.atr ?? lastNN(indicators.atrArr) ?? 0;
      const htfRegimeAtExit = classifyHtfRegime(htfTrend ?? indicators.htfTrend, null);

      // Normalise exit reason to Feature Store vocabulary
      const REASON_MAP = {
        TP_HIT:          "tp_hit",
        SL_HIT:          "sl_hit",
        EMERGENCY:       "emergency",
        MANUAL:          "manual",
        TIMEOUT:         "timeout",
        GROK_AI_DECISION: "manual",
        SL_FAILED_EMERGENCY_CLOSE: "emergency",
      };
      const normReason = REASON_MAP[String(exitReason).toUpperCase()] ?? "manual";

      const exitContext = {
        capturedAt:            new Date().toISOString(),
        exitReason:            normReason,
        exitPrice:             exitPrice ?? 0,
        holdingDurationMs:     Math.max(0, holdingDurationMs),
        pnlPct:                +(pnlPct ?? 0),
        pnlUsd:                +(pnlUsd ?? 0),
        htfRegimeAtExit,
        atrAtExit,
        maxAdverseExcursion:   +(maxAE ?? 0),
        maxFavorableExcursion: +(maxFE ?? 0),
      };

      return exitContext;
    } catch (err) {
      console.error("[TradeFeatureCollector] captureExitFeatures error:", err.message);
      return this._emptyExitContext();
    }
  }

  /**
   * Persist entryContext onto a Prisma Trade record (async, non-blocking).
   *
   * @param {string} tradeId      — Prisma Trade.id
   * @param {object} entryContext — from captureEntryFeatures()
   */
  async attachToTrade(tradeId, entryContext) {
    return this._enqueue(async () => {
      await prisma.trade.update({
        where: { id: tradeId },
        data:  { entryContext },
      });
    }, `attachToTrade(${tradeId})`);
  }

  /**
   * Persist exitContext onto a Prisma Trade record (async, non-blocking).
   *
   * @param {string} tradeId     — Prisma Trade.id
   * @param {object} exitContext — from captureExitFeatures()
   */
  async attachExitToTrade(tradeId, exitContext) {
    return this._enqueue(async () => {
      await prisma.trade.update({
        where: { id: tradeId },
        data:  { exitContext },
      });
    }, `attachExitToTrade(${tradeId})`);
  }

  // ── Queue internals ───────────────────────────────────────────────────────

  /**
   * Enqueue an async task. Errors are caught and logged — never thrown.
   * Returns a promise that resolves (never rejects) when the task drains.
   */
  _enqueue(fn, label = "task") {
    return new Promise((resolve) => {
      this._queue.push({
        fn: async () => {
          try {
            await fn();
          } catch (err) {
            console.error(`[TradeFeatureCollector] ${label} failed:`, err.message);
          }
          resolve();
        },
      });
      this._drain();
    });
  }

  async _drain() {
    if (this._processing) return;
    this._processing = true;
    while (this._queue.length > 0) {
      const { fn } = this._queue.shift();
      await fn();
    }
    this._processing = false;
  }

  // ── Fallback empty contexts ───────────────────────────────────────────────

  _emptyEntryContext(ctx = {}) {
    return {
      capturedAt:       new Date().toISOString(),
      htfRegime:        "volatile",
      atr:              0,
      atrPct:           0,
      ema9:             0,
      ema21:            0,
      ema50:            0,
      adx:              null,
      rsi:              50,
      bbWidth:          0,
      volume24h:        0,
      volumeRatio:      1,
      spread:           0,
      fundingRate:      null,
      strategyKey:      ctx?.strategyKey ?? "UNKNOWN",
      tradeType:        "Intraday",
      confidenceScore:  0,
      signalComponents: {},
      afVotes:          null,
      pairTier:         ctx?.pairTier ?? "LIQUID",
      leverage:         1,
      capitalAllocated: 0,
    };
  }

  _emptyExitContext() {
    return {
      capturedAt:            new Date().toISOString(),
      exitReason:            "manual",
      exitPrice:             0,
      holdingDurationMs:     0,
      pnlPct:                0,
      pnlUsd:                0,
      htfRegimeAtExit:       "unknown",
      atrAtExit:             0,
      maxAdverseExcursion:   0,
      maxFavorableExcursion: 0,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export
// ─────────────────────────────────────────────────────────────────────────────

const _singleton = new TradeFeatureCollector();
module.exports = _singleton;
module.exports.TradeFeatureCollector = TradeFeatureCollector;
