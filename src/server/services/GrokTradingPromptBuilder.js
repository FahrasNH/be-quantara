/**
 * GrokTradingPromptBuilder.js — format data indikator multi-TF untuk prompt Grok.
 */

const { calcEMA, calcRSI, calcMACD, calcATR } = require("../../domain/indicators");

const REQUIRED_SECTIONS = [
  "current_price",
  "min_confidence_entry",
  "min_confidence_tp_sl",
  "timeframes",
  "account",
];

function lastValid(arr) {
  if (!arr?.length) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

function sliceSeries(arr, n = 10) {
  if (!arr?.length) return [];
  return arr.slice(-n).map(v => (v == null ? null : +Number(v).toFixed(6)));
}

function buildTfSnapshot(candles, tfLabel) {
  if (!candles?.length) {
    return { timeframe: tfLabel, error: "no_data" };
  }
  const lastIdx = candles.length - 2 >= 0 ? candles.length - 2 : candles.length - 1;
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const rsi14 = calcRSI(closes, 14);
  const rsi7 = calcRSI(closes, 7);
  const { macd, signal, histogram } = calcMACD(closes, 12, 26, 9);
  const atrArr = calcATR(highs, lows, closes, 14);

  return {
    timeframe: tfLabel,
    price: closes[lastIdx],
    ema20: lastValid(ema20),
    ema50: lastValid(ema50),
    macd: lastValid(macd),
    macd_signal: lastValid(signal),
    macd_histogram: lastValid(histogram),
    rsi7: lastValid(rsi7),
    rsi14: lastValid(rsi14),
    atr: lastValid(atrArr),
    series: {
      price: sliceSeries(closes),
      ema20: sliceSeries(ema20),
      macd: sliceSeries(macd),
      rsi7: sliceSeries(rsi7),
      rsi14: sliceSeries(rsi14),
    },
  };
}

class GrokTradingPromptBuilder {
  static build(ctx = {}) {
    const {
      symbol,
      price,
      indicators,
      lastIdx,
      multiTfCandles = {},
      account = {},
      openPosition = null,
      minConfidenceEntry = 8,
      minConfidenceTpSl = 7,
      leverage = 2,
      riskPerTrade = 0.01,
      maxConcurrentPositions = 1,
    } = ctx;

    const idx = lastIdx ?? (indicators?.closes?.length ? indicators.closes.length - 2 : 0);
    const closes = indicators?.closes || [];
    const highs = indicators?.highs || [];
    const lows = indicators?.lows || [];

    let ema20 = null;
    let macdVal = null;
    let rsi7 = null;
    if (closes.length) {
      ema20 = lastValid(calcEMA(closes, 20));
      rsi7 = lastValid(calcRSI(closes, 7));
      macdVal = lastValid(calcMACD(closes, 12, 26, 9).macd);
    }

    const timeframes = {};
    for (const [tf, candles] of Object.entries(multiTfCandles)) {
      timeframes[tf] = buildTfSnapshot(candles, tf);
    }

    const payload = {
      symbol,
      current_price: price,
      ema20,
      macd: macdVal,
      rsi7,
      open_interest: ctx.openInterest ?? null,
      funding_rate: ctx.fundingRate ?? null,
      min_confidence_entry: minConfidenceEntry,
      min_confidence_tp_sl: minConfidenceTpSl,
      leverage,
      risk_per_trade_pct: riskPerTrade * 100,
      max_concurrent_positions: maxConcurrentPositions,
      timeframes,
      account: {
        balance: account.balance ?? null,
        open_positions: account.openPositions ?? [],
        unrealized_pnl: account.unrealizedPnl ?? null,
      },
      open_position: openPosition
        ? {
            side: openPosition.side,
            entry: openPosition.entry,
            sl: openPosition.sl,
            tp: openPosition.tp,
            unrealized_pnl: openPosition.unrealizedPL ?? null,
          }
        : null,
      entry_series: closes.length
        ? {
            price: sliceSeries(closes),
            ema20: sliceSeries(calcEMA(closes, 20)),
            macd: sliceSeries(calcMACD(closes, 12, 26, 9).macd),
            rsi7: sliceSeries(calcRSI(closes, 7)),
            rsi14: sliceSeries(calcRSI(closes, 14)),
          }
        : null,
      atr: indicators?.atr?.[idx] ?? null,
    };

    const lines = [
      `Symbol: ${symbol}`,
      `Current price: ${price}`,
      `EMA20: ${payload.ema20 ?? "N/A"} | MACD: ${payload.macd ?? "N/A"} | RSI7: ${payload.rsi7 ?? "N/A"}`,
      `Open Interest: ${payload.open_interest ?? "N/A"} | Funding: ${payload.funding_rate ?? "N/A"}`,
      "",
      `Rules: entry only if confidence >= ${minConfidenceEntry}; TP/SL if confidence >= ${minConfidenceTpSl}.`,
      `Leverage: ${leverage}x | Risk/trade: ${(riskPerTrade * 100).toFixed(2)}% | Max positions: ${maxConcurrentPositions}`,
      "",
      `Account balance: $${account.balance ?? "N/A"} | Open positions: ${(account.openPositions || []).length}`,
    ];

    if (openPosition) {
      lines.push(
        `Open position: ${openPosition.side} entry $${openPosition.entry} SL $${openPosition.sl} TP $${openPosition.tp}`
      );
    }

    lines.push("", "Multi-timeframe indicators (oldest → newest in series):");
    for (const [tf, data] of Object.entries(timeframes)) {
      if (data.error) {
        lines.push(`  ${tf}: no data`);
        continue;
      }
      lines.push(
        `  ${tf}: price=${data.price} EMA20=${data.ema20} EMA50=${data.ema50} ` +
        `MACD=${data.macd} RSI14=${data.rsi14} ATR=${data.atr}`
      );
    }

    lines.push("", "Respond ONLY with valid JSON per schema (trades + position_actions).");

    return {
      text: lines.join("\n"),
      payload,
      hasRequiredSections: REQUIRED_SECTIONS.every(k => {
        if (k === "timeframes") return Object.keys(timeframes).length > 0 || Object.keys(multiTfCandles).length === 0;
        return payload[k] != null || k === "account";
      }),
    };
  }
}

module.exports = GrokTradingPromptBuilder;
