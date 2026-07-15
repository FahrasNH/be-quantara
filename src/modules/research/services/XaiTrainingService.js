/**
 * XaiTrainingService.js
 *
 * Orkestrasi AI training & analisis trading via xAI Grok (console.x.ai):
 * - Analisis optimasi backtest dengan konteks RAG
 * - Export dataset training dari trade history
 * - Sync knowledge base (strategi, docs) ke Collections
 */

const fs = require("fs");
const path = require("path");
const cfg = require("../../../config/env");
const XaiClient = require("../../../infrastructure/xai/XaiClient");
const db = require("../../../infrastructure/db/database");
const { getUserTier } = require("../../users/services/entitlement");
const { getTierConfig } = require("../../../core/risk-engine/tierConfig");
const { STRATEGIES } = require("#config/strategyDefaults.js");
const { normalizeStrategyKey } = require("../../../config/strategyKeyNormalizer");

const SYSTEM_PROMPT = `You are a quant trading analyst for Quantara (a crypto futures bot platform).
Your job is to analyze backtest/live-trade metrics and give SPECIFIC, strategy-aware parameter recommendations.

Rules:
- Reply with VALID JSON ONLY (no markdown fences).
- Write ALL text (title, description, ai_summary, reason) in ENGLISH.
- CRITICAL — strategy awareness: the user message lists the analyzed strategy's ACTUAL indicators and its
  TUNABLE PARAMETERS. You MUST ONLY suggest parameters from that TUNABLE list. NEVER invent parameters the
  strategy does not use. Example: a structure-based Smart Money Concepts strategy has NO RSI and NO configurable
  risk-reward — do not suggest "RSI Period" or "riskReward" for it; suggest its real knobs (confidence gates,
  risk per trade, HTF regime, TP multiplier) instead.
- Every parameter_suggestions.param MUST be one of the exact keys listed under TUNABLE PARAMETERS.
- Set parameter_suggestions.strategy to the EXACT strategyKey given in the user message.
- overall_score 0-100 based on win rate, profit factor, drawdown, sharpe, ROI.
- Never suggest extreme leverage or all-in sizing.
- Priority order: critical > high > medium > low.

Required JSON format:
{
  "overall_score": number,
  "ai_summary": "string — 2-3 sentence summary (English)",
  "recommendations": [
    { "title": "string", "priority": "critical|high|medium|low", "description": "string", "expected_impact": number }
  ],
  "opportunities": [
    { "area": "string", "name": "string", "suggestion": "string", "potential_gain": number, "parameters": { "key": value } }
  ],
  "parameter_suggestions": [
    { "strategy": "<exact strategyKey>", "param": "<exact key from TUNABLE PARAMETERS>", "current_hint": "string", "suggested": "string", "reason": "string" }
  ],
  "risk_assessment": {
    "level": "Low|Moderate|High",
    "summary": "string",
    "key_risks": ["string"]
  }
}`;

/**
 * Per-strategy tuning profile — tells Grok what each strategy ACTUALLY uses so it
 * recommends real knobs instead of assuming every strategy is EMA/RSI/RR-based.
 * Keyed by normalized strategy key (aliases resolved in _strategyProfile).
 */
const STRATEGY_TUNING_PROFILES = {
  SMART_MONEY_CONCEPTS: {
    family: "Smart Money Concepts (price-structure, NOT indicator-based)",
    indicators: "Liquidity sweep, CHoCH/BOS, Fair Value Gap (FVG), Order Block, Displacement, CVD, Volume surge. EMA is used ONLY for higher-timeframe regime bias — there is NO RSI and NO EMA-cross entry.",
    tunable: [
      "smcMinConfidenceA (Scalping entry confidence gate, 0-100 — lower = more trades)",
      "smcMinConfidenceB (Intraday entry confidence gate, 0-100)",
      "smcMinConfidenceC (Swing entry confidence gate, 0-100)",
      "riskPerTrade (combined risk fraction across the 3 concurrent components, e.g. 0.015 = 1.5%)",
      "strongTrendTPMult (TP multiplier that lets winners run in STRONG_TREND regime)",
      "maxTradesPerDay (daily trade cap)",
      "hardRegimeBlock (true = hard-block counter-HTF entries, false = soft -15 penalty)",
    ],
    forbidden: "rsiPeriod, rsiLongMin/Max, riskReward, emaFast/emaSlow (SL/TP come from hardcoded per-component ATR multipliers, NOT config)",
  },
  TREND_FOLLOWING: {
    family: "Trend Following (Donchian breakout + EMA trend + ATR)",
    indicators: "Donchian channel breakout, EMA trend filter, ADX strength, ATR-based SL/TP.",
    tunable: ["donchianPeriod", "emaFast", "emaSlow", "atrMultiplier", "riskReward", "adxMin"],
    forbidden: "Smart-money structure params (CHoCH, FVG, order block, CVD)",
  },
  MEAN_REVERSION: {
    family: "Mean Reversion (VWAP + RSI bands + Bollinger)",
    indicators: "VWAP deviation, RSI oversold/overbought bands, Bollinger Bands, ATR.",
    tunable: ["rsiPeriod", "rsiOversold", "rsiOverbought", "bbPeriod", "bbStdDev", "atrMultiplier", "riskReward"],
    forbidden: "Trend-breakout params (Donchian), smart-money structure params",
  },
  BREAKOUT_RETEST: {
    family: "Breakout Retest (range detection + breakout + retest confirmation)",
    indicators: "Range/consolidation detection, breakout level, retest tolerance, volume confirmation, ATR.",
    tunable: ["breakoutLookback", "retestTolerancePct", "volSmaMultiplier", "atrMultiplier", "riskReward"],
    forbidden: "RSI/mean-reversion params",
  },
};

class XaiTrainingService {
  static get client() {
    return new XaiClient();
  }

  static isEnabled() {
    return cfg.XAI_ENABLED === true && Boolean(cfg.XAI_API_KEY);
  }

  /**
   * Cek apakah user boleh pakai AI optimizer (tier VAULT + flag, atau dev override).
   */
  static async canUseAiOptimizer(userId) {
    if (!this.isEnabled()) return { allowed: false, reason: "xAI belum dikonfigurasi" };
    if (cfg.XAI_OPTIMIZER_OPEN === true || !cfg.isProduction) {
      return { allowed: true, reason: "dev/open mode" };
    }
    const tier = await getUserTier(userId);
    const tierCfg = getTierConfig(tier);
    if (tierCfg?.aiOptimizer) return { allowed: true, reason: "tier" };
    return {
      allowed: false,
      reason: "AI Optimizer membutuhkan tier VAULT dengan VAULT_AI_OPTIMIZER_ENABLED=true",
      tier,
    };
  }

  /**
   * Status integrasi xAI untuk health check UI.
   */
  static getStatus() {
    const client = this.client;
    return {
      enabled: this.isEnabled(),
      configured: client.isConfigured,
      model: cfg.XAI_MODEL,
      collection_configured: Boolean(cfg.XAI_COLLECTION_ID && cfg.XAI_MANAGEMENT_API_KEY),
      collection_id: cfg.XAI_COLLECTION_ID ? `${cfg.XAI_COLLECTION_ID.slice(0, 12)}…` : null,
      console_url: "https://console.x.ai/",
      docs_url: "https://docs.x.ai/",
    };
  }

  /**
   * Resolve a strategyKey (incl. legacy aliases) to its tuning profile so Grok
   * only recommends parameters the strategy actually exposes.
   */
  static _strategyProfile(strategyKey) {
    if (!strategyKey) return null;
    const k = normalizeStrategyKey(String(strategyKey).toUpperCase());
    return STRATEGY_TUNING_PROFILES[k] ?? null;
  }

  /**
   * Analisis backtest dengan Grok + optional RAG context.
   */
  static async analyzeBacktest(metrics, context = {}) {
    const client = this.client;
    const { symbol, strategyKey, trades, ragQuery } = context;

    let ragContext = "";
    if (client.collectionId && ragQuery) {
      try {
        const hits = await client.searchCollection(ragQuery);
        ragContext = hits.map(h => h.text).filter(Boolean).join("\n---\n");
      } catch (err) {
        console.warn(`[XaiTraining] RAG search gagal: ${err.message}`);
      }
    }

    const profile = XaiTrainingService._strategyProfile(strategyKey);
    const strategyContext = profile
      ? [
          `Analyzed strategy: ${strategyKey} — ${profile.family}`,
          `Indicators actually used: ${profile.indicators}`,
          `TUNABLE PARAMETERS (only suggest from this list, use the exact key):`,
          ...profile.tunable.map(t => `  - ${t}`),
          `DO NOT suggest (not used by this strategy): ${profile.forbidden}`,
        ].join("\n")
      : `Analyzed strategy: ${strategyKey ?? "N/A"} (no tuning profile — suggest only widely-safe, generic risk knobs; do not invent indicator params).`;

    const userContent = [
      `Symbol: ${symbol ?? "N/A"}`,
      `strategyKey: ${strategyKey ?? "N/A"}`,
      "",
      "Backtest metrics:",
      JSON.stringify(metrics, null, 2),
      "",
      trades?.length ? `Sample trades (${Math.min(trades.length, 20)} of ${trades.length}):` : "",
      trades?.length ? JSON.stringify(trades.slice(0, 20), null, 2) : "",
      "",
      "STRATEGY PROFILE (authoritative — overrides any assumption):",
      strategyContext,
      ragContext ? `\nKnowledge-base context:\n${ragContext.slice(0, 8000)}` : "",
    ].filter(Boolean).join("\n");

    const raw = await client.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      { jsonMode: true, temperature: 0.2 }
    );

    return this._parseAiResponse(raw);
  }

  static _parseAiResponse(raw) {
    try {
      const parsed = JSON.parse(raw);
      return this._normalizeAiOutput(parsed);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        return this._normalizeAiOutput(JSON.parse(match[0]));
      }
      throw new Error("Grok mengembalikan JSON tidak valid");
    }
  }

  static _normalizeAiOutput(data) {
    return {
      overall_score: Math.min(100, Math.max(0, Number(data.overall_score) || 0)),
      ai_summary: data.ai_summary ?? "",
      recommendations: Array.isArray(data.recommendations) ? data.recommendations.slice(0, 6) : [],
      opportunities: Array.isArray(data.opportunities)
        ? data.opportunities.map(o => ({
            area: o.area ?? o.name,
            name: o.name ?? o.area,
            suggestion: o.suggestion ?? o.implementation ?? "",
            potential_gain: o.potential_gain ?? 0,
            parameters: o.parameters ?? {},
          }))
        : [],
      parameter_suggestions: Array.isArray(data.parameter_suggestions)
        ? data.parameter_suggestions.slice(0, 8)
        : [],
      risk_assessment: {
        level: data.risk_assessment?.level ?? "Moderate",
        summary: data.risk_assessment?.summary ?? "",
        key_risks: data.risk_assessment?.key_risks ?? [],
      },
      source: "xai",
      model: cfg.XAI_MODEL,
    };
  }

  /**
   * Export dataset training dari trade history user (ML-ready JSONL).
   */
  static async exportTrainingDataset(userId, opts = {}) {
    const { symbol = null, limit = 500, dryRun = null } = opts;
    const insights = await db.getInsights({ userId, symbol, dryRun, limit });

    const records = insights.map(t => ({
      features: {
        symbol: t.symbol,
        side: t.side,
        strategy: t.strategy,
        rsi: t.rsi,
        atr: t.atr,
        atrPct: t.atrPct,
        volumeRatio: t.volumeRatio,
        emaFast: t.emaFast,
        emaSlow: t.emaSlow,
        emaTrendBias: t.emaTrendBias,
        htfTrend: t.htfTrend,
        entryMode: t.entryMode,
      },
      labels: {
        result: t.result,
        pnlNet: t.pnlNet,
        rMultiple: t.rMultiple,
        pnlPct: t.pnlPct,
      },
      meta: {
        openTime: t.openTime,
        closeTime: t.closeTime,
        dryRun: t.dryRun,
      },
    }));

    return {
      count: records.length,
      format: "jsonl",
      records,
      jsonl: records.map(r => JSON.stringify(r)).join("\n"),
    };
  }

  /**
   * Sync dokumentasi strategi + sample training ke xAI Collection.
   */
  static async syncKnowledgeBase(opts = {}) {
    if (!this.client.isConfigured) {
      throw new Error("XAI_API_KEY belum dikonfigurasi");
    }
    if (!cfg.XAI_COLLECTION_ID || !cfg.XAI_MANAGEMENT_API_KEY) {
      throw new Error(
        "XAI_COLLECTION_ID dan XAI_MANAGEMENT_API_KEY diperlukan. Buat di https://console.x.ai/"
      );
    }

    const root = path.resolve(__dirname, "../../..");
    const docFiles = [
      { rel: "docs/STRATEGIES.md", name: "quantara-strategies.md" },
      { rel: "docs/PAIR_VOLATILITY.md", name: "quantara-pair-volatility.md" },
      { rel: "docs/README.md", name: "quantara-docs-readme.md" },
    ];

    const uploaded = [];
    for (const doc of docFiles) {
      const fullPath = path.join(root, doc.rel);
      if (!fs.existsSync(fullPath)) continue;
      const content = fs.readFileSync(fullPath, "utf8");
      const result = await this.client.uploadToCollection(doc.name, content, "text/markdown");
      uploaded.push({ ...doc, ...result });
    }

    if (opts.includeStrategyDefaults) {
      const defaultsJson = JSON.stringify(STRATEGIES, null, 2);
      const result = await this.client.uploadToCollection(
        "quantara-strategy-defaults.json",
        defaultsJson,
        "application/json"
      );
      uploaded.push({ rel: "legacyStrategies", name: "quantara-strategy-defaults.json", ...result });
    }

    return {
      collection_id: cfg.XAI_COLLECTION_ID,
      uploaded_count: uploaded.length,
      files: uploaded,
    };
  }

  /**
   * Upload dataset training user ke collection (anonim — tanpa userId di filename).
   */
  static async uploadTrainingSnapshot(userId, opts = {}) {
    const dataset = await this.exportTrainingDataset(userId, opts);
    if (dataset.count === 0) {
      return { uploaded: false, reason: "Tidak ada trade tertutup untuk di-export" };
    }

    const name = `training-${Date.now()}.jsonl`;
    const meta = `# Quantara training export\n# records: ${dataset.count}\n# generated: ${new Date().toISOString()}\n\n`;
    const content = meta + dataset.jsonl;

    const result = await this.client.uploadToCollection(name, content, "application/x-ndjson");
    return { uploaded: true, records: dataset.count, ...result };
  }
}

module.exports = XaiTrainingService;
