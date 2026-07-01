/**
 * Quantara Tier Configuration
 * Version: 2.0.0
 *
 * Maps tiers to umbrellas, risk limits, and capabilities.
 */

const TIER_NAMES = {
  FOUNDRY: "FOUNDRY",
  FORGE:   "FORGE",
  MINT:    "MINT",
  VAULT:   "VAULT",
};

const TIERS = {
  FOUNDRY: {
    id:       "foundry",
    name:     "Foundry",
    order:    1,
    abbrev:   "AF",
    umbrella: "ADAPTIVE_FUSION",
    color:    "#9D84B7",

    strategies: { active: ["AF_SMC"], future: ["AF_LS", "AF_OBR"] },

    capabilities: {
      maxConcurrentBots:     1,
      maxPositionsPerSymbol: 1,
      maxLeverage:           3,
      tradeTypes:            ["Scalping", "Intraday", "Swing"],
      supportedTimeframes:   ["1M", "5M", "15M", "1H", "4H"],
      optimalTimeframe:      "1M-1H",
    },

    riskManagement: {
      maxRiskPerTrade:          0.5,
      dailyLossLimit:           3,
      maxConsecutiveLosses:     2,
      cooldownAfterLossMinutes: 10,
      votingThreshold:          0.60,
    },

    pricing: { monthlyUSD: 9, annualUSD: 90 },

    targetProfile: {
      experience: "Beginner to Intermediate",
      capital:    "$60–$130 (Rp 1–2M)",
      goal:       "Learn & automate basic trading",
    },
  },

  FORGE: {
    id:       "forge",
    name:     "Forge",
    order:    2,
    abbrev:   "TS",
    umbrella: "TREND_SURGE",
    color:    "#FF6B35",

    strategies: { active: ["TS_TM"], future: ["TS_EE", "TS_MTF"] },

    capabilities: {
      maxConcurrentBots:     2,
      maxPositionsPerSymbol: 1,
      maxLeverage:           5,
      tradeTypes:            ["Intraday", "Swing"],
      supportedTimeframes:   ["5M", "15M", "1H", "4H", "1D"],
      optimalTimeframe:      "15M-1H",
    },

    riskManagement: {
      maxRiskPerTrade:          1.0,
      dailyLossLimit:           5,
      maxConsecutiveLosses:     3,
      cooldownAfterLossMinutes: 15,
      votingThreshold:          0.65,
    },

    pricing: { monthlyUSD: 29, annualUSD: 290 },

    targetProfile: {
      experience: "Intermediate",
      capital:    "$130–$325 (Rp 2–5M)",
      goal:       "Multi-strategy growth",
    },
  },

  MINT: {
    id:       "mint",
    name:     "Mint",
    order:    3,
    abbrev:   "MD",
    umbrella: "MEAN_DRIFT",
    color:    "#06D6A0",

    strategies: { active: ["MD_MR"], future: ["MD_BB", "MD_RD"] },

    capabilities: {
      maxConcurrentBots:     3,
      maxPositionsPerSymbol: 1,
      maxLeverage:           3,
      tradeTypes:            ["Swing", "Intraday"],
      supportedTimeframes:   ["15M", "1H", "4H", "1D"],
      optimalTimeframe:      "1H-4H",
    },

    riskManagement: {
      maxRiskPerTrade:          1.5,
      dailyLossLimit:           6,
      maxConsecutiveLosses:     2,
      cooldownAfterLossMinutes: 20,
      votingThreshold:          0.65,
    },

    pricing: { monthlyUSD: 79, annualUSD: 790 },

    targetProfile: {
      experience: "Advanced",
      capital:    "$325–$650 (Rp 5–10M)",
      goal:       "Professional-grade automation",
    },
  },

  VAULT: {
    id:       "vault",
    name:     "Vault",
    order:    4,
    abbrev:   "BS",
    umbrella: "BREAKOUT_STORM",
    color:    "#FFB703",

    strategies:    { active: ["BS_BR"], future: ["BS_VS", "BS_LB"] },
    bonusFeatures: ["GROK_AI_TRADING"],

    capabilities: {
      maxConcurrentBots:     4,
      maxPositionsPerSymbol: 1,
      maxLeverage:           2,
      tradeTypes:            ["Scalping", "Swing"],
      supportedTimeframes:   ["5M", "15M", "1H", "4H", "1D"],
      optimalTimeframe:      "5M-1H",
    },

    riskManagement: {
      maxRiskPerTrade:          2.0,
      dailyLossLimit:           8,
      maxConsecutiveLosses:     3,
      cooldownAfterLossMinutes: 5,
      votingThreshold:          0.70,
    },

    pricing: { monthlyUSD: 299, annualUSD: 2990 },

    targetProfile: {
      experience: "Expert",
      capital:    "$1300+ (Rp 20M+)",
      goal:       "Maximum automation & optimization",
    },
  },
};

function getTierConfig(tierName) {
  return TIERS[tierName] || null;
}

function getAllTiers() {
  return Object.values(TIERS).sort((a, b) => a.order - b.order);
}

function getTierActiveStrategies(tierName) {
  return TIERS[tierName]?.strategies.active || [];
}

module.exports = { TIER_NAMES, TIERS, getTierConfig, getAllTiers, getTierActiveStrategies };
