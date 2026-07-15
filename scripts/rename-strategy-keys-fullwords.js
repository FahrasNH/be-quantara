#!/usr/bin/env node
/**
 * One-shot bulk rename: deprecated Gen2 abbrevs → full-word canonical keys.
 * Skips ACL modules (they retain alias sources) and historical prisma migrations.
 */
const fs = require("fs");
const path = require("path");

const REPOS = [
  path.join(__dirname, ".."),
  path.join(__dirname, "../../fe-bot-trading"),
];

const SKIP_PATH_PARTS = [
  `${path.sep}node_modules${path.sep}`,
  `${path.sep}.git${path.sep}`,
  `${path.sep}prisma${path.sep}migrations${path.sep}`,
];

const SKIP_FILES = new Set([
  path.normalize("src/config/strategyKeyNormalizer.js"),
  path.normalize("src/utils/strategyKeyNormalizer.js"),
]);

/** Longest keys first to avoid partial overlap (none overlap, but safe). */
const REPLACEMENTS = [
  ["WYCKOFF", "WYCKOFF"],
  ["VOLUME_SPREAD_ANALYSIS", "VOLUME_SPREAD_ANALYSIS"],
  ["SMART_MONEY_CONCEPTS", "SMART_MONEY_CONCEPTS"],
  ["TREND_FOLLOWING", "TREND_FOLLOWING"],
  ["MARKET_STRUCTURE", "MARKET_STRUCTURE"],
  ["AUCTION_MARKET_THEORY", "AUCTION_MARKET_THEORY"],
  ["MEAN_REVERSION", "MEAN_REVERSION"],
  ["SUPPLY_AND_DEMAND", "SUPPLY_AND_DEMAND"],
  ["STATISTICAL_ARBITRAGE", "STATISTICAL_ARBITRAGE"],
  ["BREAKOUT_RETEST", "BREAKOUT_RETEST"],
  ["ICT_STYLE_TRADING", "ICT_STYLE_TRADING"],
  ["LIQUIDATION_SQUEEZE", "LIQUIDATION_SQUEEZE"],
];

function shouldSkip(file, repoRoot) {
  const rel = path.relative(repoRoot, file).split(path.sep).join(path.sep);
  const normRel = path.normalize(rel);
  if (SKIP_FILES.has(normRel)) return true;
  for (const part of SKIP_PATH_PARTS) {
    if (file.includes(part)) return true;
  }
  return false;
}

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, acc);
    else if (/\.(js|jsx|ts|tsx|md|sql|json)$/.test(ent.name)) acc.push(full);
  }
  return acc;
}

function replaceContent(content) {
  let out = content;
  for (const [from, to] of REPLACEMENTS) {
    const re = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    out = out.replace(re, to);
  }
  return out;
}

let changed = 0;
for (const repo of REPOS) {
  if (!fs.existsSync(repo)) continue;
  for (const file of walk(repo)) {
    if (shouldSkip(file, repo)) continue;
    const before = fs.readFileSync(file, "utf8");
    const after = replaceContent(before);
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed += 1;
      console.log("updated:", path.relative(repo, file));
    }
  }
}
console.log(`\nDone — ${changed} files updated.`);
