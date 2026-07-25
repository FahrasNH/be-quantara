"use strict";

/**
 * Placeholder for strategy×tradeType combinations without a full walk-forward script yet.
 * Copy smart-money-concepts/intraday.js or scalping.js as a starting point.
 */
function stubMain({ strategyKey, tradeType, slug }) {
  console.error(`\nWalk-forward export not implemented: ${strategyKey} · ${tradeType}`);
  console.error(`Expected path: scripts/walkforward/${slug}/${tradeType.toLowerCase()}.js`);
  console.error("\nImplemented today:");
  console.error("  smart-money-concepts/scalping.js       (8 windows BTC)");
  console.error("  smart-money-concepts/scalping-research.js (export + R#1/R#3)");
  console.error("  smart-money-concepts/intraday.js       (5×5 promotion gate)");
  console.error("  smart-money-concepts/swing.js          (5×5 promotion gate)");
  console.error("  statistical-arbitrage/swing.js         (5×5 SA Swing)");
  console.error("  volume-spread-analysis/intraday.js     (3-window GO/NO-GO)");
  console.error("\nSee scripts/walkforward/README.md for structure and template.");
  process.exit(2);
}

module.exports = { stubMain };
