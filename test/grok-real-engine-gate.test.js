/**
 * grok-real-engine-gate.test.js — GROK-FIX
 * Verifies the post-hoc Grok Confirm Gate over the AF real (triple-TF) engine:
 *   - rejected entries are dropped
 *   - stats are recomputed over survivors (pure fn parity)
 *   - fail-open: a throwing confirm fn keeps every trade
 *   - no-decision entries are kept (fail-open per-signal)
 */
"use strict";

const assert = require("assert");
const {
  _computeTripleStats,
  _applyGrokGate,
} = require("../src/server/services/RealStrategyBacktestService");

function trade(i, pnl, side = "LONG") {
  return {
    openTime: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
    closeTime: new Date(Date.UTC(2026, 0, 1, i + 1)).toISOString(),
    date: new Date(Date.UTC(2026, 0, 1, i + 1)).toISOString(),
    side,
    entry: 100 + i,
    exit: 100 + i + pnl,
    sl: 100 + i - 5,
    tp: 100 + i + 10,
    atr: 2,
    entryRsi: 55,
    htfTrend: "BULLISH",
    size: 1,
    fee: 0.1,
    pnl,
    confidence: 70,
    result: pnl > 0 ? "win" : "loss",
    tradeType: "Intraday",
    component: "Intraday",
  };
}

(async () => {
  // 5 trades: 3 winners (+10) and 2 losers (-5)
  const trades = [trade(0, 10), trade(1, -5), trade(2, 10), trade(3, -5), trade(4, 10)];

  // ── 1. Reject the two losers → survivors are all winners ──────────────────
  {
    const confirmFn = async (signals) => {
      const decisions = {};
      // Reject indices 1 and 3 (the losers)
      signals.forEach((s) => {
        const approved = s.id !== 1 && s.id !== 3;
        decisions[String(s.id)] = { approved, confidence: 80, reason: approved ? "ok" : "weak" };
      });
      return { decisions, stats: { total: signals.length } };
    };

    const res = await _applyGrokGate(trades, { strategyKey: "AF_SMC", grokConfirmFn: confirmFn });
    assert.strictEqual(res.trades.length, 3, "keeps 3 approved trades");
    assert.strictEqual(res.rejected, 2, "rejects 2");
    assert.strictEqual(res.stats.approved, 3);
    assert.strictEqual(res.logs.length, 5, "logs every entry (approved+rejected)");

    // Stats recomputed over survivors: 3 wins, 0 losses → WR 100%, PF Inf
    const { stats } = _computeTripleStats(res.trades, 1000);
    assert.strictEqual(stats.wins, 3);
    assert.strictEqual(stats.losses, 0);
    assert.strictEqual(stats.winRate, "100.0");
    assert.strictEqual(stats.profitFactor, "Inf", "no losses → PF Inf");
  }

  // ── 2. Fail-open: confirm fn throws → all trades kept ─────────────────────
  {
    const boom = async () => { throw new Error("xAI 503"); };
    const res = await _applyGrokGate(trades, { strategyKey: "AF_SMC", grokConfirmFn: boom });
    assert.strictEqual(res.trades.length, 5, "fail-open keeps all trades");
    assert.strictEqual(res.stats.failOpen, true);
    assert.ok(res.logs[0].error, "surfaces the failure as a log entry");
  }

  // ── 3. No decision for a signal → kept (per-signal fail-open) ─────────────
  {
    const partial = async (signals) => {
      const decisions = {};
      // Only decide index 0 (reject); others get no decision → kept
      decisions["0"] = { approved: false, reason: "weak" };
      return { decisions };
    };
    const res = await _applyGrokGate(trades, { strategyKey: "AF_SMC", grokConfirmFn: partial });
    assert.strictEqual(res.trades.length, 4, "only the explicitly-rejected entry dropped");
    assert.strictEqual(res.rejected, 1);
  }

  // ── 4. _computeTripleStats parity with full set ───────────────────────────
  {
    const { stats } = _computeTripleStats(trades, 1000);
    assert.strictEqual(stats.totalTrades, 5);
    assert.strictEqual(stats.wins, 3);
    assert.strictEqual(stats.losses, 2);
    // net = 3*10 - 2*5 = 20 → finalCapital 1020
    assert.strictEqual(stats.finalCapital, "1020.00");
    // grossWin 30 / grossLoss 10 = 3.00
    assert.strictEqual(stats.profitFactor, "3.00");
  }

  console.log("✓ grok-real-engine-gate tests passed");
})().catch((err) => {
  console.error("✗ grok-real-engine-gate FAILED:", err);
  process.exit(1);
});
