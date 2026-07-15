const { normalizeStrategyKey } = require("../../../config/strategyKeyNormalizer");

/**
 * GrokConfirmPromptBuilder.js — prompt lite untuk Mode B (Grok Confirm Gate).
 *
 * Strategy-aware since 2026-07-03: the prompt previously forced trend-following
 * vocabulary (HTF/RSI/EMA bias) onto EVERY strategy, so Grok's reasoning for
 * structure-based SMC or squeeze-based Breakout was always phrased as
 * "HTF bearish + EMA short bias + RSI<40" — indicators those strategies never
 * consult. Each strategy now declares its own methodology line + which
 * indicator snapshot fields are actually relevant to judge the signal.
 */

// Canonical key → methodology context. Accepts BOTH v2.0 component keys and
// legacy long names (same dual-vocabulary rule as GROK_CONFIRM_STRATEGIES).
const STRATEGY_CONTEXT = {
  SMC: {
    label: "Smart Money Concepts (structure-based)",
    methodology:
      "Entry logic: liquidity sweep → CHoCH → FVG/displacement → mitigation entry. " +
      "This strategy does NOT use RSI or EMA crossovers. Judge the signal on structure " +
      "quality, HTF directional alignment, and SL/TP placement vs ATR — do not reason " +
      "from RSI/EMA values.",
    relevantIndicators: ["htfTrend"],
  },
  TS: {
    label: "Trend Following (EMA + Donchian breakout)",
    methodology:
      "Entry logic: EMA fast/mid alignment + Donchian channel breakout + volume, filtered " +
      "by HTF trend and ADX. RSI is a continuation filter (not overbought/oversold reversal). " +
      "Judge trend strength, breakout validity, and whether RSI leaves room for continuation.",
    relevantIndicators: ["htfTrend", "rsi", "emaTrendBias"],
  },
  MD: {
    label: "Mean Reversion (VWAP deviation)",
    methodology:
      "Entry logic: price stretched from VWAP/mean reverting back. A signal AGAINST the " +
      "short-term trend is expected and correct here — do NOT reject just because EMA bias " +
      "opposes the signal. Judge deviation extremity (RSI extremes support entries) and " +
      "whether HTF regime allows a reversion leg.",
    relevantIndicators: ["htfTrend", "rsi"],
  },
  BS: {
    label: "Breakout Trading (BB-squeeze + retest)",
    methodology:
      "Entry logic: Bollinger Band Width squeeze (consolidation) → breakout with volume → " +
      "RETEST of the broken level confirms entry. Judge consolidation quality, volume " +
      "expansion, and retest validity — EMA/RSI are not entry criteria for this strategy.",
    relevantIndicators: ["htfTrend"],
  },
};

const ENGINE_TO_CONTEXT = {
  AF_SMC: "SMC",
  ADAPTIVE_FUSION: "SMC",
  TS_TF: "TS",
  MD_MR: "MD",
  BS_BR: "BS",
};

class GrokConfirmPromptBuilder {
  static build(ctx = {}) {
    const {
      strategyKey,
      side,
      price,
      atr,
      sl_rules: slRules,
      tp_rules: tpRules,
      indicatorSnapshot = {},
      htfTrend,
      signalReason,
      minConfidenceEntry = 8,
      minTpConfidence = 7,
      minTpModeConfidence = 6,
    } = ctx;

    const slDist = Math.abs(price - slRules);
    const tpDist = Math.abs(tpRules - price);
    const slAtrMult = atr > 0 ? (slDist / atr).toFixed(2) : "N/A";
    const tpAtrMult = atr > 0 ? (tpDist / atr).toFixed(2) : "N/A";

    const canonical = normalizeStrategyKey(String(strategyKey || "").toUpperCase());
    const contextKey = ENGINE_TO_CONTEXT[canonical];
    const stratCtx = contextKey ? STRATEGY_CONTEXT[contextKey] : null;

    // Only surface the indicator fields this strategy actually consults —
    // showing RSI/EMA to Grok for SMC/Breakout invites reasoning from
    // indicators the rules engine never used.
    const htf = htfTrend ?? indicatorSnapshot.htfTrend ?? "N/A";
    const indicatorParts = [`HTF: ${htf}`];
    const relevant = stratCtx?.relevantIndicators ?? ["htfTrend", "rsi", "emaTrendBias"];
    if (relevant.includes("rsi")) indicatorParts.push(`RSI: ${indicatorSnapshot.rsi ?? "N/A"}`);
    if (relevant.includes("emaTrendBias")) indicatorParts.push(`EMA fast/slow bias: ${indicatorSnapshot.emaTrendBias ?? "N/A"}`);

    const lines = [
      `Strategy: ${stratCtx ? stratCtx.label : strategyKey}`,
      stratCtx ? `Methodology: ${stratCtx.methodology}` : null,
      `Signal: ${side} (rules)`,
      signalReason ? `Reason: ${signalReason}` : null,
      `Price: ${price} | ATR: ${atr}`,
      `SL (fixed, rules): ${slRules} (${slAtrMult}×ATR)`,
      `TP (rules baseline): ${tpRules} (${tpAtrMult}×ATR)`,
      indicatorParts.join(" | "),
      "",
      `Task: confirm_entry (conf 1-10, min ${minConfidenceEntry}) + tp_mode full|partial (tp_mode_confidence 1-10, min ${minTpModeConfidence} for partial) + tp_review (approve or suggest_tp, tp_confidence 1-10, min ${minTpConfidence})`,
      "Ground your reasoning in THIS strategy's methodology above — not generic EMA/RSI heuristics.",
      "Return ONLY valid JSON per schema. NEVER suggest stop_loss.",
    ].filter(Boolean);

    return {
      text: lines.join("\n"),
      payload: {
        strategyKey,
        side,
        price,
        atr,
        sl_rules: slRules,
        tp_rules: tpRules,
        htfTrend: htfTrend ?? indicatorSnapshot.htfTrend ?? null,
        indicatorSnapshot,
      },
    };
  }
}

module.exports = GrokConfirmPromptBuilder;
