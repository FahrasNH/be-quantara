"use strict";

/**
 * SSOT for walkforward tmp/ dir presets used by seed + VPS deploy scripts.
 * Maps LIVE_COMPONENT_KEYS (12 strategies) → tmp/<prefix>-{scalping|intraday|swing}-walkforward
 */

const TRADE_TYPE_SLUGS = ["scalping", "intraday", "swing"];

/** Prefix slug per strategy (matches scripts/walkforward/lib/runWalkforwardMain.js OUT_PREFIX) */
const STRATEGY_PREFIX = Object.freeze({
  SMART_MONEY_CONCEPTS: "smc",
  WYCKOFF: "wyckoff",
  VOLUME_SPREAD_ANALYSIS: "vsa",
  TREND_FOLLOWING: "tf",
  MARKET_STRUCTURE: "ms",
  AUCTION_MARKET_THEORY: "amt",
  MEAN_REVERSION: "mr",
  SUPPLY_AND_DEMAND: "snd",
  STATISTICAL_ARBITRAGE: "sa",
  BREAKOUT_RETEST: "br",
  ICT_STYLE_TRADING: "ict",
  LIQUIDATION_SQUEEZE: "ls",
});

const LIVE_PREFIXES = Object.values(STRATEGY_PREFIX);

const PRESET_PREFIXES = Object.freeze({
  "all-live": LIVE_PREFIXES,
  "seed-all": LIVE_PREFIXES,
  af: ["smc", "wyckoff", "vsa"],
  ts: ["tf", "ms", "amt"],
  md: ["mr", "snd", "sa"],
  bs: ["br", "ict", "ls"],
  smc: ["smc"],
  wyckoff: ["wyckoff"],
  vsa: ["vsa"],
  tf: ["tf"],
  ms: ["ms"],
  amt: ["amt"],
  mr: ["mr"],
  snd: ["snd"],
  sa: ["sa"],
  br: ["br"],
  ict: ["ict"],
  ls: ["ls"],
});

/** CLI flag → preset key */
const FLAG_TO_PRESET = Object.freeze({
  "--all-live": "all-live",
  "--seed-all": "all-live",
  "--af-all": "af",
  "--ts-all": "ts",
  "--md-all": "md",
  "--bs-all": "bs",
  "--smc-all": "smc",
  "--wyckoff-all": "wyckoff",
  "--vsa-all": "vsa",
  "--tf-all": "tf",
  "--ms-all": "ms",
  "--amt-all": "amt",
  "--mr-all": "mr",
  "--snd-all": "snd",
  "--sa-all": "sa",
  "--br-all": "br",
  "--ict-all": "ict",
  "--ls-all": "ls",
});

function dirsForPrefixes(prefixes, repoRelative = true) {
  const base = repoRelative ? "tmp/" : "";
  return prefixes.flatMap((p) =>
    TRADE_TYPE_SLUGS.map((t) => `${base}${p}-${t}-walkforward`)
  );
}

function presetToDirs(presetKey, repoRelative = true) {
  const prefixes = PRESET_PREFIXES[presetKey];
  if (!prefixes) return null;
  return dirsForPrefixes(prefixes, repoRelative);
}

function presetToBasenames(presetKey) {
  return presetToDirs(presetKey, true).map((d) => d.replace(/^tmp\//, ""));
}

/**
 * Collect unique tmp basenames from CLI argv (flags + --dir=tmp/foo-walkforward).
 * @param {string[]} argv
 * @returns {string[]}
 */
function collectBasenamesFromArgv(argv) {
  const seen = new Set();
  for (const arg of argv) {
    const presetKey = FLAG_TO_PRESET[arg];
    if (presetKey) {
      for (const b of presetToBasenames(presetKey)) seen.add(b);
      continue;
    }
    if (arg.startsWith("--dir=")) {
      let rel = arg.slice(6).replace(/\\/g, "/");
      rel = rel.replace(/^\.\//, "").replace(/^tmp\//, "");
      seen.add(rel.replace(/\/$/, ""));
    }
  }
  if (seen.size === 0) {
    for (const b of presetToBasenames("tf")) seen.add(b);
  }
  return [...seen].sort();
}

/**
 * Collect repo-relative tmp paths for seed script.
 * @param {string[]} argv
 * @returns {string[]}
 */
function collectDirsFromArgv(argv) {
  return collectBasenamesFromArgv(argv).map((b) => `tmp/${b}`);
}

module.exports = {
  TRADE_TYPE_SLUGS,
  STRATEGY_PREFIX,
  LIVE_PREFIXES,
  PRESET_PREFIXES,
  FLAG_TO_PRESET,
  dirsForPrefixes,
  presetToDirs,
  presetToBasenames,
  collectBasenamesFromArgv,
  collectDirsFromArgv,
};
