"use strict";

function parseIntArg(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? parseInt(argv[i + 1], 10) : null;
}

function parseStringArg(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
}

/**
 * Common walk-forward CLI flags shared by grid export scripts.
 * @param {string[]} [argv]
 */
function parseRsiVariantArg(argv = process.argv.slice(2)) {
  const cli = parseStringArg(argv, "--rsi-variant");
  const env = process.env.RSI_VARIANT;
  const raw = cli || env || null;
  if (!raw) return null;
  return String(raw).toLowerCase();
}

function parseGridArgs(argv = process.argv.slice(2)) {
  return {
    dryRun: argv.includes("--dry-run"),
    useLocal: argv.includes("--local"),
    summaryOnly: argv.includes("--summary-only"),
    exportOnly: argv.includes("--export-only"),
    analyzeOnly: argv.includes("--analyze-only"),
    windowFilter: parseIntArg(argv, "--window"),
    symbolFilter: parseStringArg(argv, "--symbol"),
    rsiVariant: parseRsiVariantArg(argv),
  };
}

module.exports = {
  parseGridArgs,
  parseIntArg,
  parseStringArg,
  parseRsiVariantArg,
};
