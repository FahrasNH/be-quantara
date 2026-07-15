"use strict";

/**
 * BotEngineMlHook.js — Fire-and-forget ML shadow + embedding hooks for BotEngine.
 */

const MLShadowService = require("./MLShadowService");
const TradeFeatureCollector = require("./TradeFeatureCollector");
const { indicatorsSnapshotToEntryContext } = require("../../analytics/domain/engineTradeMlAdapter");

let _svc = null;
let _collector = null;

function getMlShadowService() {
  if (_svc) return _svc;
  try {
    _svc = MLShadowService.autoStart();
  } catch {
    _svc = null;
  }
  return _svc;
}

function getFeatureCollector() {
  if (!_collector) _collector = new TradeFeatureCollector();
  return _collector;
}

/**
 * Called after db.insertTrade succeeds (live or dry-run with dbId).
 */
function onEngineTradeOpen(dbId, enrichedSnapshot, meta = {}) {
  if (!dbId) return;
  const svc = getMlShadowService();
  if (!svc) return;

  const snapshot = enrichedSnapshot || {};
  const collector = getFeatureCollector();

  collector.captureEntryFeatures({
    symbol:      meta.symbol,
    strategyKey: meta.strategyKey,
    side:        meta.side,
    indicators:  snapshot,
    htfTrend:    snapshot.htfTrend ?? meta.htfTrend,
    confidence:  snapshot.afAggregateConfidence ?? snapshot.afConfidence ?? meta.confidence,
    config:      { strategyKey: meta.strategyKey, leverage: meta.leverage },
    capital:     meta.capital,
  }).then((captured) => {
    const entryContext = captured?.capturedAt
      ? { ...captured, regime: snapshot.afMarketCond ?? meta.marketCond ?? captured.regime }
      : indicatorsSnapshotToEntryContext(snapshot, {
        strategyKey: meta.strategyKey,
        symbol:      meta.symbol,
        side:        meta.side,
        entryPrice:  meta.entryPrice,
        openTime:    meta.openTime,
        marketCond:  snapshot.afMarketCond,
        htfTrend:    snapshot.htfTrend ?? meta.htfTrend,
        confidence:  snapshot.afAggregateConfidence ?? snapshot.afConfidence ?? meta.confidence,
        pairTier:    meta.pairTier,
        leverage:    meta.leverage,
        capital:     meta.capital,
      });

    return svc.logPrediction(String(dbId), entryContext, {
      strategyKey: meta.strategyKey,
      symbol:      meta.symbol,
      regime:      entryContext.regime ?? entryContext.htfRegime,
    });
  }).catch(() => {});
}

/**
 * Called after db.closeTrade succeeds.
 */
function onEngineTradeClose(dbId, pnl) {
  if (!dbId) return;
  const svc = getMlShadowService();
  if (!svc) return;
  const outcome = (parseFloat(pnl) || 0) > 0 ? "win" : "loss";
  svc.recordOutcome(String(dbId), outcome).catch(() => {});
}

module.exports = { onEngineTradeOpen, onEngineTradeClose, getMlShadowService };
