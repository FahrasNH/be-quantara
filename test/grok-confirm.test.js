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

test("validateConfirmation — tp_mode partial requires mode conf >= 6", () => {
  const v = GrokConfirmService.validateConfirmation({
    confirm_entry: true,
    confidence: 8,
    tp_mode: "partial",
    tp_mode_confidence: 6,
    tp_review: { approved: true, tp_confidence: 7, suggested_tp: 98600 },
  }, { minConfidenceEntry: 8, minTpConfidence: 7, minTpModeConfidence: 6 });
  if (v.tp_mode !== "partial") throw new Error("expected partial tp_mode");
});

test("validateConfirmation — tp_mode partial rejected when mode conf < 6", () => {
  const v = GrokConfirmService.validateConfirmation({
    confirm_entry: true,
    confidence: 8,
    tp_mode: "partial",
    tp_mode_confidence: 5,
    tp_review: { approved: true, tp_confidence: 7 },
  }, { minConfidenceEntry: 8, minTpConfidence: 7, minTpModeConfidence: 6 });
  if (v.tp_mode !== "full") throw new Error("low mode conf should default to full");
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

test("applyGate — approved with rules TP", () => {
  const applied = GrokConfirmService.applyGate(
    {
      confirm_entry: true,
      confidence: 9,
      tp_approved: true,
      tp_confidence: 8,
      suggested_tp: null,
    },
    { side: "LONG", price: 100, atr: 2, slPrice: 98, tpRules: 104, minRiskReward: 1.2 }
  );
  if (!applied.approved || applied.tp !== 104) throw new Error("should approve with rules TP");
});

test("applyGate — reject entry", () => {
  const applied = GrokConfirmService.applyGate(
    { confirm_entry: false, confidence: 6 },
    { side: "LONG", price: 100, atr: 2, slPrice: 98, tpRules: 104 }
  );
  if (applied.approved) throw new Error("should reject entry");
});

test("applyGate — reject when TP not approved (skip action)", () => {
  const confirm = GrokConfirmService.validateConfirmation({
    confirm_entry: true,
    confidence: 9,
    tp_review: { approved: false, tp_confidence: 5 },
  }, { minConfidenceEntry: 8, minTpConfidence: 7 });
  const applied = GrokConfirmService.applyGate(confirm, {
    side: "LONG",
    price: 100,
    atr: 2,
    slPrice: 98,
    tpRules: 104,
    tpRejectAction: "skip",
  });
  if (applied.approved) throw new Error("should reject when TP skip");
});

test("applyGate — use_rules_tp when TP review ditolak", () => {
  const confirm = GrokConfirmService.validateConfirmation({
    confirm_entry: true,
    confidence: 9,
    tp_review: { approved: false, tp_confidence: 5 },
  }, { minConfidenceEntry: 8, minTpConfidence: 7 });
  const applied = GrokConfirmService.applyGate(confirm, {
    side: "LONG",
    price: 100,
    atr: 2,
    slPrice: 97,
    tpRules: 106,
    tpRejectAction: "use_rules_tp",
    minRiskReward: 1.2,
  });
  if (!applied.approved || applied.tp !== 106) {
    throw new Error("use_rules_tp should approve entry with rules TP");
  }
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
  if (!/ADAPTIVE_FUSION|Smart Money|Adaptive Fusion/i.test(built.text)) {
    throw new Error("missing strategy");
  }
  if (!built.text.includes("96988")) throw new Error("missing SL rules");
  if (!built.text.includes("98588")) throw new Error("missing TP rules");
  if (!built.text.includes("confirm_entry")) throw new Error("missing task");
});

test("canUseGrokConfirm — userId kosong ditolak tanpa throw", async () => {
  const GrokConfirmService = require("../src/server/services/GrokConfirmService");
  const r = await GrokConfirmService.canUseGrokConfirm(undefined, { backtest: true });
  if (r.allowed !== false) throw new Error("expected denied without userId");
  if (!r.reason?.includes("Unauthorized")) throw new Error(`unexpected reason: ${r.reason}`);
});

test("canUseGrokConfirm — backtest lolos tanpa gate langganan Vault", async () => {
  const GrokConfirmService = require("../src/server/services/GrokConfirmService");
  const orig = GrokConfirmService.isApiReady;
  GrokConfirmService.isApiReady = () => true;
  try {
    const r = await GrokConfirmService.canUseGrokConfirm("user-test-id", { backtest: true });
    if (!r.allowed) throw new Error(`expected allowed for backtest, got: ${r.reason}`);
  } finally {
    GrokConfirmService.isApiReady = orig;
  }
});

test("hasVaultSubscription — tier VAULT true, FOUNDRY false", () => {
  const GrokConfirmService = require("../src/server/services/GrokConfirmService");
  if (!GrokConfirmService.hasVaultSubscription("VAULT")) throw new Error("VAULT should pass");
  if (GrokConfirmService.hasVaultSubscription("FOUNDRY")) throw new Error("FOUNDRY should fail");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exitCode = 1;
