/**
 * GrokConfirmPromptBuilder.js — prompt lite untuk Mode B (Grok Confirm Gate).
 */

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
    } = ctx;

    const slDist = Math.abs(price - slRules);
    const tpDist = Math.abs(tpRules - price);
    const slAtrMult = atr > 0 ? (slDist / atr).toFixed(2) : "N/A";
    const tpAtrMult = atr > 0 ? (tpDist / atr).toFixed(2) : "N/A";

    const lines = [
      `Strategy: ${strategyKey}`,
      `Signal: ${side} (rules)`,
      signalReason ? `Reason: ${signalReason}` : null,
      `Price: ${price} | ATR: ${atr}`,
      `SL (fixed, rules): ${slRules} (${slAtrMult}×ATR)`,
      `TP (rules baseline): ${tpRules} (${tpAtrMult}×ATR)`,
      `HTF: ${htfTrend ?? indicatorSnapshot.htfTrend ?? "N/A"} | RSI: ${indicatorSnapshot.rsi ?? "N/A"} | EMA fast/slow bias: ${indicatorSnapshot.emaTrendBias ?? "N/A"}`,
      "",
      `Task: confirm_entry (conf 1-10, min ${minConfidenceEntry}) + tp_review (approve or suggest_tp, tp_confidence 1-10, min ${minTpConfidence})`,
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
