/**
 * Shared Grok Confirm batch processing for sync endpoint and async backtest jobs.
 */

const { STRATEGIES } = require("../../../domain/legacyStrategies");
const GrokConfirmService = require("./GrokConfirmService");
const cfg = require("../../../config/env");

const GROK_CONFIRM_CONCURRENCY = cfg.GROK_CONFIRM_CONCURRENCY;

function buildLogEntry(sig, decision) {
  const id = String(sig.id ?? sig.barIndex);
  return {
    time: Date.now(),
    signalId: id,
    side: sig.side || null,
    price: Number(sig.price ?? sig.entry) || null,
    approved: Boolean(decision.approved),
    confidence: decision.confidence ?? null,
    tpMode: decision.tpMode ?? null,
    tpConfidence: decision.tpConfidence ?? null,
    reason: String(decision.reason || "").slice(0, 240),
    failOpen: decision.failOpen ?? false,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.strategyKey — uppercase strategy key
 * @param {string} [opts.symbol]
 * @param {object[]} opts.signals
 * @param {boolean} [opts.tpAdjust]
 * @param {number} [opts.tpBandPct]
 * @param {string} [opts.tpRejectAction]
 * @param {(done: number, total: number, decisions?: object, logEntry?: object) => void} [opts.onProgress]
 */
async function processBatch({
  userId,
  strategyKey,
  symbol,
  signals = [],
  tpAdjust = true,
  tpBandPct,
  tpRejectAction,
  onProgress,
  seedDecisions = {},
}) {
  const strat = STRATEGIES[strategyKey] || {};
  const minEntry = strat.grokConfirmMinEntry ?? cfg.GROK_CONFIRM_MIN_CONFIDENCE_ENTRY;
  const minTp = strat.grokConfirmMinTp ?? cfg.GROK_CONFIRM_MIN_TP_CONFIDENCE;
  const bandPct = tpBandPct ?? cfg.GROK_CONFIRM_TP_ADJUST_BAND_PCT;
  const rejectAction = tpRejectAction ?? "use_rules_tp";
  const minRiskReward = strat.minRiskReward ?? strat.riskReward ?? 1.2;

  const decisions = { ...seedDecisions };
  let approved = 0;
  let rejected = 0;
  let apiCalls = 0;
  const total = signals.length;

  for (const d of Object.values(decisions)) {
    if (d?.approved) approved += 1;
    else rejected += 1;
  }

  const pendingSignals = signals.filter((sig) => {
    const id = String(sig.id ?? sig.barIndex);
    return !Object.prototype.hasOwnProperty.call(decisions, id);
  });

  let done = total - pendingSignals.length;
  onProgress?.(done, total, decisions);

  async function processSignal(sig) {
    const id = String(sig.id ?? sig.barIndex);
    const side = sig.side;
    const price = Number(sig.price ?? sig.entry);
    const atr = Number(sig.atr ?? sig.curATR);
    const slRules = Number(sig.sl ?? sig.sl_rules);
    const tpRules = Number(sig.tp ?? sig.tp_rules);
    if (!side || !Number.isFinite(price) || !Number.isFinite(atr)) {
      const decision = { approved: false, reason: "invalid signal payload" };
      decisions[id] = decision;
      rejected += 1;
      done += 1;
      onProgress?.(done, total, decisions, buildLogEntry(sig, decision));
      return;
    }

    try {
      const confirm = await GrokConfirmService.requestConfirmation({
        symbol: symbol || "BACKTEST",
        strategyKey,
        side,
        price,
        atr,
        sl_rules: slRules,
        tp_rules: tpRules,
        indicatorSnapshot: sig.indicatorSnapshot || { rsi: sig.rsi, emaTrendBias: sig.emaTrendBias },
        htfTrend: sig.htfTrend,
        signalReason: sig.signalReason || "backtest rules signal",
        minConfidenceEntry: minEntry,
        minTpConfidence: minTp,
        userId,
        botId: null,
        backtest: true,
      });
      apiCalls += 1;

      const applied = GrokConfirmService.applyGate(confirm, {
        side,
        price,
        atr,
        slPrice: slRules,
        tpRules,
        tpAdjust: tpAdjust !== false,
        tpBandPct: bandPct,
        tpRejectAction: rejectAction,
        minRiskReward,
      });

      const decision = {
        approved: applied.approved,
        tp: applied.tp,
        tpDist: applied.tpDist,
        tpMode: applied.tpMode ?? "full",
        reason: applied.reason,
        tpReasoning: applied.tpReasoning,
        confidence: applied.confidence,
        tpConfidence: applied.tpConfidence,
        tpModeConfidence: applied.tpModeConfidence ?? null,
        failOpen: applied.failOpen ?? false,
      };
      decisions[id] = decision;
      if (applied.approved) approved += 1;
      else rejected += 1;
      done += 1;
      onProgress?.(done, total, decisions, buildLogEntry(sig, decision));
      return;
    } catch (err) {
      let decision;
      if (cfg.GROK_CONFIRM_FAIL_MODE === "open") {
        decision = {
          approved: true,
          tp: tpRules,
          tpDist: Math.abs(tpRules - price),
          tpMode: "full",
          reason: `fail-open: ${err.message}`,
          failOpen: true,
        };
        approved += 1;
      } else {
        decision = { approved: false, reason: err.message };
        rejected += 1;
      }
      decisions[id] = decision;
      done += 1;
      onProgress?.(done, total, decisions, buildLogEntry(sig, decision));
      return;
    }
  }

  for (let i = 0; i < pendingSignals.length; i += GROK_CONFIRM_CONCURRENCY) {
    const chunk = pendingSignals.slice(i, i + GROK_CONFIRM_CONCURRENCY);
    await Promise.all(chunk.map(processSignal));
  }

  return {
    decisions,
    stats: {
      total: signals.length,
      approved,
      rejected,
      apiCalls,
    },
  };
}

module.exports = {
  processBatch,
  GROK_CONFIRM_CONCURRENCY,
};
