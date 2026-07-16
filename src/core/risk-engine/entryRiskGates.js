/**
 * Pre-entry risk gates extracted from BotEngine (pure portion).
 *
 * Covers per-bot gates only (cooldown / consec / daily count / daily+floating loss).
 * Account coordinator + ATR range stay ordered in BotEngine (coordinator before ATR).
 */

/**
 * Rolling ATR baseline (SMA) — shared by backtest atrGateRelative + live validateEntry.
 * @param {Array<number|null|undefined>} atrArr
 * @param {number} [window=100]
 * @returns {Array<number|null>|null}
 */
function buildAtrBaseline(atrArr, window = 100) {
  if (!Array.isArray(atrArr) || !atrArr.length) return null;
  const out = new Array(atrArr.length).fill(null);
  const q = [];
  let sum = 0;
  for (let k = 0; k < atrArr.length; k++) {
    const v = atrArr[k];
    if (v != null && Number.isFinite(v)) {
      q.push(v);
      sum += v;
      if (q.length > window) sum -= q.shift();
    }
    out[k] = q.length ? sum / q.length : null;
  }
  return out;
}

/**
 * Unified ATR entry gate — absolute % floor OR relative-to-baseline ratio.
 * Used by checkAtrRangeGate (live risk) and strategy validateEntry (parity).
 *
 * @returns {{ ok: boolean, valid: boolean, reason?: string, mode?: string }}
 */
function evaluateAtrEntryGate({
  atr,
  price,
  atrBaseline = null,
  atrMinMult = 0.8,
  atrMaxMult = 5.0,
  atrGateRelative = false,
  atrRelMin = 0.4,
  atrRelMax = 4.0,
} = {}) {
  if (!(atr && price) || !Number.isFinite(atr) || !Number.isFinite(price) || price <= 0) {
    return { ok: true, valid: true, mode: "skip" };
  }

  const useRelative = atrGateRelative === true
    && atrBaseline != null
    && Number.isFinite(atrBaseline)
    && atrBaseline > 0;

  if (useRelative) {
    const rel = atr / atrBaseline;
    if (rel < atrRelMin || rel > atrRelMax) {
      return {
        ok: false,
        valid: false,
        mode: "relative",
        reason: `ATR ratio ${rel.toFixed(2)} outside (${atrRelMin}–${atrRelMax})`,
      };
    }
    return { ok: true, valid: true, mode: "relative" };
  }

  const atrPct = (atr / price) * 100;
  const minPct = atrMinMult ?? 0.8;
  const maxPct = atrMaxMult ?? 5.0;
  if (atrPct < minPct) {
    return {
      ok: false,
      valid: false,
      mode: "absolute",
      reason: `ATR terlalu kecil (${atrPct.toFixed(3)}%) — market terlalu sepi`,
    };
  }
  if (atrPct > maxPct) {
    return {
      ok: false,
      valid: false,
      mode: "absolute",
      reason: `ATR terlalu besar (${atrPct.toFixed(3)}%) — volatilitas ekstrem`,
    };
  }
  return { ok: true, valid: true, mode: "absolute" };
}

/**
 * Resolve per-leg ATR overrides from interval / component (live parity with TYPE_TF).
 */
function resolveAtrLegOverride(config = {}, legName = null) {
  const ov = config.typeOverrides || {};
  if (legName && ov[legName]) return ov[legName];
  const iv = config.interval || config.entryTf || config.entryTimeframe;
  if (iv === "5m") return ov.Scalping || {};
  if (iv === "15m") return ov.Intraday || {};
  if (iv === "4h") return ov.Swing || {};
  return {};
}

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
 * ATR range filter — absolute % or relative-to-baseline when atrGateRelative.
 *
 * @param {number|null|undefined} atr
 * @param {number|null|undefined} price
 * @param {{
 *   atrMinMult?: number,
 *   atrMaxMult?: number,
 *   atrGateRelative?: boolean,
 *   atrRelMin?: number,
 *   atrRelMax?: number,
 *   atrBaseline?: number|null,
 *   _atrBaseline?: number|null,
 * }} config
 */
function checkAtrRangeGate(atr, price, config = {}) {
  const gate = evaluateAtrEntryGate({
    atr,
    price,
    atrBaseline: config.atrBaseline ?? config._atrBaseline ?? null,
    atrMinMult: config.atrMinMult,
    atrMaxMult: config.atrMaxMult,
    atrGateRelative: config.atrGateRelative === true,
    atrRelMin: config.atrRelMin ?? 0.4,
    atrRelMax: config.atrRelMax ?? 4.0,
  });
  if (!gate.ok) return { ok: false, reason: gate.reason };
  return { ok: true };
}

module.exports = {
  checkEntryRiskGates,
  checkAtrRangeGate,
  evaluateAtrEntryGate,
  buildAtrBaseline,
  resolveAtrLegOverride,
};
