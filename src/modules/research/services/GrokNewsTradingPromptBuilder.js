"use strict";

const GrokTradingPromptBuilder = require("./GrokTradingPromptBuilder");

const REQUIRED_NEWS_TYPES = new Set([
  "FOMC_RATE_DECISION",
  "FED_MINUTES",
  "CPI_INFLATION",
  "NFP_UNEMPLOYMENT",
]);

class GrokNewsTradingPromptBuilder {
  static build(ctx = {}) {
    const base = GrokTradingPromptBuilder.build(ctx);
    const news = Array.isArray(ctx.news) ? ctx.news : [];
    const newsPayload = news.map((item) => ({
      id: item.id,
      event_type: item.eventType,
      event_label: item.eventLabel,
      title: item.title,
      description: item.description,
      source: item.source,
      published_at: item.publishedAt,
      age_minutes: item.ageMinutes,
      link: item.link,
    }));

    const payload = {
      ...base.payload,
      news: newsPayload,
      news_required: true,
      allowed_news_types: [...REQUIRED_NEWS_TYPES],
      min_risk_reward: ctx.minRiskReward ?? null,
    };

    const lines = [
      "DRY-RUN NEWS STRATEGY — NEWS IS A HARD PREREQUISITE",
      "Only trade when at least one fresh high-impact macro article is present below.",
      "The screenshot categories are the intended event family: FOMC/rate decision, Fed minutes, CPI/inflation, and NFP/unemployment.",
      "Do not invent an economic calendar event. Do not trade on technical indicators alone.",
      "If the news is ambiguous, stale, contradictory, or the market reaction is not actionable, return an empty trades array.",
      "The position is a paper trade only. Entry must be MARKET; TP/SL must be absolute prices around current_price.",
      `Use the current price and ATR in the payload. Minimum R:R is ${ctx.minRiskReward ?? "the supplied"}. Never place SL on the wrong side or return a TP/SL below that minimum.`,
      "",
      `Fresh macro articles (${newsPayload.length}):`,
    ];

    for (const item of newsPayload) {
      lines.push(
        `- [${item.event_type}] id=${item.id} | ${item.title} | source=${item.source} | age=${item.age_minutes}m | published=${item.published_at}`,
        `  ${item.description || "No description"}`,
      );
    }

    lines.push(
      "",
      "Return ONLY this JSON shape:",
      '{"trades":[{"symbol":"BTCUSDT","side":"LONG|SHORT","entry":"MARKET","take_profit":number,"stop_loss":number,"confidence":1-10,"event_type":"FOMC_RATE_DECISION|FED_MINUTES|CPI_INFLATION|NFP_UNEMPLOYMENT","news_id":"string","reasoning":"string"}],"position_actions":[]}',
      "If no valid trade exists, return {\"trades\":[],\"position_actions\":[]}.",
    );

    return {
      text: `${base.text}\n\n${lines.join("\n")}`,
      payload,
      hasRequiredSections: base.hasRequiredSections && newsPayload.length > 0,
    };
  }
}

module.exports = {
  GrokNewsTradingPromptBuilder,
  REQUIRED_NEWS_TYPES,
};
