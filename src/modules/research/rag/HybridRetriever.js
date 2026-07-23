"use strict";

/**
 * HybridRetriever — Sprint 21 / Task 3
 * Dense (pgvector) + sparse (BM25/ts_rank) + metadata filter + SQL stat join.
 * RRF fusion for ensemble scoring.
 */

const { embedText } = require("./LocalTextEmbedder");

const RRF_K = 60;

function reciprocalRankFusion(rankLists, k = RRF_K) {
  const scores = new Map();
  for (const list of rankLists) {
    list.forEach((item, rank) => {
      const key = item.key;
      const prev = scores.get(key) || { item, score: 0 };
      prev.score += 1 / (k + rank + 1);
      scores.set(key, prev);
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((v) => ({ ...v.item, rrfScore: v.score }));
}

class HybridRetriever {
  constructor(docStore, statsJoin, tradeVectorStore) {
    this.docStore = docStore;
    this.statsJoin = statsJoin;
    this.tradeVectorStore = tradeVectorStore;
  }

  _itemKey(item) {
    return `${item.docId || item.tradeId || item.citationId}:${item.chunkIndex ?? 0}`;
  }

  async retrieve(query, options = {}) {
    const {
      k = 20,
      strategyKey,
      regime,
      symbol,
      timeframe,
      includeStats = true,
      includeSimilarTrades = true,
    } = options;

    const filters = {};
    if (strategyKey) filters.strategyKey = strategyKey;
    if (regime) filters.regime = regime;
    if (symbol) filters.symbol = symbol;
    if (timeframe) filters.timeframe = timeframe;

    const queryVector = embedText(query);
    let dense = [];
    let sparse = [];

    try {
      [dense, sparse] = await Promise.all([
        this.docStore.findSimilarDense(queryVector, k, filters),
        this.docStore.findSimilarSparse(query, k, filters),
      ]);
    } catch (err) {
      console.warn("[HybridRetriever] doc retrieval failed:", err.message);
    }

    const denseRanked = dense.map((d) => ({ ...d, key: this._itemKey(d), type: "doc" }));
    const sparseRanked = sparse.map((d) => ({ ...d, key: this._itemKey(d), type: "doc" }));
    const fusedDocs = reciprocalRankFusion([denseRanked, sparseRanked]);

    const extras = [];

    if (includeStats && this.statsJoin) {
      const stat = await this.statsJoin.aggregateByBucket({ strategyKey, regime, symbol });
      if (stat) extras.push(stat);
    }

    if (includeSimilarTrades && this.statsJoin) {
      const similar = await this.statsJoin.findSimilarTrades(queryVector, filters, Math.min(k, 10));
      extras.push(...similar);
    }

    return {
      query,
      filters,
      documents: fusedDocs.slice(0, k),
      structured: extras,
      meta: {
        denseCount: dense.length,
        sparseCount: sparse.length,
        fusedCount: fusedDocs.length,
      },
    };
  }
}

module.exports = { HybridRetriever, reciprocalRankFusion, RRF_K };
