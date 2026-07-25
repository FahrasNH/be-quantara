"use strict";

/**
 * Flatten open trades for a symbol (dry-run + live best-effort).
 * Used when forceClose=true on stop, or to clear orphan positions on delisted symbols.
 */

const db = require("../../../infrastructure/db/database");

function calcPnl(side, entry, exit, size) {
  const s = Number(size) || 0;
  const e = Number(entry) || 0;
  const x = Number(exit) || e;
  if (!(s > 0) || !(e > 0)) return { pnl: 0, pnlPct: 0 };
  const pnl = String(side).toUpperCase() === "LONG" ? (x - e) * s : (e - x) * s;
  const notional = e * s;
  const pnlPct = notional > 0 ? (pnl / notional) * 100 : 0;
  return { pnl, pnlPct };
}

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.symbol
 * @param {object|null} opts.instance - running BotEngine / MultiStrategyCoordinator
 * @param {number|null} opts.markPrice
 * @returns {Promise<{ closed: number, failed: number, reasons: string[] }>}
 */
async function forceCloseOpenTrades({ userId, symbol, instance = null, markPrice = null }) {
  const reasons = [];
  let closed = 0;
  let failed = 0;

  // 1) Prefer in-memory engine closes (live exchange + dry-run capital accounting).
  if (instance && typeof instance.getState === "function") {
    let engines = [];
    if (instance.engines instanceof Map) {
      engines = [...instance.engines.values()];
    } else if (typeof instance.getEngines === "function") {
      engines = instance.getEngines();
    } else if (typeof instance._closePosition === "function") {
      engines = [instance];
    }

    for (const eng of engines) {
      if (!eng || typeof eng._closePosition !== "function") continue;
      const st = eng.getState?.() || {};
      const opens = [...(st.openPositions || [])];
      for (const _pos of opens) {
        try {
          await eng._closePosition("FORCE_CLOSE", markPrice);
          closed += 1;
        } catch (err) {
          failed += 1;
          reasons.push(err.message || String(err));
        }
      }
    }
  }

  // 2) DB orphans (bot stopped — no in-memory positions).
  const orphans = await db.getOpenTradesBySymbol(symbol, userId);
  for (const t of orphans) {
    try {
      const entry = Number(t.entry_price);
      const size = Number(t.size);
      const exit = Number.isFinite(markPrice) && markPrice > 0
        ? markPrice
        : (Number.isFinite(entry) ? entry : 0);
      const { pnl, pnlPct } = calcPnl(t.side, entry, exit, size);
      await db.closeTrade(t.id, {
        exitPrice: exit,
        pnl,
        pnlPct,
        fee: 0,
        reason: "FORCE_CLOSE",
        closeTime: new Date().toISOString(),
        exitContext: {
          forced: true,
          legacySymbol: true,
          note: "Closed while bot stopped / symbol outside allowlist",
        },
      });
      closed += 1;
    } catch (err) {
      failed += 1;
      reasons.push(err.message || String(err));
    }
  }

  return { closed, failed, reasons };
}

module.exports = {
  forceCloseOpenTrades,
  calcPnl,
};
