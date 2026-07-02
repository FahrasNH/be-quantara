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
const cfg = require("../../config/env");
const XaiClient = require("../../infrastructure/xai/XaiClient");
const db = require("../../infrastructure/db/database");
const { getUserTier } = require("../../services/entitlement");
const { getTierConfig } = require("../../domain/tierConfig");
const { STRATEGIES } = require("../../domain/legacyStrategies");

const SYSTEM_PROMPT = `Kamu adalah analis quant trading untuk platform Quantara (bot crypto futures).
Tugasmu menganalisis metrik backtest/live trade dan memberikan rekomendasi parameter strategi yang spesifik.

Aturan:
- Jawab HANYA dalam JSON valid (tanpa markdown fence).
- Gunakan bahasa Indonesia untuk title, description, ai_summary.
- Rekomendasi harus actionable: sebut parameter konkret (rsiLongMin, atrMultiplier, riskReward, dll).
- Skor overall_score 0-100 berdasarkan win rate, profit factor, drawdown, sharpe, ROI.
- Jangan sarankan leverage ekstrem atau all-in.
- Prioritas: critical > high > medium > low.

Format JSON wajib:
{
  "overall_score": number,
  "ai_summary": "string — ringkasan 2-3 kalimat",
  "recommendations": [
    { "title": "string", "priority": "critical|high|medium|low", "description": "string", "expected_impact": number }
  ],
  "opportunities": [
    { "area": "string", "name": "string", "suggestion": "string", "potential_gain": number, "parameters": { "key": value } }
  ],
  "parameter_suggestions": [
    { "strategy": "ADAPTIVE_FUSION|TREND_FOLLOWING|MEAN_REVERSION|BREAKOUT_RETEST", "param": "string", "current_hint": "string", "suggested": "string", "reason": "string" }
  ],
  "risk_assessment": {
    "level": "Low|Moderate|High",
    "summary": "string",
    "key_risks": ["string"]
  }
}`;

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

    const strategySummary = Object.entries(STRATEGIES)
      .slice(0, 4)
      .map(([k, s]) => `${k}: EMA ${s.emaFast}/${s.emaSlow}, RSI ${s.rsiPeriod}, RR ${s.riskReward}`)
      .join("\n");

    const userContent = [
      `Simbol: ${symbol ?? "N/A"}`,
      `Strategi: ${strategyKey ?? "N/A"}`,
      "",
      "Metrik backtest:",
      JSON.stringify(metrics, null, 2),
      "",
      trades?.length ? `Sample trades (${Math.min(trades.length, 20)} dari ${trades.length}):` : "",
      trades?.length ? JSON.stringify(trades.slice(0, 20), null, 2) : "",
      "",
      "Preset strategi platform:",
      strategySummary,
      ragContext ? `\nKonteks knowledge base:\n${ragContext.slice(0, 8000)}` : "",
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
