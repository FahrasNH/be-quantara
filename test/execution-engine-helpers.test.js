/**
 * Phase 2g — pure helpers extracted from BotEngine into core/execution-engine
 * (+ entry risk gates in core/risk-engine). Behavior-preserving unit coverage.
 */
"use strict";

const assert = require("assert");
const {
  stratLabel,
  fmtHoldingMs,
  fmtPx,
  isMeanReversionKey,
  GROK_CONFIRM_STRATEGIES,
  evaluateSlTpHit,
  estimateRoundTripFee,
  filterOrphanTradesForEngine,
  positionFromDbTrade,
} = require("../src/core/execution-engine");
const { checkEntryRiskGates, checkAtrRangeGate } = require("../src/core/risk-engine/entryRiskGates");

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (err) { fail++; failures.push({ name, message: err.message }); console.log(`  ❌ ${name}\n       ${err.message}`); }
}

console.log("\n⚙️  execution-engine helpers (Phase 2g)\n");

t("stratLabel title-cases strategy keys", () => {
  assert.strictEqual(stratLabel("ADAPTIVE_FUSION"), "Adaptive Fusion");
  assert.strictEqual(stratLabel(""), "—");
  assert.strictEqual(stratLabel(null), "—");
});

t("fmtHoldingMs formats hours/minutes", () => {
  assert.strictEqual(fmtHoldingMs(6 * 60_000), "6M");
  assert.strictEqual(fmtHoldingMs(22 * 3600_000 + 6 * 60_000), "22H 6M");
  assert.strictEqual(fmtHoldingMs(-1), "—");
});

t("fmtPx uses more decimals for cheap coins", () => {
  assert.ok(fmtPx(612.46).includes("612"));
  assert.ok(fmtPx(0.094).length >= 4);
});

t("isMeanReversionKey + GROK_CONFIRM_STRATEGIES", () => {
  assert.strictEqual(isMeanReversionKey("MD_MR"), true);
  assert.strictEqual(isMeanReversionKey("mr"), true);
  assert.strictEqual(isMeanReversionKey("TREND_FOLLOWING"), false);
  assert.ok(GROK_CONFIRM_STRATEGIES.has("ADAPTIVE_FUSION"));
});

t("evaluateSlTpHit: LONG wick TP / SL / tie → SL wins", () => {
  const pos = { side: "LONG", sl: 604.09, tp: 612.46 };
  const tpHit = evaluateSlTpHit(pos, 611.92, 612.50, 611.00);
  assert.strictEqual(tpHit.hitTP, true);
  assert.strictEqual(tpHit.hitSL, false);
  assert.strictEqual(tpHit.isTP, true);

  const slHit = evaluateSlTpHit(pos, 605.00, 606.00, 604.00);
  assert.strictEqual(slHit.hitSL, true);

  const both = evaluateSlTpHit(pos, 608.00, 613.00, 603.50);
  assert.strictEqual(both.hitSL, true);
  assert.strictEqual(both.hitTP, true);
  assert.strictEqual(both.isTP, false, "SL wins on simultaneous hit");
});

t("evaluateSlTpHit: SHORT wick TP", () => {
  const pos = { side: "SHORT", sl: 110, tp: 90 };
  const hit = evaluateSlTpHit(pos, 95, 98, 89);
  assert.strictEqual(hit.hitTP, true);
  assert.strictEqual(hit.isTP, true);
});

t("estimateRoundTripFee: taker vs maker entry", () => {
  const taker = estimateRoundTripFee(100, 110, 2, { feeRate: 0.001 });
  // entry 100*2*0.001 + exit 110*2*0.001 = 0.2 + 0.22 = 0.42
  assert.ok(Math.abs(taker - 0.42) < 1e-9);

  const maker = estimateRoundTripFee(100, 110, 2, {
    feeRate: 0.001,
    entryMode: "maker",
    makerFeeRate: 0.0002,
  });
  // entry 100*2*0.0002 + exit 110*2*0.001 = 0.04 + 0.22 = 0.26
  assert.ok(Math.abs(maker - 0.26) < 1e-9);
});

t("filterOrphanTradesForEngine: leader vs member ownership", () => {
  const rows = [
    { id: 1, indicators: JSON.stringify({ strategy: "AF_SMC" }) },
    { id: 2, indicators: null },
    { id: 3, indicators: JSON.stringify({ strategy: "TS_TF" }) },
  ];
  const leader = filterOrphanTradesForEngine(rows, {
    groupKey: "g1", strategyKey: "AF_SMC", isGroupLeader: true,
  });
  assert.deepStrictEqual(leader.map((r) => r.id), [1, 2]);

  const member = filterOrphanTradesForEngine(rows, {
    groupKey: "g1", strategyKey: "TS_TF", isGroupLeader: false,
  });
  assert.deepStrictEqual(member.map((r) => r.id), [3]);

  const noGroup = filterOrphanTradesForEngine(rows, { strategyKey: "AF_SMC" });
  assert.strictEqual(noGroup.length, 3);
});

t("positionFromDbTrade maps fields + R from ATR", () => {
  const pos = positionFromDbTrade({
    id: 9,
    order_id: "oid-1",
    side: "LONG",
    entry_price: 100,
    sl: 95,
    tp: 110,
    size: 2,
    open_time: "2026-07-01T00:00:00.000Z",
    atr: 2,
    session_id: 44,
  }, null, { atrMultiplier: 1.5 });
  assert.strictEqual(pos.id, "oid-1");
  assert.strictEqual(pos.dbId, 9);
  assert.strictEqual(pos.R, 3);
  assert.strictEqual(pos.remainingSize, 2);
});

t("checkEntryRiskGates: cooldown / consec / daily loss", () => {
  const base = {
    state: {
      cooldownUntil: null,
      consecLoss: 0,
      dailyTradeCount: 0,
      dailyLoss: 0,
      dailyStartCapital: 1000,
      capital: 1000,
      openPositions: [],
    },
    config: {
      maxConsecLoss: 3,
      maxTradesPerDay: 10,
      maxDailyLossPct: 0.03,
    },
    now: 1_000_000,
  };

  assert.strictEqual(checkEntryRiskGates(base).ok, true);

  const cooled = {
    ...base,
    state: { ...base.state, cooldownUntil: 1_000_000 + 120_000 },
  };
  assert.strictEqual(checkEntryRiskGates(cooled).ok, false);

  const consec = {
    ...base,
    state: { ...base.state, consecLoss: 3 },
  };
  assert.strictEqual(checkEntryRiskGates(consec).ok, false);

  const loss = {
    ...base,
    state: {
      ...base.state,
      dailyLoss: 20,
      openPositions: [{ unrealizedPL: -15 }],
    },
  };
  // 35/1000 = 3.5% > 3%
  assert.strictEqual(checkEntryRiskGates(loss).ok, false);
});

t("checkAtrRangeGate: quiet / extreme / ok", () => {
  const cfg = { atrMinMult: 0.3, atrMaxMult: 3.0 };
  assert.strictEqual(checkAtrRangeGate(1, 100, cfg).ok, true);
  const quiet = checkAtrRangeGate(0.1, 100, cfg);
  assert.strictEqual(quiet.ok, false);
  assert.ok(/ATR terlalu kecil/.test(quiet.reason));
  const wild = checkAtrRangeGate(5, 100, cfg);
  assert.strictEqual(wild.ok, false);
  assert.ok(/ATR terlalu besar/.test(wild.reason));
});

console.log(`\n── ${pass} passed, ${fail} failed ──\n`);
if (fail > 0) {
  for (const f of failures) console.error(`FAIL: ${f.name}: ${f.message}`);
  process.exit(1);
}
