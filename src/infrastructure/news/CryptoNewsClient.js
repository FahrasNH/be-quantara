"use strict";

const axios = require("axios");
const cfg = require("../../config/env");

const DEFAULT_MACRO_QUERIES = Object.freeze([
  "FOMC Federal Reserve interest rate",
  "Fed minutes Federal Reserve",
  "CPI consumer price index inflation",
  "NFP non-farm payrolls unemployment",
]);

const MACRO_EVENT_RULES = Object.freeze([
  {
    type: "FED_MINUTES",
    label: "Risalah Rapat Fed (Fed Minutes)",
    patterns: [
      /fed(eral reserve)?\s+minutes/i,
      /fomc\s+minutes/i,
      /meeting minutes/i,
    ],
  },
  {
    type: "FOMC_RATE_DECISION",
    label: "FOMC / Keputusan Suku Bunga Fed",
    patterns: [
      /\bfomc\b/i,
      /federal reserve.{0,40}(rate|interest|decision|hike|cut)/i,
      /\bfed\b.{0,24}(rate|interest|decision|hike|cut)/i,
      /fed funds rate/i,
    ],
  },
  {
    type: "CPI_INFLATION",
    label: "CPI / Data Inflasi",
    patterns: [
      /\bcpi\b/i,
      /consumer price index/i,
      /inflation data/i,
      /inflation report/i,
    ],
  },
  {
    type: "NFP_UNEMPLOYMENT",
    label: "NFP / Pengangguran",
    patterns: [
      /\bnfp\b/i,
      /non[- ]farm payroll/i,
      /unemployment rate/i,
      /jobs report/i,
      /employment report/i,
    ],
  },
]);

const cache = new Map();

function textOf(article) {
  return [
    article?.title,
    article?.description,
    article?.summary,
    article?.content,
    article?.text,
  ].filter(Boolean).join(" ").trim();
}

function publishedAtOf(article) {
  const value = article?.pubDate
    ?? article?.publishedAt
    ?? article?.published_at
    ?? article?.date
    ?? article?.timestamp
    ?? article?.createdAt;
  const ms = value == null ? NaN : new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function articleIdOf(article) {
  return String(
    article?.id
      ?? article?.guid
      ?? article?.link
      ?? article?.url
      ?? `${article?.source || "unknown"}:${article?.title || "untitled"}`,
  );
}

function extractArticles(payload) {
  const candidates = [
    payload?.articles,
    payload?.data?.articles,
    payload?.data?.results,
    payload?.data,
    payload?.results,
    payload?.items,
    payload?.news,
  ];
  const list = candidates.find(Array.isArray);
  return Array.isArray(list) ? list : [];
}

function classifyMacroEvent(article) {
  const text = textOf(article);
  if (!text) return null;
  for (const rule of MACRO_EVENT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return { type: rule.type, label: rule.label };
    }
  }
  return null;
}

function normalizeArticle(article, nowMs, maxAgeMinutes) {
  const macro = classifyMacroEvent(article);
  if (!macro) return null;

  const publishedAt = publishedAtOf(article);
  const publishedMs = publishedAt ? new Date(publishedAt).getTime() : NaN;
  if (!Number.isFinite(publishedMs)) return null;

  const ageMs = nowMs - publishedMs;
  if (ageMs < -10 * 60_000 || ageMs > maxAgeMinutes * 60_000) return null;

  const title = String(article?.title || article?.headline || "").trim();
  if (!title) return null;

  return {
    id: articleIdOf(article),
    title,
    description: String(article?.description ?? article?.summary ?? "").trim(),
    source: String(article?.source ?? article?.sourceName ?? "unknown").trim(),
    link: String(article?.link ?? article?.url ?? "").trim() || null,
    publishedAt,
    eventType: macro.type,
    eventLabel: macro.label,
    ageMinutes: Math.max(0, Math.round(ageMs / 60_000)),
  };
}

class CryptoNewsClient {
  constructor(options = {}) {
    this.baseUrl = String(
      options.baseUrl
        ?? cfg.CRYPTO_NEWS_API_BASE_URL
        ?? "https://cryptocurrency.cv/api",
    ).replace(/\/$/, "");
    this.timeoutMs = Number(options.timeoutMs ?? cfg.CRYPTO_NEWS_TIMEOUT_MS ?? 15_000);
    this.maxAgeMinutes = Number(options.maxAgeMinutes ?? cfg.GROK_NEWS_MAX_AGE_MINUTES ?? 180);
    this.limit = Math.max(1, Number(options.limit ?? cfg.GROK_NEWS_MAX_ARTICLES ?? 20));
    this.http = options.http ?? axios;
    this.now = options.now ?? (() => Date.now());
    this.cacheTtlMs = Math.max(10_000, Number(options.cacheTtlMs ?? cfg.GROK_NEWS_CACHE_TTL_MS ?? 120_000));
    this.queries = Array.isArray(options.queries) && options.queries.length
      ? options.queries
      : DEFAULT_MACRO_QUERIES;
  }

  async _get(path, params = {}) {
    const response = await this.http.get(`${this.baseUrl}${path}`, {
      params,
      timeout: this.timeoutMs,
      headers: {
        Accept: "application/json",
        "User-Agent": "Quantara/2.0 (dry-run news strategy)",
      },
    });
    return response?.data ?? {};
  }

  async getHighImpactNews({ symbol = null, force = false } = {}) {
    const cacheKey = `${String(symbol || "ALL").toUpperCase()}:${this.queries.join("|")}`;
    const cached = cache.get(cacheKey);
    const nowMs = this.now();
    if (!force && cached && nowMs - cached.at < this.cacheTtlMs) return cached.value;

    const responses = await Promise.allSettled(
      this.queries.map((query) => this._get("/search", { q: query, limit: this.limit })),
    );

    const raw = responses.flatMap((result) => (
      result.status === "fulfilled" ? extractArticles(result.value) : []
    ));
    const unique = new Map();
    for (const item of raw) {
      const normalized = normalizeArticle(item, nowMs, this.maxAgeMinutes);
      if (normalized && !unique.has(normalized.id)) unique.set(normalized.id, normalized);
    }

    const value = [...unique.values()]
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, this.limit);
    cache.set(cacheKey, { at: nowMs, value });
    return value;
  }
}

module.exports = {
  CryptoNewsClient,
  DEFAULT_MACRO_QUERIES,
  MACRO_EVENT_RULES,
  classifyMacroEvent,
  extractArticles,
  normalizeArticle,
  _cache: cache,
};
