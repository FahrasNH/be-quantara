"use strict";

/**
 * RagExplainService — Sprint 21 / Task 8 orchestrator
 * OFFLINE-first research path; not for live entry hot-path.
 */

const db = require("../../../infrastructure/db/database");
const prisma = require("../../../infrastructure/db/prismaClient");
const VectorStore = require("../../../infrastructure/db/VectorStore");
const XaiClient = require("../../../infrastructure/xai/XaiClient");
const DocVectorStore = require("./DocVectorStore");
const StructuredStatsJoin = require("./StructuredStatsJoin");
const { HybridRetriever } = require("./HybridRetriever");
const { ContextAssembler } = require("./ContextAssembler");
const EvidenceGroundedPromptBuilder = require("./EvidenceGroundedPromptBuilder");
const GroundingValidator = require("./GroundingValidator");
const { KnowledgeIngestionPipeline } = require("./KnowledgeIngestionPipeline");

let _deps = null;

function getDeps() {
  if (_deps) return _deps;
  const pool = db._pool;
  const docStore = new DocVectorStore(pool);
  const tradeStore = new VectorStore(pool);
  const statsJoin = new StructuredStatsJoin(prisma, tradeStore);
  const retriever = new HybridRetriever(docStore, statsJoin, tradeStore);
  const assembler = new ContextAssembler();
  const xai = new XaiClient();
  _deps = { docStore, tradeStore, statsJoin, retriever, assembler, xai, prisma };
  return _deps;
}

class RagExplainService {
  static resetDeps() {
    _deps = null;
  }

  static async ingest(opts = {}) {
    const { docStore, prisma: p } = getDeps();
    const pipeline = new KnowledgeIngestionPipeline(docStore, { prisma: p });
    return pipeline.runFullIngest(opts);
  }

  static async explain({
    question,
    strategyKey,
    regime,
    symbol,
    timeframe,
    skipLlm = false,
  }) {
    const started = Date.now();
    const { retriever, assembler, xai } = getDeps();

    const retrieval = await retriever.retrieve(question, {
      strategyKey,
      regime,
      symbol,
      timeframe,
      k: 15,
    });

    const context = assembler.assemble(retrieval);
    const statBlock = retrieval.structured?.find((s) => s.type === "stat_block") || null;

    if (context.items.length === 0) {
      const fallback = EvidenceGroundedPromptBuilder.buildInsufficientFallback(question);
      return {
        ...fallback,
        evidence: [],
        retrievalMeta: retrieval.meta,
        latencyMs: Date.now() - started,
        source: "fallback",
      };
    }

    const prompt = EvidenceGroundedPromptBuilder.build({
      question,
      strategyKey,
      regime,
      assembledContext: context,
    });

    let rawResponse;
    let source = "template";

    if (!skipLlm && xai.isConfigured) {
      try {
        const content = await xai.chat(prompt.messages, { jsonMode: true, maxTokens: 2048, temperature: 0 });
        rawResponse = JSON.parse(content);
        source = "xai";
      } catch (err) {
        console.warn("[RagExplainService] LLM call failed:", err.message);
        rawResponse = EvidenceGroundedPromptBuilder.buildInsufficientFallback(question);
        source = "llm_error_fallback";
      }
    } else {
      rawResponse = {
        verdict: "mixed",
        reasoning: context.items.slice(0, 3).map((it) => `${it.citationId} ${it.text.slice(0, 200)}`).join(" "),
        citations: context.items.slice(0, 3).map((it) => it.citationId),
        confidence: 0.5,
        caveats: skipLlm ? "LLM skipped (offline mode)" : "XAI not configured",
      };
    }

    const validation = GroundingValidator.validate(rawResponse, context, statBlock);
    const finalResponse = validation.downgraded
      ? {
          ...rawResponse,
          verdict: "insufficient_evidence",
          reasoning: `${rawResponse.reasoning || ""} [Grounding check failed: fabricated or mismatched claims]`.trim(),
          confidence: Math.min(rawResponse.confidence ?? 0.5, 0.3),
        }
      : rawResponse;

    return {
      question,
      strategyKey,
      regime,
      ...finalResponse,
      evidence: context.items.map((it) => ({
        citationId: it.citationId,
        type: it.type,
        text: it.text?.slice(0, 500),
        tradeId: it.tradeId,
        docId: it.docId,
      })),
      grounding: validation,
      retrievalMeta: retrieval.meta,
      promptVersion: prompt.version,
      latencyMs: Date.now() - started,
      source,
    };
  }
}

module.exports = RagExplainService;
