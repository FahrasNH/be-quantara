/**
 * Pre-entry risk gates extracted from BotEngine (pure portion).
 *
 * Covers per-bot gates only (cooldown / consec / daily count / daily+floating loss).
 * Account coordinator + ATR range stay ordered in BotEngine (coordinator before ATR).
 */

/**
 * @param {{
 *   state: {
 *     cooldownUntil?: number|null,
 *     consecLoss?: number,
 *     dailyTradeCount?: number,
 *     dailyLoss?: number,
 *     dailyStartCapital?: number,
 *     capital?: number,
 *     openPositions?: Array<{ unrealizedPL?: number }>,
 *   },
 *   config: {
 *     maxConsecLoss?: number,
 *     maxTradesPerDay?: number,
 *     maxDailyLossPct?: number,
 *   },
 *   now?: number,
 * }} ctx
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function checkEntryRiskGates(ctx) {
  const state = ctx.state || {};
  const config = ctx.config || {};
  const now = ctx.now != null ? ctx.now : Date.now();

  // 1. Cooldown setelah loss
  if (state.cooldownUntil && now < state.cooldownUntil) {
    const remaining = Math.ceil((state.cooldownUntil - now) / 60000);
    return { ok: false, reason: `Cooldown aktif — tunggu ${remaining} menit lagi` };
  }

  // 2. Loss berturut-turut
  if (state.consecLoss >= config.maxConsecLoss) {
    return { ok: false, reason: `${state.consecLoss} loss berturut — stop trading hari ini` };
  }

  // 3. Max trades per hari
  if (state.dailyTradeCount >= config.maxTradesPerDay) {
    return { ok: false, reason: `Maks ${config.maxTradesPerDay} trade/hari sudah tercapai` };
  }

  // 4. Daily loss limit — include FLOATING loss on open positions
  const floatingLoss = (state.openPositions || []).reduce((s, p) => {
    const u = p.unrealizedPL || 0;
    return u < 0 ? s + Math.abs(u) : s;
  }, 0);
  const effectiveDailyLoss = (state.dailyLoss || 0) + floatingLoss;
  const dailyBase = state.dailyStartCapital || state.capital;
  const dailyLossPct = dailyBase > 0 ? effectiveDailyLoss / dailyBase : 0;
  if (dailyLossPct >= config.maxDailyLossPct) {
    return {
      ok: false,
      reason: `Daily loss ${(dailyLossPct * 100).toFixed(2)}% (incl floating) melewati batas ${(config.maxDailyLossPct * 100)}%`,
    };
  }

  return { ok: true };
}

/**
 * ATR range filter (% of price). Kept separate so BotEngine can run it
 * AFTER the account-level coordinator gate (original order).
 *
 * @param {number|null|undefined} atr
 * @param {number|null|undefined} price
 * @param {{ atrMinMult?: number, atrMaxMult?: number }} config
 */
function checkAtrRangeGate(atr, price, config = {}) {
  if (!(atr && price)) return { ok: true };
  const atrPct = (atr / price) * 100;
  const minPct = config.atrMinMult;
  const maxPct = config.atrMaxMult;
  if (atrPct < minPct) {
    return { ok: false, reason: `ATR terlalu kecil (${atrPct.toFixed(3)}%) — market terlalu sepi` };
  }
  if (atrPct > maxPct) {
    return { ok: false, reason: `ATR terlalu besar (${atrPct.toFixed(3)}%) — volatilitas ekstrem` };
  }
  return { ok: true };
}

module.exports = { checkEntryRiskGates, checkAtrRangeGate };
