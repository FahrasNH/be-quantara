"use strict";

/**
 * ContextAssembler — Sprint 21 / Task 4
 * Rerank, dedup, token budget, stable citation IDs.
 */

const DEFAULT_TOKEN_BUDGET = 4000;

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function rerankByScore(items) {
  return [...items].sort((a, b) => {
    const sa = a.rrfScore ?? a.score ?? 0;
    const sb = b.rrfScore ?? b.score ?? 0;
    return sb - sa;
  });
}

class ContextAssembler {
  constructor({ tokenBudget = DEFAULT_TOKEN_BUDGET } = {}) {
    this.tokenBudget = tokenBudget;
  }

  assemble(retrievalResult) {
    const docs = rerankByScore(retrievalResult.documents || []);
    const structured = retrievalResult.structured || [];
    const seen = new Set();
    const items = [];
    let usedTokens = 0;
    let docCounter = 1;

    for (const block of structured) {
      const key = block.citationId || block.tradeId || block.text?.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      const tokens = estimateTokens(block.text);
      if (usedTokens + tokens > this.tokenBudget) break;
      items.push({
        ...block,
        citationId: block.citationId || (block.tradeId ? `[${block.tradeId}]` : `[stat]`),
      });
      usedTokens += tokens;
    }

    for (const doc of docs) {
      const key = `${doc.docId}:${doc.chunkIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const citationId = `[doc#${docCounter}]`;
      docCounter += 1;
      const text = doc.content || "";
      const tokens = estimateTokens(text);
      if (usedTokens + tokens > this.tokenBudget) break;
      items.push({
        type: "doc",
        citationId,
        docId: doc.docId,
        chunkIndex: doc.chunkIndex,
        text,
        metadata: doc.metadata,
        score: doc.rrfScore ?? doc.score,
      });
      usedTokens += tokens;
    }

    return {
      items,
      citationMap: Object.fromEntries(
        items.map((it) => [it.citationId, { type: it.type, docId: it.docId, tradeId: it.tradeId }])
      ),
      tokenEstimate: usedTokens,
      truncated: usedTokens >= this.tokenBudget,
    };
  }
}

module.exports = { ContextAssembler, estimateTokens, rerankByScore, DEFAULT_TOKEN_BUDGET };
