"use strict";

/**
 * GroundingValidator — Sprint 21 / Task 6
 * Post-hoc verifier: citation existence, quantitative claim checks, hallucination flag.
 */

const CITATION_RE = /\[([^\]]+)\]/g;
const PERCENT_RE = /(\d+(?:\.\d+)?)\s*%/g;
const WR_RE = /(?:win\s*rate|WR)\s*(?:=|:|is|of)?\s*(\d+(?:\.\d+)?)\s*%/gi;

class GroundingValidator {
  static extractCitations(text) {
    const cites = [];
    let m;
    const s = String(text || "");
    while ((m = CITATION_RE.exec(s)) !== null) {
      cites.push(`[${m[1]}]`);
    }
    return [...new Set(cites)];
  }

  static validate(response, assembledContext, statBlock = null) {
    const text = typeof response === "string"
      ? response
      : JSON.stringify(response);
    const parsed = typeof response === "object" ? response : null;

    const validIds = new Set(Object.keys(assembledContext?.citationMap || {}));
    for (const it of assembledContext?.items || []) {
      if (it.tradeId) validIds.add(`[${it.tradeId}]`);
      if (it.citationId) validIds.add(it.citationId);
    }

    const citations = parsed?.citations || this.extractCitations(text);
    const fabricated = citations.filter((c) => !validIds.has(c));
    const groundedCitations = citations.filter((c) => validIds.has(c));

    const quantFlags = [];
    if (statBlock && statBlock.winRate != null) {
      const expectedWr = statBlock.winRate * 100;
      let wm;
      while ((wm = WR_RE.exec(text)) !== null) {
        const claimed = parseFloat(wm[1]);
        if (Math.abs(claimed - expectedWr) > 5) {
          quantFlags.push({
            type: "win_rate_mismatch",
            claimed,
            expected: expectedWr,
          });
        }
      }
    }

    const hasEvidence = (assembledContext?.items?.length ?? 0) > 0;
    const citationAccuracy = citations.length > 0
      ? groundedCitations.length / citations.length
      : hasEvidence ? 0 : 1;
    const hallucination = fabricated.length > 0 || quantFlags.length > 0;
    const groundedness = citationAccuracy * (hallucination ? 0.5 : 1);

    let verdict = parsed?.verdict;
    if (fabricated.length > 0 || quantFlags.length > 0) {
      verdict = "insufficient_evidence";
    }

    return {
      valid: !hallucination && groundedness >= 0.85,
      groundedness,
      citationAccuracy,
      hallucination,
      fabricatedCitations: fabricated,
      quantFlags,
      citations: groundedCitations,
      verdict: verdict || (hasEvidence ? "mixed" : "insufficient_evidence"),
      downgraded: hallucination,
    };
  }
}

module.exports = GroundingValidator;
