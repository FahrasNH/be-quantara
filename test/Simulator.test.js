/**
 * Simulator.test.js — Verifies the shared backtest trade simulator.
 *
 * Locks in the manual-example verification:
 *   LONG  entry=100, SL=95,  TP=110  → SL exit @95 (-5),  TP exit @110 (+10)
 *   SHORT entry=100, SL=105, TP=90   → SL exit @105 (-5), TP exit @90  (+10)
 * plus edge cases (same-bar SL+TP, timeout, gap-through, wick-only touch).
 */

const { describe, it, test, expect, beforeEach, afterEach, run } = require("./helpers/jest-lite");
const { simulateTrade } = require("../scripts/lib/simulator");

// candle helper
const C = (open, high, low, close) => ({ open, high, low, close, volume: 1 });

describe("simulateTrade", () => {
  // ── Manual examples (the spec) ────────────────────────────────────────────
  describe("manual examples — LONG entry=100, SL=95, TP=110", () => {
    const cfg = { stopLoss: 95, takeProfit: 110 };

    test("hits SL → exit 95, pnl -5", () => {
      const candles = [C(100, 101, 100, 100), C(100, 100, 94, 96)];
      const r = simulateTrade(candles, 0, "LONG", cfg);
      expect(r.exit).toBe(95);
      expect(r.pnl).toBe(-5);
      expect(r.reason).toBe("SL");
    });

    test("hits TP → exit 110, pnl +10", () => {
      const candles = [C(100, 101, 100, 100), C(100, 111, 100, 108)];
      const r = simulateTrade(candles, 0, "LONG", cfg);
      expect(r.exit).toBe(110);
      expect(r.pnl).toBe(10);
      expect(r.reason).toBe("TP");
    });
  });

  describe("manual examples — SHORT entry=100, SL=105, TP=90", () => {
    const cfg = { stopLoss: 105, takeProfit: 90 };

    test("hits SL → exit 105, pnl -5", () => {
      const candles = [C(100, 100, 99, 100), C(100, 106, 100, 103)];
      const r = simulateTrade(candles, 0, "SHORT", cfg);
      expect(r.exit).toBe(105);
      expect(r.pnl).toBe(-5);
      expect(r.reason).toBe("SL");
    });

    test("hits TP → exit 90, pnl +10", () => {
      const candles = [C(100, 100, 99, 100), C(100, 100, 89, 92)];
      const r = simulateTrade(candles, 0, "SHORT", cfg);
      expect(r.exit).toBe(90);
      expect(r.pnl).toBe(10);
      expect(r.reason).toBe("TP");
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────
  describe("edge cases", () => {
    test("LONG: bar spanning BOTH SL & TP resolves to SL (conservative)", () => {
      const candles = [C(100, 101, 100, 100), C(100, 111, 94, 100)];
      const r = simulateTrade(candles, 0, "LONG", { stopLoss: 95, takeProfit: 110 });
      expect(r.reason).toBe("SL");
      expect(r.exit).toBe(95);
    });

    test("SHORT: bar spanning BOTH SL & TP resolves to SL (conservative)", () => {
      const candles = [C(100, 100, 99, 100), C(100, 106, 89, 100)];
      const r = simulateTrade(candles, 0, "SHORT", { stopLoss: 105, takeProfit: 90 });
      expect(r.reason).toBe("SL");
      expect(r.exit).toBe(105);
    });

    test("no touch → Timeout exit at last close with correct sign (LONG win)", () => {
      const candles = [C(100, 101, 100, 100), C(101, 103, 100, 102), C(102, 105, 101, 104)];
      const r = simulateTrade(candles, 0, "LONG", { stopLoss: 95, takeProfit: 110 });
      expect(r.reason).toBe("Timeout");
      expect(r.exit).toBe(104);
      expect(r.pnl).toBe(4);
    });

    test("Timeout exit with correct sign (SHORT loss)", () => {
      const candles = [C(100, 100, 99, 100), C(101, 103, 100, 102), C(102, 104, 101, 103)];
      const r = simulateTrade(candles, 0, "SHORT", { stopLoss: 105, takeProfit: 90 });
      expect(r.reason).toBe("Timeout");
      expect(r.exit).toBe(103);
      expect(r.pnl).toBe(-3);   // entry(100) - exit(103)
    });

    test("gap-through SL still fills at SL level (not the gapped low)", () => {
      // bar gaps far below SL; simulator fills at SL=95, not at low=80
      const candles = [C(100, 101, 100, 100), C(90, 92, 80, 85)];
      const r = simulateTrade(candles, 0, "LONG", { stopLoss: 95, takeProfit: 110 });
      expect(r.exit).toBe(95);
      expect(r.pnl).toBe(-5);
      expect(r.reason).toBe("SL");
    });

    test("entry bar itself is not evaluated (exit search starts next bar)", () => {
      // entry bar has a huge range but must be ignored; exit only on bar 1
      const candles = [C(100, 200, 50, 100), C(100, 111, 100, 108)];
      const r = simulateTrade(candles, 0, "LONG", { stopLoss: 95, takeProfit: 110 });
      expect(r.exitBar).toBe(1);
      expect(r.reason).toBe("TP");
    });
  });
});

run();
