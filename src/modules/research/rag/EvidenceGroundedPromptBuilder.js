"use strict";

/**
 * EvidenceGroundedPromptBuilder — Sprint 21 / Task 5
 * Upgrades static STRATEGY_CONTEXT with retrieved evidence + citation rules.
 */

const PROMPT_VERSION = "rag-evidence-v1";

class EvidenceGroundedPromptBuilder {
  static build({ question, strategyKey, regime, assembledContext }) {
    const items = assembledContext?.items || [];
    const evidenceBlock = items.length === 0
      ? "EVIDENCE: (none retrieved — respond with insufficient evidence only)"
      : items.map((it) => `${it.citationId} ${it.text}`).join("\n\n");

    const system = [
      "You are a quantitative trading research assistant.",
      "Answer ONLY using the evidence below. Every factual claim MUST cite [tradeId] or [doc#N].",
      "If evidence is insufficient, say so — do not invent trades, stats, or methodology.",
      `Prompt version: ${PROMPT_VERSION}`,
    ].join("\n");

    const user = [
      `Question: ${question}`,
      strategyKey ? `Strategy: ${strategyKey}` : null,
      regime ? `Regime: ${regime}` : null,
      "",
      "=== RETRIEVED EVIDENCE ===",
      evidenceBlock,
      "",
      "=== OUTPUT FORMAT (JSON) ===",
      "{",
      '  "verdict": "supports|contradicts|mixed|insufficient_evidence",',
      '  "reasoning": "explain WHY based on evidence with citations",',
      '  "citations": ["[doc#1]", "[tradeId]", ...],',
      '  "confidence": 0.0-1.0,',
      '  "caveats": "limitations or missing data"',
      "}",
    ].filter(Boolean).join("\n");

    return {
      version: PROMPT_VERSION,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      evidenceCount: items.length,
    };
  }

  static buildInsufficientFallback(question) {
    return {
      verdict: "insufficient_evidence",
      reasoning: `Cannot answer "${question}" — no retrieved evidence available.`,
      citations: [],
      confidence: 0,
      caveats: "Retrieval returned empty context.",
    };
  }
}

module.exports = EvidenceGroundedPromptBuilder;
