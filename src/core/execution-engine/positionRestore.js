/**
 * DB → runtime position restore helpers (reconcile path).
 * Pure mapping / filtering — no DB or exchange I/O.
 */

/**
 * Multi-strategy group: keep only orphans belonging to this engine.
 * Leader owns trades with missing strategy tag; members match strategyKey.
 *
 * @param {Array<{ indicators?: string|null }>} orphans
 * @param {{ groupKey?: string, strategyKey?: string, isGroupLeader?: boolean }} cfg
 */
function filterOrphanTradesForEngine(orphans, cfg = {}) {
  if (!cfg.groupKey || !cfg.strategyKey) return orphans;
  return orphans.filter((row) => {
    let stratOfTrade = null;
    try { stratOfTrade = row.indicators ? JSON.parse(row.indicators)?.strategy : null; } catch { /* ignore */ }
    if (stratOfTrade === null) return !!cfg.isGroupLeader;
    return stratOfTrade === cfg.strategyKey;
  });
}

/**
 * Build an in-memory open-position object from a DB open trade row.
 *
 * @param {object} dbTrade
 * @param {object|null} [livePos]
 * @param {{ atrMultiplier?: number }} [opts]
 */
function positionFromDbTrade(dbTrade, livePos = null, opts = {}) {
  const size = dbTrade.size || 0;
  const markPrice = livePos?.markPrice || dbTrade.entry_price;
  const upnlFromExchange = livePos?.unrealizedPL ?? 0;
  const upnlCalc = markPrice > 0 && dbTrade.entry_price > 0
    ? (dbTrade.side === "LONG"
      ? (markPrice - dbTrade.entry_price) * size
      : (dbTrade.entry_price - markPrice) * size)
    : 0;
  const atrMultiplier = opts.atrMultiplier || 1;
  return {
    id:            dbTrade.order_id || `restored_${dbTrade.id}`,
    dbId:          dbTrade.id,
    side:          dbTrade.side,
    entry:         dbTrade.entry_price,
    sl:            dbTrade.sl,
    tp:            dbTrade.tp,
    size,
    remainingSize: size,
    openTime:      new Date(dbTrade.open_time).getTime(),
    atr:           dbTrade.atr,
    manualSLTP:    false,
    unrealizedPL:  livePos ? (upnlFromExchange !== 0 ? upnlFromExchange : upnlCalc) : undefined,
    markPrice:     livePos ? markPrice : undefined,
    restoredFrom:  dbTrade.session_id,
    R:             dbTrade.atr ? dbTrade.atr * atrMultiplier : 0,
    slCurrent:     dbTrade.sl,
    m1: false, m2: false, m3: false,
  };
}

module.exports = { filterOrphanTradesForEngine, positionFromDbTrade };
