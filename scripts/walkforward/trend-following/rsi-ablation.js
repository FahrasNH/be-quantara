#!/usr/bin/env node
"use strict";

/**
 * TREND_FOLLOWING RSI gate ablation — 3 windows × 3 tiers × variants A/B/C.
 *
 * Uses first 3 windows of GAP_POLICY_5 (2020–2021) — baseline variant A data
 * already exists in tmp/tf-{tier}-walkforward for these windows.
 * Scalping grid: BTC only (walk-forward default).
 *
 * Usage (from be-bot-trading/):
 *   node scripts/walkforward/trend-following/rsi-ablation.js --local --rsi-variant b
 *   node scripts/walkforward/trend-following/rsi-ablation.js --local --rsi-variant c --tier intraday
 *   node scripts/walkforward/trend-following/rsi-ablation.js --summary-only
 */

const path = require("path");
const { REPO_ROOT } = require("../lib/paths");
const { walkforwardMain, rsiVariantOutSuffix } = require("../lib/runWalkforwardMain");
const { GAP_POLICY_5 } = require("../lib/windows");
const RSI_ABLATION_WINDOWS = GAP_POLICY_5.slice(0, 3);
const { parseStringArg } = require("../lib/parseArgs");

const STRATEGY = { strategyKey: "TREND_FOLLOWING", slug: "trend-following" };
const TIERS = ["Scalping", "Intraday", "Swing"];

async function runTier(tradeType, argv) {
  await walkforwardMain({
    ...STRATEGY,
    tradeType,
    windowsOverride: RSI_ABLATION_WINDOWS,
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const tierOnly = parseStringArg(argv, "--tier");
  const tiers = tierOnly ? [tierOnly] : TIERS;

  if (!parseStringArg(argv, "--rsi-variant") && !process.env.RSI_VARIANT && !argv.includes("--summary-only")) {
    console.error("Pass --rsi-variant a|b|c (or RSI_VARIANT env). Use --summary-only to compare existing output.");
    process.exit(1);
  }

  console.log(`RSI ablation · tiers: ${tiers.join(", ")} · windows: ${RSI_ABLATION_WINDOWS.length} (GAP_POLICY_5 W1–W3)`);
  console.log(`Output root pattern: tmp/tf-<tier>-walkforward${rsiVariantOutSuffix(parseStringArg(argv, "--rsi-variant") || process.env.RSI_VARIANT)}`);

  for (const tradeType of tiers) {
    if (!TIERS.includes(tradeType)) {
      console.error(`Unknown tier: ${tradeType}. Use Scalping|Intraday|Swing`);
      process.exit(1);
    }
    await runTier(tradeType, argv);
  }

  console.log(`\nDone. Compare: node ${path.relative(REPO_ROOT, __filename).replace(/\\/g, "/")} --compare`);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes("--compare")) {
    require("./compare-rsi-ablation");
  } else {
    main().catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
  }
}

module.exports = { main, runTier };
