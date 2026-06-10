/**
 * trade-export.test.js — Unit tests untuk transformasi export trade.
 *
 * Menguji fungsi murni mapExportRow + formatDuration (tanpa DB) yang menangani
 * BUG-001 (strategi), BUG-002 (pnl%), BUG-003 (zero-fill/cancelled), BUG-006
 * (label Inggris), BUG-008 ('N/A' untuk open), dan FEAT-001 (Duration / R:R).
 */

const { describe, test, expect, run } = require("./helpers/jest-lite");

// Pool dibuat lazy; tidak ada koneksi sampai query dijalankan, jadi import aman.
const db = require("../src/infrastructure/db/database");

const baseRow = (over = {}) => ({
  id: 1, session_id: 5, symbol: "ETHUSDT", side: "LONG",
  entry_price: 2000, exit_price: 2100, sl: 1960, tp: 2080,
  size: 1, pnl: 100, pnl_pct: 5, fee: 2, funding: 0,
  reason: "TP", dry_run: 1, mode: "dry_run", session_exchange: "bitget",
  strategy_name: "TREND_MOMENTUM", status: "closed", is_partial: 0,
  open_time: "2026-06-10T10:00:00.000Z",
  close_time: "2026-06-10T11:42:00.000Z",
  indicators: null,
  ...over,
});

describe("formatDuration", () => {
  test("jam + menit", () => expect(db.formatDuration(102 * 60 * 1000)).toBe("1h 42m"));
  test("menit saja", () => expect(db.formatDuration(3 * 60 * 1000)).toBe("3m"));
  test("detik saja", () => expect(db.formatDuration(45 * 1000)).toBe("45s"));
  test("null → N/A", () => expect(db.formatDuration(null)).toBe("N/A"));
  test("negatif → N/A", () => expect(db.formatDuration(-5)).toBe("N/A"));
});

describe("mapExportRow — BUG-001 strategi", () => {
  test("pakai kolom strategy_name", () => {
    expect(db.mapExportRow(baseRow()).strategy).toBe("TREND_MOMENTUM");
  });
  test("fallback ke indicators.strategy", () => {
    const r = db.mapExportRow(baseRow({ strategy_name: null, indicators: JSON.stringify({ strategy: "MEAN_REVERSION" }) }));
    expect(r.strategy).toBe("MEAN_REVERSION");
  });
  test("fallback ke firedByStrategy", () => {
    const r = db.mapExportRow(baseRow({ strategy_name: null, indicators: JSON.stringify({ firedByStrategy: "BREAKOUT_RETEST" }) }));
    expect(r.strategy).toBe("BREAKOUT_RETEST");
  });
  test("tak ada data → Untracked (BUG-006, bukan 'belum tercatat')", () => {
    const r = db.mapExportRow(baseRow({ strategy_name: null, indicators: null }));
    expect(r.strategy).toBe("Untracked");
  });
});

describe("mapExportRow — BUG-003 zero-fill", () => {
  test("status cancelled → result 'cancelled', label 'Cancelled'", () => {
    const r = db.mapExportRow(baseRow({ status: "cancelled", exit_price: 2000, pnl: 0 }));
    expect(r.result).toBe("cancelled");
    expect(r.status).toBe("Cancelled");
  });
  test("win normal", () => {
    expect(db.mapExportRow(baseRow()).result).toBe("win");
  });
  test("loss normal", () => {
    expect(db.mapExportRow(baseRow({ pnl: -50, exit_price: 1950 })).result).toBe("loss");
  });
});

describe("mapExportRow — BUG-008 open trade → N/A", () => {
  const r = db.mapExportRow(baseRow({ close_time: null, exit_price: null, pnl: null, reason: null }));
  test("status Open", () => expect(r.status).toBe("Open"));
  test("exit N/A", () => expect(r.exitPrice).toBe("N/A"));
  test("pnl N/A", () => expect(r.pnl).toBe("N/A"));
  test("pnlNet N/A", () => expect(r.pnlNet).toBe("N/A"));
  test("closeTime N/A", () => expect(r.closeTime).toBe("N/A"));
  test("reason N/A", () => expect(r.reason).toBe("N/A"));
  test("duration N/A", () => expect(r.duration).toBe("N/A"));
  test("actualRR N/A", () => expect(r.actualRR).toBe("N/A"));
});

describe("mapExportRow — FEAT-001 R:R & duration", () => {
  const r = db.mapExportRow(baseRow());
  test("planned RR = |2080-2000|/|2000-1960| = 2", () => expect(r.plannedRR).toBe(2));
  test("duration 1h 42m", () => expect(r.duration).toBe("1h 42m"));
  test("actual RR = pnlNet(98)/risk(40) = 2.45", () => {
    // plannedRisk = |2000-1960| * 1 = 40; pnlNet = 100 - 2 = 98 → 2.45
    expect(r.actualRR).toBe(2.45);
  });
  test("pnlNet = 98 (gross 100 - fee 2)", () => expect(r.pnlNet).toBe(98));
});

run();
