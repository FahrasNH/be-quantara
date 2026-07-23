"use strict";

/**
 * RagEvalHarness — Sprint 21 / Task 7
 * Retrieval + generation metrics for CI regression gate.
 */

const { embedText } = require("./LocalTextEmbedder");

const GOLDEN_SET = [
  {
    query: "why mean reversion fails in balance regime",
    expectedDocIds: ["MD_MR", "MD_SD"],
    expectedKeywords: ["reversion", "balance", "regime"],
  },
  {
    query: "statistical arbitrage swing transition entry",
    expectedDocIds: ["MD_SA"],
    expectedKeywords: ["arbitrage", "transition", "swing"],
  },
  {
    query: "smart money concepts liquidity sweep entry",
    expectedDocIds: ["AF_SMC", "SMC"],
    expectedKeywords: ["liquidity", "sweep", "structure"],
  },
];

function recallAtK(retrievedIds, expectedIds, k = 10) {
  if (!expectedIds?.length) return 1;
  const top = new Set(retrievedIds.slice(0, k));
  const hits = expectedIds.filter((id) => [...top].some((r) => r.includes(id)));
  return hits.length / expectedIds.length;
}

function mrr(retrievedIds, expectedIds) {
  for (let i = 0; i < retrievedIds.length; i++) {
    if (expectedIds.some((e) => retrievedIds[i].includes(e))) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

class RagEvalHarness {
  constructor(hybridRetriever, groundingValidator) {
    this.retriever = hybridRetriever;
    this.validator = groundingValidator;
  }

  async evaluateRetrieval(goldenSet = GOLDEN_SET) {
    const results = [];
    for (const item of goldenSet) {
      const out = await this.retriever.retrieve(item.query, { k: 10 });
      const retrievedIds = (out.documents || []).map((d) => d.docId || "");
      results.push({
        query: item.query,
        recallAt10: recallAtK(retrievedIds, item.expectedDocIds, 10),
        mrr: mrr(retrievedIds, item.expectedDocIds),
        retrievedCount: retrievedIds.length,
      });
    }
    const avgRecall = results.reduce((s, r) => s + r.recallAt10, 0) / (results.length || 1);
    const avgMrr = results.reduce((s, r) => s + r.mrr, 0) / (results.length || 1);
    return { results, avgRecallAt10: avgRecall, avgMrr: avgMrr, pass: avgRecall >= 0.5 };
  }

  evaluateGeneration(response, context, statBlock) {
    const v = this.validator.validate(response, context, statBlock);
    return {
      groundedness: v.groundedness,
      citationAccuracy: v.citationAccuracy,
      hallucinationRate: v.hallucination ? 1 : 0,
      pass: v.groundedness >= 0.85 && v.citationAccuracy >= 0.85 && !v.hallucination,
      details: v,
    };
  }

  static getGoldenSet() {
    return GOLDEN_SET;
  }

  static smokeEmbed() {
    const v = embedText("test embedding smoke");
    return v.length === 384 && Number.isFinite(v[0]);
  }
}

module.exports = { RagEvalHarness, GOLDEN_SET, recallAtK, mrr };
