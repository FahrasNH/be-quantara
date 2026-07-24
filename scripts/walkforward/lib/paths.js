"use strict";

const path = require("path");

/** be-bot-trading/ — stable regardless of shell cwd */
const REPO_ROOT = path.resolve(__dirname, "../../..");

function windowDir(outRoot, winId, symbol = null) {
  const base = path.join(outRoot, `window-${String(winId).padStart(2, "0")}`);
  return symbol ? path.join(base, symbol) : base;
}

/** Canonical walkforward artifact root (new exports). Legacy output paths kept per script. */
function defaultOutRoot(strategySlug, tradeType) {
  return path.join(REPO_ROOT, "tmp/walkforward", strategySlug, tradeType.toLowerCase());
}

module.exports = {
  REPO_ROOT,
  windowDir,
  defaultOutRoot,
};
