/**
 * Unit test Grok Confirm Gate (Mode B) — parse, validate, TP clamp, R:R.
 * Run: node test/grok-confirm.test.js
 */

const GrokConfirmService = require("../src/server/services/GrokConfirmService");
const GrokConfirmPromptBuilder = require("../src/server/services/GrokConfirmPromptBuilder");

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

console.log("\n=== Grok Confirm Tests ===\n");

test("resolveTakeProfit — LONG clamp dalam band", () => {
  const final = GrokConfirmService.resolveTakeProfit({
    tpRules: 98500,
    suggestedTp: 98750,
    side: "LONG",
    price: 97500,
    atr: 320,
    bandPct: 15,
    maxAtrMult: 0.5,
  });
  // band ±150, cap 160 → ±150 → range 98350–98650; 98750 → 98650
  if (final !== 98650) throw new Error(`expected 98650, got ${final}`);
});

test("resolveTakeProfit — LONG suggest dalam band unchanged", () => {
  const final = GrokConfirmService.resolveTakeProfit({
    tpRules: 98500,
    suggestedTp: 98400,
    side: "LONG",
    price: 97500,
    atr: 320,
    bandPct: 15,
    maxAtrMult: 0.5,
  });
  if (final !== 98400) throw new Error(`expected 98400, got ${final}`);
});

test("resolveTakeProfit — SHORT clamp", () => {
  const final = GrokConfirmService.resolveTakeProfit({
    tpRules: 96500,
    suggestedTp: 96200,
    side: "SHORT",
    price: 97500,
    atr: 320,
    bandPct: 15,
    maxAtrMult: 0.5,
  });
  // baseline 96500, band ±150 → lo 96350; suggested 96200 clamped up
  if (final < 96350) throw new Error(`SHORT TP should not go below band lo, got ${final}`);
});

test("resolveTakeProfit — null suggested → TP rules", () => {
  const final = GrokConfirmService.resolveTakeProfit({
    tpRules: 98500,
    suggestedTp: null,
    side: "LONG",
    price: 97500,
    atr: 320,
    bandPct: 15,
    maxAtrMult: 0.5,
  });
  if (final !== 98500) throw new Error("should fallback to rules TP");
});

test("validateConfirmation — entry conf 7 rejected", () => {
  const v = GrokConfirmService.validateConfirmation({
    confirm_entry: true,
    confidence: 7,
    tp_review: { approved: true, tp_confidence: 8, suggested_tp: 98500 },
  }, { minConfidenceEntry: 8, minTpConfidence: 7 });
  if (v.confirm_entry) throw new Error("conf 7 should not allow entry");
  if (!v.tp_approved) throw new Error("TP should still be approved at conf 8");
});

test("validateConfirmation — conf 8 + tp_conf 7 approved", () => {
  const v = GrokConfirmService.validateConfirmation({
    confirm_entry: true,
    confidence: 8,
    tp_review: { approved: true, tp_confidence: 7, suggested_tp: 98600 },
  }, { minConfidenceEntry: 8, minTpConfidence: 7 });
  if (!v.confirm_entry || !v.tp_approved) throw new Error("should approve entry+TP");
});

test("validateConfirmation — SL tidak diubah (no SL field in output)", () => {
  const v = GrokConfirmService.validateConfirmation({
    confirm_entry: true,
    confidence: 9,
    stop_loss: 97000,
    tp_review: { approved: true, tp_confidence: 8 },
  }, {});
  if ("stop_loss" in v || "sl" in v) throw new Error("SL must not appear in validated output");
});

test("validateRiskReward — reject low RR after TP adjust", () => {
  const rr = GrokConfirmService.validateRiskReward({
    side: "LONG",
    price: 97500,
    slPrice: 96900,
    tpPrice: 97600,
    minRiskReward: 1.2,
  });
  if (rr.valid) throw new Error("RR should fail");
});

test("validateRiskReward — accept healthy RR", () => {
  const rr = GrokConfirmService.validateRiskReward({
    side: "LONG",
    price: 97500,
    slPrice: 96900,
    tpPrice: 98500,
    minRiskReward: 1.2,
  });
  if (!rr.valid) throw new Error(`RR should pass, got ${rr.riskReward}`);
});

test("GrokConfirmPromptBuilder — lite prompt fields", () => {
  const built = GrokConfirmPromptBuilder.build({
    strategyKey: "ADAPTIVE_FUSION",
    side: "LONG",
    price: 97500,
    atr: 320,
    sl_rules: 96988,
    tp_rules: 98588,
    htfTrend: "BULLISH",
    indicatorSnapshot: { rsi: 62 },
    minConfidenceEntry: 8,
    minTpConfidence: 7,
  });
  if (!built.text.includes("ADAPTIVE_FUSION")) throw new Error("missing strategy");
  if (!built.text.includes("96988")) throw new Error("missing SL rules");
  if (!built.text.includes("98588")) throw new Error("missing TP rules");
  if (!built.text.includes("confirm_entry")) throw new Error("missing task");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exitCode = 1;
