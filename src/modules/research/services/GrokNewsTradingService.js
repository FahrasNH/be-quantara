"use strict";

const cfg = require("../../../config/env");
const XaiClient = require("../../../infrastructure/xai/XaiClient");
const {
  CryptoNewsClient,
} = require("../../../infrastructure/news/CryptoNewsClient");
const {
  GrokNewsTradingPromptBuilder,
  REQUIRED_NEWS_TYPES,
} = require("./GrokNewsTradingPromptBuilder");
const { persistAiTradeInteraction } = require("../../../infrastructure/db/aiTradeInteractionRepository");

const SYSTEM_PROMPT = `You are a conservative crypto futures risk engine operating in DRY RUN only.
Your job is to decide whether a fresh high-impact macro news event justifies one paper trade.
The only accepted event families are FOMC/rate decision, Fed minutes, CPI/inflation, and NFP/unemployment.
News is mandatory: if the news list is empty or not actionable, return no trade.
Use the technical snapshot only to time and size the reaction; never trade on technicals without news.
Return only valid JSON. Never invent prices, news, event timing, or certainty.
The output must contain trades and position_actions arrays.`;

function normSymbol(sym) {
  return String(sym || "").replace(/[/:]/g, "").toUpperCase();
}

function parseJson(raw) {
  if (!raw || typeof raw !== "string") throw new Error("Grok news response kosong");
  try {
    return JSON.parse(raw.trim());
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Grok news mengembalikan JSON tidak valid");
    return JSON.parse(match[0]);
  }
}

class GrokNewsTradingService {
  static _client = null;
  static _newsClient = null;

  static get client() {
    if (!this._client) this._client = new XaiClient();
    return this._client;
  }

  static get newsClient() {
    if (!this._newsClient) this._newsClient = new CryptoNewsClient();
    return this._newsClient;
  }

  static isEnabled() {
    return cfg.GROK_NEWS_TRADING_ENABLED === true
      && Boolean(cfg.XAI_API_KEY)
      && cfg.CRYPTO_NEWS_ENABLED !== false;
  }

  static parseResponse(raw) {
    const data = parseJson(raw);
    if (!Array.isArray(data.trades)) data.trades = [];
    if (!Array.isArray(data.position_actions)) data.position_actions = [];
    return data;
  }

  static validateTrade(trade, ctx = {}) {
    const reject = (reason) => ({
      valid: false,
      entryAllowed: false,
      tpSlValid: false,
      rejected: reason,
      side: trade?.side,
      confidence: trade?.confidence,
      reasoning: trade?.reasoning || "",
      eventType: trade?.event_type || null,
      newsId: trade?.news_id || null,
    });

    if (!trade || normSymbol(trade.symbol) !== normSymbol(ctx.symbol)) return reject("symbol_mismatch");
    if (!Array.isArray(ctx.news) || ctx.news.length === 0) return reject("no_fresh_macro_news");

    const eventType = String(trade.event_type || "").toUpperCase();
    if (!REQUIRED_NEWS_TYPES.has(eventType)) return reject("invalid_event_type");
    const newsId = String(trade.news_id || "").trim();
    const matchedNews = ctx.news.find((item) => (
      item.eventType === eventType && String(item.id || "") === newsId
    ));
    if (!matchedNews) return reject("news_not_in_context");

    const confidence = Number(trade.confidence);
    const minTpSl = Number(ctx.minConfidenceTpSl ?? cfg.GROK_NEWS_MIN_CONFIDENCE_TP_SL);
    const minEntry = Number(ctx.minConfidenceEntry ?? cfg.GROK_NEWS_MIN_CONFIDENCE_ENTRY);
    if (!Number.isFinite(confidence) || confidence < 1 || confidence > 10) return reject("invalid_confidence");
    if (confidence < minTpSl) return reject("confidence_below_tp_sl_threshold");

    const side = String(trade.side || "").toUpperCase();
    if (side !== "LONG" && side !== "SHORT") return reject("invalid_side");
    if (String(trade.entry || "").toUpperCase() !== "MARKET") {
      return reject(trade.entry == null || String(trade.entry).trim() === ""
        ? "entry_required"
        : "entry_must_be_market");
    }

    const price = Number(ctx.price);
    const atr = Number(ctx.atr);
    const tp = Number(trade.take_profit);
    const sl = Number(trade.stop_loss);
    if (!(price > 0) || !(atr > 0)) return reject("invalid_market_context");
    if (!Number.isFinite(tp) || !Number.isFinite(sl) || tp <= 0 || sl <= 0) return reject("invalid_tp_sl");

    if (side === "LONG" && !(sl < price && price < tp)) return reject("long_geometry_invalid");
    if (side === "SHORT" && !(tp < price && price < sl)) return reject("short_geometry_invalid");

    const slDist = Math.abs(price - sl);
    const tpDist = Math.abs(tp - price);
    const minAtrMult = Number(ctx.atrMinMult ?? cfg.GROK_NEWS_ATR_MIN_MULT);
    const minRiskReward = Number(ctx.minRiskReward ?? cfg.GROK_NEWS_MIN_RISK_REWARD);
    if (slDist < minAtrMult * atr) return reject("sl_too_tight");
    const riskReward = slDist > 0 ? tpDist / slDist : 0;
    if (riskReward < minRiskReward) return reject("risk_reward_too_low");
    if (ctx.hasOpenPosition) return reject("position_already_open");

    return {
      valid: true,
      entryAllowed: confidence >= minEntry,
      tpSlValid: true,
      side,
      take_profit: tp,
      stop_loss: sl,
      confidence,
      riskReward: Number(riskReward.toFixed(3)),
      reasoning: String(trade.reasoning || "").trim(),
      eventType,
      newsId,
      rejected: confidence >= minEntry ? null : "confidence_below_entry_threshold",
    };
  }

  static async _callGrok(text) {
    return this.client.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      {
        jsonMode: true,
        temperature: cfg.GROK_NEWS_TEMPERATURE,
        maxTokens: cfg.GROK_NEWS_MAX_TOKENS,
      },
    );
  }

  static async requestTradeDecision(ctx = {}) {
    if (!this.isEnabled() || !this.client.isConfigured) {
      throw new Error("Grok news trading tidak aktif atau XAI_API_KEY kosong");
    }

    const news = Array.isArray(ctx.news)
      ? ctx.news
      : await this.newsClient.getHighImpactNews({ symbol: ctx.symbol });
    if (!news.length) return null;

    const prompt = GrokNewsTradingPromptBuilder.build({ ...ctx, news });
    const raw = await this._callGrok(prompt.text);
    const parsed = this.parseResponse(raw);
    const candidate = parsed.trades.find((item) => normSymbol(item.symbol) === normSymbol(ctx.symbol));
    if (!candidate) {
      await this._logInteraction(ctx, prompt.text, raw, null);
      return null;
    }

    const validated = this.validateTrade(candidate, { ...ctx, news });
    await this._logInteraction(ctx, prompt.text, raw, validated);
    return { ...validated, news };
  }

  static async _logInteraction(ctx, prompt, response, parsed) {
    if (cfg.GROK_TRADING_LOG_INTERACTIONS && ctx.userId) {
      persistAiTradeInteraction({
        userId: ctx.userId,
        botId: ctx.botId,
        symbol: ctx.symbol,
        type: "NEWS_TRADE",
        prompt,
        response,
        parsed: parsed ?? null,
      }).catch(() => {});
    }

    const summary = parsed?.side
      ? `[GROK NEWS] ${parsed.side} ${ctx.symbol} | ${parsed.eventType} | conf ${parsed.confidence}/10 | TP ${parsed.take_profit} | SL ${parsed.stop_loss}`
      : `[GROK NEWS] ${ctx.symbol} — no actionable macro signal`;
    console.log(summary);
  }
}

module.exports = GrokNewsTradingService;
