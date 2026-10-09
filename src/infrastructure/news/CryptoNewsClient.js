"use strict";

const axios = require("axios");
const cfg = require("../../config/env");

const DEFAULT_MACRO_QUERIES = Object.freeze([
  // The API search endpoint tokenizes these as keyword searches. Long
  // conjunctive queries return zero results, so keep the recovery searches
  // short and let the aggregate feeds handle the normal polling path.
  "FOMC",
  "Federal Reserve",
  "CPI",
  "NFP",
]);

const DEFAULT_MACRO_FALLBACK_FEEDS = Object.freeze([
  { path: "/news", params: { category: "macro" } },
  { path: "/breaking", params: {} },
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
      /\brate\s+(pause|decision|cut|hike|rise|hold)\b/i,
      /interest[-\s]?rate/i,
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
      /\binflation\b/i,
    ],
  },
  {
    type: "NFP_UNEMPLOYMENT",
    label: "NFP / Pengangguran",
    patterns: [
      /\bnfp\b/i,
      /non[- ]farm payroll/i,
      /\bpayrolls?\b/i,
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
    this.cacheTtlMs = Math.max(10_000, Number(
      options.cacheTtlMs
        ?? cfg.GROK_NEWS_CACHE_TTL_MS
        ?? cfg.GROK_NEWS_CYCLE_MS
        ?? 300_000,
    ));
    this.queries = Array.isArray(options.queries) && options.queries.length
      ? options.queries
      : DEFAULT_MACRO_QUERIES;
    this.fallbackFeeds = Array.isArray(options.fallbackFeeds)
      ? options.fallbackFeeds
      : DEFAULT_MACRO_FALLBACK_FEEDS;
    this.lastDiagnostics = null;
  }

  async _get(path, params = {}) {
    try {
      const response = await this.http.get(`${this.baseUrl}${path}`, {
        params,
        timeout: this.timeoutMs,
        headers: {
          Accept: "application/json",
          "User-Agent": "Quantara/2.0 (dry-run news strategy)",
        },
      });
      return response?.data ?? {};
    } catch (err) {
      const body = err?.response?.data;
      if (body?.code === "RATE_LIMIT_EXCEEDED") {
        const retryAfterSeconds = Number(body.retryAfter);
        const retryText = Number.isFinite(retryAfterSeconds)
          ? `; retry setelah ${Math.ceil(retryAfterSeconds / 60)} menit`
          : "";
        const rateError = new Error(`Crypto news API rate limit tercapai${retryText}`);
        rateError.code = "NEWS_API_RATE_LIMITED";
        rateError.retryAfterSeconds = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds
          : null;
        throw rateError;
      }
      throw err;
    }
  }

  async getHighImpactNews({ force = false } = {}) {
    // Macro news is global, not symbol-specific. Sharing this cache prevents
    // every BTC/ETH/SOL paper bot from issuing the same API requests.
    const cacheKey = [
      this.baseUrl,
      this.maxAgeMinutes,
      this.limit,
      this.queries.join("|"),
      this.fallbackFeeds.map((feed) => feed.path).join("|"),
    ].join(":");
    const cached = cache.get(cacheKey);
    const nowMs = this.now();
    const cachedTtlMs = cached?.error?.retryAfterMs || this.cacheTtlMs;
    if (!force && cached && nowMs - cached.at < cachedTtlMs) {
      this.lastDiagnostics = { ...cached.diagnostics, cacheHit: true };
      if (cached.error) {
        const cachedError = new Error(cached.error.message);
        cachedError.code = cached.error.code;
        cachedError.retryAfterSeconds = cached.error.retryAfterSeconds;
        cachedError.diagnostics = this.lastDiagnostics;
        throw cachedError;
      }
      return cached.value;
    }

    const diagnostics = {
      cacheHit: false,
      searchQueries: 0,
      successfulSearches: 0,
      failedSearches: 0,
      rateLimitedSearches: 0,
      feedRequests: 0,
      successfulFeeds: 0,
      failedFeeds: 0,
      rateLimitedFeeds: 0,
      rawArticles: 0,
      matchedArticles: 0,
    };

    const unique = new Map();
    const responseResults = [];
    const addNormalized = (items) => {
      diagnostics.rawArticles += items.length;
      for (const item of items) {
        const normalized = normalizeArticle(item, nowMs, this.maxAgeMinutes);
        if (normalized && !unique.has(normalized.id)) unique.set(normalized.id, normalized);
      }
    };

    // The aggregate feeds are the cheap, high-signal polling path. Search is
    // deliberately a recovery path so the free API tier is not exhausted by
    // repeated identical queries every dry-run cycle.
    const feedResponses = await Promise.allSettled(
      this.fallbackFeeds.map((feed) => this._get(feed.path, {
        ...(feed.params || {}),
        limit: this.limit,
      })),
    );
    responseResults.push(...feedResponses);
    diagnostics.feedRequests = this.fallbackFeeds.length;
    diagnostics.successfulFeeds = feedResponses.filter((result) => result.status === "fulfilled").length;
    diagnostics.failedFeeds = feedResponses.filter((result) => result.status === "rejected").length;
    diagnostics.rateLimitedFeeds = feedResponses.filter((result) => (
      result.status === "rejected" && result.reason?.code === "NEWS_API_RATE_LIMITED"
    )).length;
    addNormalized(feedResponses.flatMap((result) => (
      result.status === "fulfilled" ? extractArticles(result.value) : []
    )));

    if (unique.size === 0 && this.queries.length > 0) {
      const searchResponses = await Promise.allSettled(
        this.queries.map((query) => this._get("/search", { q: query, limit: this.limit })),
      );
      responseResults.push(...searchResponses);
      diagnostics.searchQueries = this.queries.length;
      diagnostics.successfulSearches = searchResponses.filter((result) => result.status === "fulfilled").length;
      diagnostics.failedSearches = searchResponses.filter((result) => result.status === "rejected").length;
      diagnostics.rateLimitedSearches = searchResponses.filter((result) => (
        result.status === "rejected" && result.reason?.code === "NEWS_API_RATE_LIMITED"
      )).length;
      addNormalized(searchResponses.flatMap((result) => (
        result.status === "fulfilled" ? extractArticles(result.value) : []
      )));
    }

    if (diagnostics.successfulSearches + diagnostics.successfulFeeds === 0) {
      diagnostics.error = diagnostics.rateLimitedSearches + diagnostics.rateLimitedFeeds > 0
        ? "NEWS_API_RATE_LIMITED"
        : "NEWS_API_UNAVAILABLE";
      const retryAfterSeconds = responseResults.reduce((max, result) => Math.max(
        max,
        Number(result.reason?.retryAfterSeconds) || 0,
      ), 0);
      if (retryAfterSeconds > 0) diagnostics.retryAfterSeconds = retryAfterSeconds;
      this.lastDiagnostics = diagnostics;
      const errorMessage = diagnostics.error === "NEWS_API_RATE_LIMITED"
        ? "Crypto news API rate limit tercapai"
        : "Crypto news API tidak dapat diakses";
      const error = new Error(errorMessage);
      error.code = diagnostics.error;
      error.retryAfterSeconds = retryAfterSeconds > 0 ? retryAfterSeconds : null;
      error.diagnostics = diagnostics;
      cache.set(cacheKey, {
        at: nowMs,
        value: [],
        diagnostics,
        error: {
          code: error.code,
          message: error.message,
          retryAfterSeconds: error.retryAfterSeconds,
          retryAfterMs: retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : this.cacheTtlMs,
        },
      });
      throw error;
    }

    const value = [...unique.values()]
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, this.limit);
    diagnostics.matchedArticles = value.length;
    this.lastDiagnostics = diagnostics;
    cache.set(cacheKey, { at: nowMs, value, diagnostics });
    return value;
  }
}

module.exports = {
  CryptoNewsClient,
  DEFAULT_MACRO_QUERIES,
  DEFAULT_MACRO_FALLBACK_FEEDS,
  MACRO_EVENT_RULES,
  classifyMacroEvent,
  extractArticles,
  normalizeArticle,
  _cache: cache,
};
