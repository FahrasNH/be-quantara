/**
 * core/execution-engine — pure helpers extracted from BotEngine (Phase 2g).
 * Order placement / tick loop remain in modules/trading/application/BotEngine.
 */

const { stratLabel, fmtHoldingMs, fmtPx } = require("./format");
const { GROK_CONFIRM_STRATEGIES, MR_STRATEGY_KEYS, isMeanReversionKey } = require("./strategyKeys");
const { evaluateSlTpHit } = require("./slTp");
const { estimateRoundTripFee } = require("./fees");
const { filterOrphanTradesForEngine, positionFromDbTrade } = require("./positionRestore");

module.exports = {
  stratLabel,
  fmtHoldingMs,
  fmtPx,
  GROK_CONFIRM_STRATEGIES,
  MR_STRATEGY_KEYS,
  isMeanReversionKey,
  evaluateSlTpHit,
  estimateRoundTripFee,
  filterOrphanTradesForEngine,
  positionFromDbTrade,
};
