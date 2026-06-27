/**
 * Unit test untuk integrasi xAI — tanpa API key (pure logic).
 * Run: node test/xai-integration.test.js
 */

const OptimizationAnalysisService = require("../src/server/services/OptimizationAnalysisService");
const XaiTrainingService = require("../src/server/services/XaiTrainingService");

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

console.log("\n=== xAI Integration Tests ===\n");

test("mergeAiWithRules — prioritaskan skor AI", () => {
  const rules = {
    overall_score: 50,
    recommendations: [{ title: "Fix Losses", priority: "high", description: "x" }],
    opportunities: [],
    risk_assessment: { level: "Moderate", summary: "rules summary" },
  };
  const ai = {
    overall_score: 72,
    ai_summary: "Performa cukup baik",
    recommendations: [{ title: "Tighten RSI", priority: "medium", description: "y" }],
    opportunities: [{ area: "TP", suggestion: "Naikkan TP 20%" }],
    parameter_suggestions: [{ strategy: "ADAPTIVE_FUSION", param: "riskReward", suggested: "2.5", reason: "PF rendah" }],
    risk_assessment: { level: "Low", summary: "ai summary", key_risks: ["volatility"] },
    model: "grok-4.3",
  };
  const merged = OptimizationAnalysisService.mergeAiWithRules(rules, ai);
  if (merged.overall_score !== 72) throw new Error(`expected 72, got ${merged.overall_score}`);
  if (merged.source !== "xai+rules") throw new Error("wrong source");
  if (merged.recommendations.length !== 2) throw new Error("should merge 2 recs");
  if (!merged.parameter_suggestions.length) throw new Error("missing param suggestions");
});

test("mergeAiWithRules — dedupe by title", () => {
  const rules = { recommendations: [{ title: "Same", priority: "low" }], opportunities: [], risk_assessment: {} };
  const ai = { recommendations: [{ title: "Same", priority: "high" }], opportunities: [], risk_assessment: {} };
  const merged = OptimizationAnalysisService.mergeAiWithRules(rules, ai);
  if (merged.recommendations.length !== 1) throw new Error("should dedupe");
  if (merged.recommendations[0].priority !== "high") throw new Error("AI rec should win");
});

test("XaiTrainingService.getStatus — struktur valid", () => {
  const status = XaiTrainingService.getStatus();
  if (typeof status.enabled !== "boolean") throw new Error("missing enabled");
  if (!status.console_url.includes("console.x.ai")) throw new Error("missing console url");
});

test("_normalizeAiOutput — clamp score 0-100", () => {
  const out = XaiTrainingService._normalizeAiOutput({ overall_score: 150, recommendations: [] });
  if (out.overall_score !== 100) throw new Error("score should clamp to 100");
});

test("_buildRuleAnalysis — returns expected keys", () => {
  const metrics = {
    win_rate_pct: 55,
    profit_factor: 1.8,
    max_drawdown_pct: -10,
    roi_pct: 30,
    sharpe_ratio: 1.5,
    total_trades: 100,
    expectancy: 0.05,
    average_r: 1.2,
  };
  const result = OptimizationAnalysisService._buildRuleAnalysis(metrics);
  if (!result.overall_score) throw new Error("missing score");
  if (!Array.isArray(result.recommendations)) throw new Error("missing recs");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exitCode = 1;
