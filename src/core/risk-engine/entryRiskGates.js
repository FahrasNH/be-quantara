/**
 * Pre-entry risk gates extracted from BotEngine (pure portion).
 *
 * Covers per-bot gates only (cooldown / consec / daily count / daily+floating loss).
 * Account coordinator + ATR range stay ordered in BotEngine (coordinator before ATR).
 */

/** UTC hour ranges (inclusive) per market session — SSOT for session gates. */
const SESSION_HOUR_RANGES = Object.freeze({
  Sydney: [[21, 23], [0, 6]], // 04:00–13:00 WIB
  Tokyo: [[23, 23], [0, 8]], // 06:00–15:00 WIB (23 wraps midnight)
  London: [[8, 16]], // 15:00–23:00 WIB
  "New York": [[13, 21]], // 20:00–04:00 WIB
});

/**
 * Detect primary market session from UTC hour (0–23).
 * Overlaps match BacktestCsvService.detectMarketSession priority.
 * @param {number|null|undefined} hourUtc
 * @returns {string|null}
 */
function detectMarketSession(hourUtc) {
  if (hourUtc == null || !Number.isFinite(Number(hourUtc))) return null;
  const h = Number(hourUtc);
  if ((h >= 21 && h <= 23) || (h >= 0 && h <= 6)) return "Sydney";
  if (h >= 0 && h <= 8) return "Tokyo";
  if (h >= 8 && h <= 16) return "London";
  if (h >= 13 && h <= 21) return "New York";
  return null;
}

/**
 * Whether a UTC hour falls inside a named session window.
 * @param {number|null|undefined} hourUtc
 * @param {string} sessionName
 * @returns {boolean}
 */
function hourInMarketSession(hourUtc, sessionName) {
  if (hourUtc == null || !Number.isFinite(Number(hourUtc))) return false;
  const h = Number(hourUtc);
  const ranges = SESSION_HOUR_RANGES[sessionName];
  if (!ranges) return false;
  return ranges.some(([lo, hi]) => h >= lo && h <= hi);
}

/**
 * UTC hour from epoch ms / ISO / Date. Fail-open → null.
 * @param {number|Date|string|null|undefined} timestamp
 * @returns {number|null}
 */
function hourUtcFromTimestamp(timestamp) {
  if (timestamp == null || timestamp === "") return null;
  const ms = typeof timestamp === "number"
    ? timestamp
    : Date.parse(timestamp instanceof Date ? timestamp.toISOString() : String(timestamp));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).getUTCHours();
}

/**
 * Generic session filter — block entries during named sessions or legacy UTC hours.
 * SSOT loop used by per-strategy applyXxxSessionFilter wrappers in entry modules.
 *
 * @returns {{ blocked: boolean, hourUtc: number|null, reason: string|null }}
 */
function applyNoTradeSessionFilter(timestamp, opts = {}) {
  const enabled = opts.enabled === true;
  const hourUtc = hourUtcFromTimestamp(timestamp);
  if (!enabled) {
    return { blocked: false, hourUtc, reason: null };
  }
  if (hourUtc == null) {
    return { blocked: false, hourUtc: null, reason: "no_timestamp_fail_open" };
  }

  const noTradeSessions = opts.noTradeSessions;
  if (Array.isArray(noTradeSessions) && noTradeSessions.length) {
    for (const sess of noTradeSessions) {
      if (hourInMarketSession(hourUtc, sess)) {
        return { blocked: true, hourUtc, reason: `session_block_${String(sess).toLowerCase()}` };
      }
    }
    return { blocked: false, hourUtc, reason: null };
  }

  const blockHours = Array.isArray(opts.blockHoursUtc) && opts.blockHoursUtc.length
    ? opts.blockHoursUtc
    : [21, 22];
  if (blockHours.includes(hourUtc)) {
    return { blocked: true, hourUtc, reason: `session_block_utc_${hourUtc}` };
  }
  return { blocked: false, hourUtc, reason: null };
}

/**
 * Scalping-only session block helper for strategy entry modules (Sprint 23).
 * Each strategy passes its own filterKey + applyXxxSessionFilter wrapper.
 */
function scalpingSessionBlocked(config, indicators, lastIdx, filterKey, applyFilter, ablation) {
  const tradeTier = config?.tradeType;
  if (tradeTier !== "Scalping") return false;
  const ov = config.typeOverrides?.Scalping || {};
  const enabled = config[filterKey] ?? ov[filterKey] ?? false;
  if (enabled !== true) return false;
  const noTradeSessions = config.noTradeSessions ?? ov.noTradeSessions ?? null;
  const timestamp = config.candleTimestamp
    ?? indicators?.timestamps?.[lastIdx]
    ?? config?.timestamps?.[lastIdx]
    ?? indicators?.time?.[lastIdx]
    ?? null;
  const r = applyFilter(timestamp, { enabled: true, noTradeSessions });
  if (r.blocked) {
    if (ablation && Object.prototype.hasOwnProperty.call(ablation, "rejBySession")) {
      ablation.rejBySession += 1;
    }
    return true;
  }
  return false;
}

/**
 * Block SMC entries during configured no-trade sessions.
 * Scalping: Sydney/Tokyo (Sprint 13). Intraday: London (Sprint 22 — tier-specific).
 * Fail-open when timestamp missing. Only Scalping/Intraday + SMART_MONEY_CONCEPTS.
 *
 * @returns {{ ok: boolean, reason?: string, hourUtc?: number|null, session?: string|null }}
 */
function checkNoTradeSessionGate({
  timestamp,
  noTradeSessions,
  enabled,
  tradeTier,
  strategyKey,
} = {}) {
  if (enabled !== true) return { ok: true };
  if (tradeTier !== "Scalping" && tradeTier !== "Intraday") return { ok: true };
  const sk = String(strategyKey || "");
  if (!sk.includes("SMART_MONEY_CONCEPTS")) return { ok: true };

  const sessions = Array.isArray(noTradeSessions) ? noTradeSessions : [];
  if (!sessions.length) return { ok: true };

  const hourUtc = hourUtcFromTimestamp(timestamp);
  if (hourUtc == null) return { ok: true, hourUtc: null };

  for (const sess of sessions) {
    if (hourInMarketSession(hourUtc, sess)) {
      return {
        ok: false,
        hourUtc,
        session: sess,
        reason: `Session ${sess} blocked for SMC ${tradeTier} (hour ${hourUtc} UTC)`,
      };
    }
  }
  return { ok: true, hourUtc, session: detectMarketSession(hourUtc) };
}

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
  atrMinMult,
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

  const atrPct = (atr / price) * 100;
  const minPct = atrMinMult ?? 0.8;
  const maxPct = atrMaxMult ?? 5.0;

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
    // Sprint 16: explicit per-leg atrMinMult also enforced as absolute ATR% floor.
    if (atrMinMult !== undefined && atrMinMult > 0 && atrPct < atrMinMult) {
      return {
        ok: false,
        valid: false,
        mode: "relative+absolute",
        reason: `ATR terlalu kecil (${atrPct.toFixed(3)}% < ${atrMinMult}%) — market terlalu sepi`,
      };
    }
    return { ok: true, valid: true, mode: "relative" };
  }

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
  checkNoTradeSessionGate,
  applyNoTradeSessionFilter,
  scalpingSessionBlocked,
  evaluateAtrEntryGate,
  buildAtrBaseline,
  resolveAtrLegOverride,
  detectMarketSession,
  hourInMarketSession,
  hourUtcFromTimestamp,
  SESSION_HOUR_RANGES,
};
