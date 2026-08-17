// ─────────────────────────────────────────────
// src/application/BotEngine.js — Quantara BotEngine
// Class yang bisa di-start/stop oleh server
// Memancarkan event 'log' untuk streaming ke WS
// ─────────────────────────────────────────────

const EventEmitter = require("events");
const { createExchangeClient, getExchangeInfo } = require("../../../infrastructure/exchange/index");
const { fetchCandlesWithCache, LTF_CACHE_TTL, HTF_CACHE_TTL } = require("../../../infrastructure/exchange/candleFetch");
const { isRateLimitError } = require("../../../infrastructure/exchange/exchangeRateGate");
const cfg = require("../../../config/env");
const { calcIndicators, detectSignal, detectHTFTrend, calcPositionSize, detectSidewaysBreakout, getAdaptiveFusionMeta, getBreakoutRetestMeta, getBreakoutRetestInstance, getTrendFollowingInstance, calcEMA, calcRSI, calcATR, calcSMA, calcADX } = require("../../../core/analytics-engine/indicators");
// ── Quantara Patch v1.0 ─────────────────────────────────────────────────────
const { isDuplicate } = require("../../../core/signal-engine/signalIdempotency");
const { meanReversionRegimeFilter } = require("../../../core/signal-engine/htfRegimeFilter");
const { computeDailyTrendStrength, getRegimeForDate } = require("../../../core/signal-engine/dailyRegimeGate");
const { getStrategy } = require("#config/strategyDefaults.js");
const {
  requiresHtfFailClosed,
  shouldBlockHtfDirectional,
} = require("../../../config/htfMode");
const { buildTradeAttribution } = require("../../analytics/domain/tradeAttribution"); // TASK 2.3
const db       = require("../../../infrastructure/db/database");
const { persistBotLog } = require("../../../infrastructure/db/botLogRepository");
const notifier = require("../../../infrastructure/notifications/TelegramNotifier");
const GrokTradingService = require("../../research/services/GrokTradingService");
const GrokConfirmService = require("../../research/services/GrokConfirmService");
const { onEngineTradeOpen, onEngineTradeClose } = require("../../ml/services/BotEngineMlHook");
const MLGateService = require("../../ml/services/MLGateService");
const { assertMlGateProductionSafety } = require("../../ml/guards/mlGateProductionGuard");
const {
  applyGradedScoreToSnapshot,
  resolveGradedSignalConfidence,
} = require("../../../core/strategy-engine/scoring/ComponentScoringEngine");
const {
  enrichEntryContextLive,
  enrichExitContextLive,
  resolveSignalDelayMs,
  indicatorsSnapshotToEntryContext,
  classifyHtfTrend,
} = require("../../analytics/domain/engineTradeMlAdapter");
// Phase 2g — pure execution helpers (core/execution-engine + risk-engine)
const {
  stratLabel,
  fmtHoldingMs,
  fmtPx,
  GROK_CONFIRM_STRATEGIES,
  isMeanReversionKey,
  evaluateSlTpHit,
  estimateRoundTripFee,
  filterOrphanTradesForEngine,
  positionFromDbTrade,
} = require("../../../core/execution-engine");
const {
  buildAtrBaseline,
  checkEntryRiskGates,
  checkAtrRangeGate,
  resolveAtrLegOverride,
} = require("../../../core/risk-engine/entryRiskGates");
const { applyBsBrSnapshotFields } = require("../../../shared/csv/strategyMlEnrichment");
const { normalizeStrategyKey } = require("../../../config/strategyKeyNormalizer");

/** Legacy PDF sideways handlers in _checkSidewaysEntry (Strat A/B/C). */
const LEGACY_PDF_SIDEWAYS_SIGNAL_TYPES = new Set([
  "PDF_SCALPING",
  "PDF_DAYTRADING",
  "PDF_SWING",
]);

/** Non-legacy detectors — skip TF-style EMA+RSI no-entry diagnostics. */
const MODERN_SIGNAL_TYPES = new Set([
  "MEAN_REVERSION",
  "BREAKOUT_RETEST",
  "SMART_MONEY_CONCEPTS",
  "ADAPTIVE_FUSION",
  "TREND_FOLLOWING",
]);

// ── Per-user Telegram chat ID helper ─────────────────────────────────────────
// Lazy-import Prisma (singleton bersama) agar tidak circular dengan db module
let _prisma = null;
function getPrisma() {
  if (!_prisma) { _prisma = require("../../../infrastructure/db/prismaClient"); }
  return _prisma;
}

// Cache per userId (TTL 5 menit) untuk hindari DB hit per-notifikasi
const _telegramChatIdCache = new Map();
const TGCHAT_TTL = 5 * 60 * 1000;
async function getUserTelegramChatId(userId) {
  if (!userId) return null;
  const cached = _telegramChatIdCache.get(userId);
  if (cached && Date.now() - cached.ts < TGCHAT_TTL) return cached.chatId;
  try {
    const user = await getPrisma().user.findUnique({ where: { id: userId }, select: { telegramChatId: true } });
    const chatId = user?.telegramChatId ?? null;
    _telegramChatIdCache.set(userId, { chatId, ts: Date.now() });
    return chatId;
  } catch { return null; }
}

class BotEngine extends EventEmitter {
  /**
   * @param {object} configOverrides  — override nilai default dari .env
   *   Contoh: new BotEngine({ symbol: "ETHUSDT", capital: 200, apiKey: "...", apiSecret: "..." })
   *   apiKey / apiSecret / passphrase dari DB (Settings page) lebih diprioritaskan daripada .env
   */
  constructor(configOverrides = {}) {
    super();
    assertMlGateProductionSafety();
    /** @type {import('../domain/MetaSelectorEngine').MetaSelectorEngine|null} */
    this.metaSelector = null;

    const exchangeType = (configOverrides.exchangeType || "bitget").toLowerCase();
    const ei   = getExchangeInfo(exchangeType);
    // Strategi dari DB (configOverrides.strategyKey/strategy); getStrategy fallback ke SMART_MONEY_CONCEPTS
    const strat = getStrategy(configOverrides.strategyKey || configOverrides.strategy);

    // ── Resolve API credentials: DB key (dari Settings) > env var ──────────────
    // configOverrides.apiKey diisi oleh route start-bot setelah decrypt dari DB.
    const resolvedApiKey     = configOverrides.apiKey     || cfg.BITGET_API_KEY     || "";
    const resolvedApiSecret  = configOverrides.apiSecret  || cfg.BITGET_SECRET_KEY  || "";
    const resolvedPassphrase = configOverrides.passphrase || cfg.BITGET_PASSPHRASE  || "";

    // Hapus dari configOverrides agar tidak bocor ke this.config (keamanan)
    const { apiKey: _k, apiSecret: _s, passphrase: _p, exchangeType: _et, ...safeOverrides } = configOverrides;

    const STRAT_UI_META = new Set(["trades", "winrate", "risk"]);
    const stratKnobs = Object.fromEntries(
      Object.entries(strat).filter(([k]) => !STRAT_UI_META.has(k)),
    );

    // ── Sumber kebenaran config (prioritas: DB > strategy default) ────────────
    // process.env TIDAK digunakan untuk config bot — semua dari strategy atau DB.
    // Satu-satunya env yang masih relevan adalah server-level config (PORT, DATABASE_URL, dll).
    this.config = {
      // ── Exchange (server config, tidak berubah per user) ──────────────────
      exchange:      exchangeType,
      exchangeLabel: ei.label,
      marginCoin:    "USDT",

      // ── Identitas bot (dari DB via configOverrides) ───────────────────────
      // Default aman jika tidak ada override
      symbol:  "BTCUSDT",
      capital: 500,
      dryRun:  true,  // default dry-run; DB override via configOverrides.dryRun

      // ── Indikator teknikal (dari strategy definition) ─────────────────────
      emaFast:       strat.emaFast,
      emaSlow:       strat.emaSlow,
      emaTrend:      strat.emaTrend      || 0,
      rsiPeriod:     strat.rsiPeriod,
      rsiOverbought: strat.rsiOverbought,
      rsiOversold:   strat.rsiOversold,

      // RSI zona entry — batas masuk per strategi (dari PDF)
      rsiLongMin:    strat.rsiLongMin    || 50,
      rsiLongMax:    strat.rsiLongMax    || 70,
      rsiShortMin:   strat.rsiShortMin   || 30,
      rsiShortMax:   strat.rsiShortMax   || 50,

      atrPeriod:     strat.atrPeriod,
      atrMultiplier: strat.atrMultiplier,
      riskReward:    strat.riskReward,
      riskPerTrade:  strat.riskPerTrade,
      riskSizingBasis: strat.riskSizingBasis || "equity",
      typeRiskWeights: strat.typeRiskWeights || null,
      riskPerTradeStrong: strat.riskPerTradeStrong ?? null,
      // v2.3 spec (STRATEGIES.md §9): maxRiskPerTrade default 0.05 → 0.012.
      // Tetap bisa di-override per-strategi via strat.maxRiskPerTrade / DB config.
      maxRiskPerTrade: strat.maxRiskPerTrade ?? 0.012,

      // Fee trading per sisi (taker). Bitget USDT-M futures default ~0.06%.
      // Dipakai untuk estimasi fee dry-run/backtest & fallback live.
      feeRate:       strat.feeRate ?? 0.0006,

      // ── FEE-02: Mode entry (taker | maker) ────────────────────────────────
      // "maker" = limit post-only (fee ~0.02%/sisi vs taker 0.06%). makerFeeRate
      // dipakai untuk accounting saat entryMode=maker. Order-routing post-only
      // sebenarnya di-handle di layer eksekusi; di sini knob + akuntansi fee.
      entryMode:     strat.entryMode   || "taker",
      makerFeeRate:  strat.makerFeeRate ?? 0.0002,

      // ── FEE-03: Fee-aware min-edge gate ───────────────────────────────────
      // Reward leg (jarak ke TP, sbg fraksi harga) WAJIB ≥ minEdgeFeeMultiple ×
      // fee roundtrip (2×feeRate). Mencegah entry yang edge-nya ditelan fee —
      // akar kerugian net (fee 8× lebih besar dari edge per trade). 0 = nonaktif.
      minEdgeFeeMultiple: strat.minEdgeFeeMultiple ?? 5,

      // ── FEE-01/01b: ADAPTIVE_FUSION entry-quality knobs ───────────────────
      // Diteruskan ke AdaptiveFusionStrategy.detectSignal (lewat AdaptiveStrategyEngine)
      // agar anti-chase & conviction-veto bisa di-tune live tanpa ubah kode.
      // - maxEntryExtensionATR: tolak entry bila |close−EMA9|/ATR melebihi ini.
      // - afRejectOnDissent: tolak entry saat komponen saling berlawanan (2-1).
      // - afMinVotes: kuorum minimum komponen searah (2 = default; 3 = unanim).
      maxEntryExtensionATR: strat.maxEntryExtensionATR ?? 1.5,
      afRejectOnDissent:    strat.afRejectOnDissent ?? true,
      // v2.3 spec (STRATEGIES.md §4): afMinVotes default 2 → 3 (konsensus lebih kuat).
      afMinVotes:           strat.afMinVotes ?? 3,

      strongTrendTPMult:    strat.strongTrendTPMult ?? 1,

      // ── Eksekusi & posisi ─────────────────────────────────────────────────
      maxPositions: 1,
      leverage:     strat.leverage,
      useBothSides: false,
      // Delisted / outside allowlist: monitor SL/TP only (set via start overrides).
      legacyMonitorOnly: false,

      // Interval diambil dari strategi; fallback "15m" jika strategi tidak mendefinisikan
      interval:      strat.interval      || "15m",
      checkInterval: strat.checkInterval || 60_000,

      // ── Strategy info ─────────────────────────────────────────────────────
      strategyKey:   strat.name,
      strategyLabel: strat.label,
      signalType:    strat.signalType,

      // ── Grok AI Live Trading ───────────────────────────────────────────────
      minConfidenceEntry: strat.minConfidenceEntry ?? cfg.GROK_TRADING_MIN_CONFIDENCE_ENTRY,
      minConfidenceTpSl:  strat.minConfidenceTpSl  ?? cfg.GROK_TRADING_MIN_CONFIDENCE_TP_SL,
      minRiskReward:      strat.minRiskReward      ?? 1.2,

      // ── Grok Confirm Gate (Mode B) ─────────────────────────────────────────
      grokConfirmEnabled:        false,
      grokConfirmTpAdjust:       true,
      grokConfirmTpBandPct:      cfg.GROK_CONFIRM_TP_ADJUST_BAND_PCT,
      grokConfirmTpRejectAction: cfg.GROK_CONFIRM_TP_REJECT_ACTION,
      grokConfirmMinEntry:       strat.grokConfirmMinEntry ?? cfg.GROK_CONFIRM_MIN_CONFIDENCE_ENTRY,
      grokConfirmMinTp:          strat.grokConfirmMinTp    ?? cfg.GROK_CONFIRM_MIN_TP_CONFIDENCE,

      // ── HTF trend filter ──────────────────────────────────────────────────
      higherTf:             strat.higherTf             || null,
      htfEmaFast:           strat.htfEmaFast            || 9,
      htfEmaSlow:           strat.htfEmaSlow            || 21,
      htfTrendStrengthMin:  strat.htfTrendStrengthMin   ?? null,
      sidewaysThresholdPct: strat.sidewaysThresholdPct  || 0.2,

      // ── ATR filter ────────────────────────────────────────────────────────
      atrMinMult: strat.atrMinMult || 0.1,
      atrMaxMult: strat.atrMaxMult || 5.0,

      // ── Volume filter ─────────────────────────────────────────────────────
      volSmaMultiplier: strat.volSmaMultiplier || 1.0,

      // ── Sideways breakout/retest ──────────────────────────────────────────
      sidewaysRangeLookback:   strat.sidewaysRangeLookback   || 20,
      sidewaysBreakoutVolMult: strat.sidewaysBreakoutVolMult || 1.2,
      sidewaysBreakoutBufMult: strat.sidewaysBreakoutBufMult || 0.3,

      // ── Risk management harian (v2.3 spec — STRATEGIES.md §9: diperketat) ──
      maxDailyLossPct:   strat.maxDailyLossPct  || 0.03,
      maxTradesPerDay:   strat.maxTradesPerDay   || 10,

      // re-entry cepat pada setup identik setelah SL → loss duplikat beruntun.
      // Strategi tetap bisa override via strat.cooldownAfterLoss (MR: 15).
      cooldownAfterLoss: strat.cooldownAfterLoss || 45,
      maxConsecLoss:     strat.maxConsecLoss     || 3,

      // ── Take-Profit mode (FEE-04) ────────────────────────────────────────
      // "full"    → posisi lari ke TP penuh tanpa dipotong (default)
      // "partial" → partial close +1R/+2R + SL geser ke +0.3R/+1R, sisa dibiarkan
      //             lari ke TP penuh (~2.5–2.85R). Membiarkan winner lari sambil
      //             mengunci sebagian profit → ekspektasi net-of-fee membaik di
      //             strategi tren (TREND_FOLLOWING). Knob per-strategi via strat.tpMode.
      tpMode: strat.tpMode || "full",

      // ── SL+ (Trailing Partial Take Profit) — hanya aktif bila tpMode:"partial" ──
      slPlusEnabled:     true,   // legacy; dikontrol oleh tpMode
      slPlusPartial1Pct: strat.slPlusPartial1Pct ?? 0.40,   // +1R → 40% partial, SL ke +0.3R
      slPlusPartial2Pct: strat.slPlusPartial2Pct ?? 0.275,  // +2R → 27.5% partial, SL ke +1R

      // Per-strategy leg overrides + multi-leg component enablement (SSOT: strategyDefaults)
      typeOverrides: strat.typeOverrides || {},
      enabledComponents: strat.enabledComponents || strat.smcEnabledComponents || null,
      afEnabledComponents: strat.afEnabledComponents || null,
      afCombinationMode: strat.afCombinationMode,
      afUseThreeComponentVoting: strat.afUseThreeComponentVoting,
      tsCombinationMode: strat.tsCombinationMode,
      mdCombinationMode: strat.mdCombinationMode,
      bsCombinationMode: strat.bsCombinationMode,

      // Full strategy SSOT knobs (smc*, typeOverrides, race flags, …)
      ...stratKnobs,

      // ── DB overrides (SELALU override semua default di atas) ─────────────
      // apiKey/apiSecret/passphrase sudah dihapus dari safeOverrides (keamanan)
      ...safeOverrides,

      // ── Credential flag (set setelah spread agar tidak ter-override) ──────
      _hasCredentials: !!(
        resolvedApiKey && resolvedApiSecret &&
        resolvedApiKey !== "your_api_key_here" &&
        resolvedApiKey !== "your_bitget_api_key"
      ),
    };

    const { normalizeSmcParams } = require("../../../core/strategy-engine/af/smcParamCompat");
    const { applyDryRunStrategyRelaxations } = require("../../../config/dryRunStrategyRelaxations");
    this.config = applyDryRunStrategyRelaxations(normalizeSmcParams(this.config));

    this.state = {
      running:       false,
      starting:      false, // set synchronously in start() before first await — prevents double-start race
      openPositions: [],
      trades:        [],    // CAPPED: keep() shiftoleh saat melebihi 500 (mem leak guard — trades[] naik 436MB/5min)
      capital:       0,
      startCapital:  0,
      lastSignal:    null,
      checkCount:    0,
      errors:        0,
      lastTick:      null,
      lastPrice:     null,

      // Multi-position tracking (v3.0 — ADAPTIVE_FUSION mode)
      // Maps componentId (A/B/C) → {side, entry, sl, tp, component, riskAmt, ...}
      positions:       new Map(),

      // Risk management tracking
      dailyTradeCount: 0,        // Jumlah trade hari ini
      dailyLoss:       0,        // Total loss hari ini (dalam USD)
      dailyStartCapital: 0,      // Modal awal hari ini (reset tiap hari)
      lastDayReset:    null,     // Timestamp reset terakhir
      consecLoss:      0,        // Loss berturut-turut
      cooldownUntil:   null,     // Timestamp cooldown selesai
      lastLossSetup:   null,     // "SIDE@entry" trade loss terakhir — guard anti-churn

      // Per-component risk tracking (multi-position mode)
      componentCooldown: new Map(),  // componentId → cooldownUntil timestamp
      componentConsecLoss: new Map(), // componentId → consecutive loss count

      // HTF trend state
      htfTrend:        "UNKNOWN", // BULLISH / BEARISH / SIDEWAYS / UNKNOWN
      dailyRegime:     "UNKNOWN", // STRONG_TREND / CHOP / TRANSITION / UNKNOWN

      // Sideways breakout state (untuk Strat C retest)
      sidewaysBreakout: null,     // { signal, rangeHigh, rangeLow, rangeEdge, buffer, atr, detectedAt }
    };

    this.logs      = [];   // circular buffer max 1000 (WS streaming)
    this.sessionId = null; // DB session ID saat ini
    // Buat exchange client dengan key yang sudah di-resolve (DB > env)
    this.client    = createExchangeClient(exchangeType, {
      apiKey: resolvedApiKey,
      apiSecret: resolvedApiSecret,
      apiPassphrase: resolvedPassphrase,
    });
    this._interval = null;
    this._reportInterval = null;
  }

  /**
   * Get real-time strategy rankings for Adaptive Fusion Strategy
   * Returns array of ranked components with scores and activation status
   */
  getStrategyRankings() {
    try {
      const SmartMoneyConceptsStrategy = require("../../../core/strategy-engine/implementations/SmartMoneyConceptsStrategy");
      const afs = new SmartMoneyConceptsStrategy();
      
      const volatility = this.state?.volatility || 1.0;
      const trendStrength = this.state?.trendStrength || 0.1;
      
      const rankings = afs.rankByMarketConditions({
        volatility,
        trend_strength: trendStrength,
      });
      
      const balance = this.config.capital || 0;
      return rankings.map(r => ({
        ...r,
        canActivate: balance >= (r.key === 'A' ? 500 : r.key === 'B' ? 50 : 0),
      }));
    } catch (err) {
      this._log("error", `Failed to get strategy rankings: ${err.message}`);
      return [];
    }
  }

  /**
   * Get position conflict information
   * Checks if new positions can be opened based on current positions
   */
  getPositionConflicts() {
    try {
      const openPositions = this.state?.openPositions || [];
      const symbolPositions = openPositions.filter(p => p.symbol === this.config.symbol).length;
      const maxPerSymbol = 1;
      const maxTotal = this.config.maxPositions || 5;
      const totalOpen = openPositions.length;
      
      const allowed = totalOpen < maxTotal && symbolPositions < maxPerSymbol;
      let reason = "Position can be opened";
      
      if (totalOpen >= maxTotal) {
        reason = `Maximum total positions reached (${totalOpen}/${maxTotal})`;
      } else if (symbolPositions >= maxPerSymbol) {
        reason = `Already have ${symbolPositions} position for ${this.config.symbol}`;
      }
      
      return {
        allowed,
        reason,
        totalOpen,
        maxTotal,
        symbolPositions,
        maxPerSymbol,
      };
    } catch (err) {
      this._log("error", `Failed to get position conflicts: ${err.message}`);
      return {
        allowed: false,
        reason: "Error checking positions",
        totalOpen: 0,
        maxTotal: 0,
        symbolPositions: 0,
        maxPerSymbol: 0,
      };
    }
  }

  // ─────────────────────────────────────────────
  // INTERNAL LOGGER — console + WS event + DB
  // ─────────────────────────────────────────────
  // ── Notifikasi Telegram per-user ─────────────────────────────────────────
  // Wrapper async yang otomatis ambil chatId user dari DB lalu kirim via notifier.
  async _notifyOpen(trade) {
    try {
      const chatId = await getUserTelegramChatId(this.config.userId);
      notifier.notifyOpen({ ...trade, chatId });
    } catch { /* non-fatal */ }
  }
  async _notifyClose(trade) {
    try {
      const chatId = await getUserTelegramChatId(this.config.userId);
      notifier.notifyClose({ ...trade, chatId });
    } catch { /* non-fatal */ }
  }
  async _notifyError(message) {
    try {
      const chatId = await getUserTelegramChatId(this.config.userId);
      notifier.notifyError(message, chatId);
    } catch { /* non-fatal */ }
  }

  _log(level, ...args) {
    const msg   = args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    const time  = new Date().toISOString();
    const entry = { time, level, msg };

    // Buffer in-memory untuk WS
    this.logs.push(entry);
    if (this.logs.length > 1000) this.logs.shift();
    this.emit("log", entry);

    // Persist ke Prisma BotLog (semua level) bila botId tersedia
    if (this.config.botId) {
      persistBotLog({ botId: this.config.botId, level, message: msg }).catch(() => {});
    }

    // Legacy session logs — trade/error only. Skip warn when Prisma already
    // persisted (dual-write was a major pool-pressure source under tick storms:
    // 27 coins × warn/tick × 2 pools → connect timeout on reconcile).
    if (this.sessionId && (level === "trade" || level === "error")) {
      try {
        db.insertLog({ sessionId: this.sessionId, level, message: msg });
      } catch { /* jangan crash bot karena log error */ }
    } else if (this.sessionId && level === "warn" && !this.config.botId) {
      try {
        db.insertLog({ sessionId: this.sessionId, level, message: msg });
      } catch { /* jangan crash bot karena log error */ }
    }

    const C      = { info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m", trade: "\x1b[32m", price: "\x1b[34m" };
    const prefix = { info: "INFO ", warn: "WARN ", error: "ERROR", trade: "TRADE", price: "PRICE" };
    const ts     = `\x1b[90m[${new Date().toLocaleTimeString("id-ID")}]\x1b[0m`;
    console.log(`${ts} ${C[level] || "\x1b[37m"}[${prefix[level] || level.toUpperCase()}] ${msg}\x1b[0m`);
  }

  // Throttle untuk log diagnostik "kenapa belum/tidak entry". Bot tick tiap 5–15
  // menit, tapi sebelumnya log dibatasi per-jumlah-tick (% 5 / % 10) sehingga
  // reasoning jarang terlihat. Gate berbasis WAKTU ini memastikan user melihat
  // ringkasan keputusan paling cepat tiap 3 menit per bot — informatif tapi tidak
  // membanjiri panel log.
  _shouldLogDecision() {
    const now = Date.now();
    if (!this._lastDecisionLogAt || now - this._lastDecisionLogAt >= 180_000) {
      this._lastDecisionLogAt = now;
      return true;
    }
    return false;
  }

  /** Throttled no-entry diagnostic — strategy-aware (avoid misleading TF EMA+RSI for MR/SMC/BR). */
  _logNoEntryDiagnostic(indicators, lastIdx, { emaF, emaS, rsi }) {
    const signalType = this.config.signalType;
    if (MODERN_SIGNAL_TYPES.has(signalType)) {
      const parts = [
        `${this.config.strategyLabel || this.config.strategyKey}: belum ada sinyal`,
      ];
      if (this.config.higherTf) {
        parts.push(`HTF ${this.config.higherTf}=${this.state.htfTrend}`);
      }
      if (rsi != null) parts.push(`RSI=${rsi.toFixed(1)}`);
      this._log("info", `⏳ Belum entry — ${parts.join(" | ")}`);
      return;
    }

    const rsiMin = this.config.rsiLongMin ?? 50;
    const rsiMax = this.config.rsiLongMax ?? 70;
    const emaOk  = emaF > emaS;
    const rsiOk  = rsi != null && rsi >= rsiMin && rsi <= rsiMax;
    const vol    = indicators.volumes?.[lastIdx] ?? 0;
    const volAvg = indicators.volSMA?.[lastIdx]  ?? 0;
    const volOk  = !volAvg || vol >= volAvg * this.config.volSmaMultiplier;
    const htfOk  = !this.config.higherTf ||
                   this.state.htfTrend === "BULLISH" ||
                   this.state.htfTrend === "SIDEWAYS";

    const reasons = [];
    if (!emaOk)    reasons.push(`EMA${this.config.emaFast}<EMA${this.config.emaSlow} (trend belum bullish)`);
    if (!htfOk)    reasons.push(`HTF ${this.config.higherTf}=${this.state.htfTrend} (bukan BULLISH)`);
    if (!rsiOk && rsi != null) {
      const tag = rsi > rsiMax ? "overbought—tunggu pullback" : "terlalu rendah";
      reasons.push(`RSI=${rsi.toFixed(1)} di luar zona ${rsiMin}–${rsiMax} (${tag})`);
    }
    if (!volOk && volAvg > 0) {
      reasons.push(`Volume ${(vol / volAvg).toFixed(2)}x SMA (perlu ≥${this.config.volSmaMultiplier}x)`);
    }
    if (reasons.length === 0) {
      reasons.push(`RSI pullback-bounce pattern belum terpenuhi (RSI=${rsi?.toFixed(1)}, perlu pullback ke ${rsiMin}–${rsiMax} lalu naik)`);
    }
    this._log("info", `⏳ Belum entry — menunggu: ${reasons.join(" | ")}`);
  }

  _capTrades() {
    // Maintain trades array at most 500 entries (mem leak guard). Saat .length > 500,
    // shift (hapus oldest). Rationale: UI laporan menampilkan ~100 trades max, DB sudah
    // punya full history — in-memory copy di-keep untuk WS stream + getState() reports,
    // tidak perlu grow unbounded (436MB setiap 5min). Oldest trades paling sering
    // tidak diakses (sudah lama ditutup). Keep newest 500 untuk 99th percentile user
    // query (backtest recents, recent P&L calculation).
    const MAX_TRADES = 500;
    while (this.state.trades.length > MAX_TRADES) {
      this.state.trades.shift();
    }
  }

  _sep(label = "") {
    const line = "─".repeat(50);
    const sep  = label
      ? `\n\x1b[90m${line}\x1b[0m\n\x1b[1m\x1b[33m  ${label}\x1b[0m\n\x1b[90m${line}\x1b[0m\n`
      : `\x1b[90m${line}\x1b[0m`;
    console.log(sep);
    if (label) this._log("info", `══ ${label} ══`);
  }

  /**
   * Emit BANYAK baris sebagai SATU entry log (dipisah newline) — supaya panel log
   * menampilkannya sebagai 1 kartu, bukan belasan kartu terpisah. Dipakai untuk
   * banner startup ("══ QUANTARA BOT ══ … ══ BOT BERJALAN ══") yang sebelumnya
   * memenuhi panel dengan ~13 baris terpisah.
   */
  _logBlock(level, lines) {
    const msg = lines.filter(l => l != null).join("\n");
    this._log(level, msg);
  }

  // ─────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────
  // Session ID aktif (array) — dipakai history.js untuk menandai sesi "ACTIVE".
  // Engine tunggal = satu sesi.
  getSessionIds() {
    return this.sessionId ? [this.sessionId] : [];
  }

  getState() {
    return {
      running:       this.state.running,
      starting:      this.state.starting,
      sessionId:     this.sessionId,
      symbol:        this.config.symbol,
      exchange:      this.config.exchange,
      exchangeLabel: this.config.exchangeLabel,
      dryRun:        this.config.dryRun,
      capital:        this.state.capital,
      startCapital:   this.state.startCapital,
      // Enrich tiap posisi dengan unrealizedPL terhitung agar FE bisa tampilkan
      // PnL per-posisi (sebelumnya field ini hanya diisi di mode live → dry-run kosong).
      openPositions:  this.state.openPositions.map((p) => {
        let upnl = (p.unrealizedPL && p.unrealizedPL !== 0) ? p.unrealizedPL : null;
        if (upnl == null) {
          const px = this.state.lastPrice;
          const sz = p.remainingSize || p.size || 0;
          upnl = (px && p.entry)
            ? (p.side === "LONG" ? (px - p.entry) * sz : (p.entry - px) * sz)
            : 0;
        }
        return { ...p, unrealizedPL: upnl };
      }),
      trades:         this.state.trades.slice(-50),
      // totalTrades = open + closed (bukan hanya closed)
      totalTrades:    this.state.trades.length + this.state.openPositions.length,
      closedTrades:   this.state.trades.length,
      openTradeCount: this.state.openPositions.length,
      lastSignal:     this.state.lastSignal,
      checkCount:    this.state.checkCount,
      errors:        this.state.errors,
      lastTick:      this.state.lastTick,
      lastPrice:     this.state.lastPrice,
      // totalPnL = GROSS (selisih harga). totalFees & netPnL dipisah agar
      // dashboard bisa menampilkan keduanya — gross tak akan cocok dengan
      // perubahan balance riil karena fee. Net = gross - fee - funding.
      totalPnL:      this.state.trades.reduce((s, t) => s + (t.pnl || 0), 0),
      totalFees:     this.state.trades.reduce((s, t) => s + (t.fee || 0) + (t.funding || 0), 0),
      netPnL:        this.state.trades.reduce((s, t) => s + (t.pnl || 0) - (t.fee || 0) - (t.funding || 0), 0),
      unrealizedPnL: this.state.openPositions.reduce((s, p) => {
        if (p.unrealizedPL && p.unrealizedPL !== 0) return s + p.unrealizedPL;
        // Fallback: hitung dari lastPrice jika unrealizedPL belum diset dari exchange
        const px = this.state.lastPrice;
        if (!px || !p.entry) return s;
        const sz   = p.remainingSize || p.size || 0;
        const upnl = p.side === "LONG" ? (px - p.entry) * sz : (p.entry - px) * sz;
        return s + upnl;
      }, 0),
      winRate:       this._winRate(),

      // Risk management state
      riskState: {
        htfTrend:        this.state.htfTrend,
        higherTf:        this.config.higherTf,
        dailyTradeCount: this.state.dailyTradeCount,
        maxTradesPerDay: this.config.maxTradesPerDay,
        dailyLoss:       this.state.dailyLoss,
        maxDailyLossPct: this.config.maxDailyLossPct,
        consecLoss:      this.state.consecLoss,
        maxConsecLoss:   this.config.maxConsecLoss,
        cooldownUntil:   this.state.cooldownUntil,
        inCooldown:      !!(this.state.cooldownUntil && Date.now() < this.state.cooldownUntil),
      },

      params: {
        strategyKey:   this.config.strategyKey,
        strategyLabel: this.config.strategyLabel,
        signalType:    this.config.signalType,
        emaFast:       this.config.emaFast,
        emaSlow:       this.config.emaSlow,
        emaTrend:      this.config.emaTrend,
        rsiPeriod:     this.config.rsiPeriod,
        rsiOverbought: this.config.rsiOverbought,
        rsiOversold:   this.config.rsiOversold,
        atrPeriod:     this.config.atrPeriod,
        atrMultiplier: this.config.atrMultiplier,
        riskReward:      this.config.riskReward,
        riskPerTrade:    this.config.riskPerTrade,
        maxRiskPerTrade: this.config.maxRiskPerTrade,
        leverage:        this.config.leverage,
        useBothSides:  this.config.useBothSides,
        interval:      this.config.interval,
        checkInterval: this.config.checkInterval,
        higherTf:      this.config.higherTf,
        grokConfirmEnabled:        this.config.grokConfirmEnabled ?? false,
        grokConfirmTpAdjust:       this.config.grokConfirmTpAdjust ?? true,
        grokConfirmTpBandPct:      this.config.grokConfirmTpBandPct,
        grokConfirmTpRejectAction: this.config.grokConfirmTpRejectAction,
        minConfidenceEntry:        this.config.minConfidenceEntry,
        minConfidenceTpSl:         this.config.minConfidenceTpSl,
      },
    };
  }

  getConfig() {
    const { ...cfg } = this.config;
    return cfg;
  }

  getLogs(n = 100) {
    return this.logs.slice(-Math.min(n, 1000));
  }

  /**
   * Inject MetaSelectorEngine (Sprint 3 / MS-1).
   * Called lazily from app.js after bot creation.
   * @param {object} engine — MetaSelectorEngine singleton or instance
   */
  setMetaSelector(engine) {
    this.metaSelector = engine;
  }

  async start() {
    if (this.state.running)  throw new Error("Bot sudah berjalan");
    if (this.state.starting) throw new Error("Bot sedang dalam proses start");
    this.state.starting = true; // SYNC — set before first await; prevents concurrent start race
    this._stopRequested = false; // di-set stop(); start() membatalkan diri jika true

    // Reset in-memory state
    this.state.trades        = [];
    this.state.openPositions = [];
    this.state.lastSignal    = null;
    this.state.checkCount    = 0;
    this.state.errors        = 0;

    try {
    const banner = await this._startup();
    // stop() dipanggil selama _startup() (mis. Stop All saat warm-up) → batalkan
    // sebelum membuka sesi & menandai running, agar tidak ada engine zombie.
    if (this._stopRequested) {
      this._log("warn", "Start dibatalkan — stop diminta saat warm-up");
      return;
    }
    this.state.running = true;

    // ── Selalu buat sesi BARU (1 token bisa punya banyak sesi) ────────────
    this.sessionId = await db.openSession({
      exchange:       this.config.exchange,
      symbol:         this.config.symbol,
      mode:           this.config.dryRun ? "dry_run" : "live",
      initialCapital: this.state.startCapital,
      config:         this.config,
      userId:         this.config.userId ?? null,  // isolasi data per user
    });
    banner.push(`Session    : DB #${this.sessionId} dibuat`);

    // ── Restore posisi terbuka dari SEMUA sesi lama (lintas sesi) ─────────
    // Cari trades dengan close_time IS NULL untuk symbol ini di semua sesi
    try {
      let orphans = await db.getOpenTradesBySymbol(this.config.symbol, this.config.userId ?? null);
      // Multi-Strategy per Coin: bila engine ini bagian dari grup (N strategi pada
      // satu koin), batasi restore HANYA pada trade strategi ini — agar tiap engine
      // tidak meng-klaim posisi milik strategi lain pada simbol yang sama.
      // Legacy single-engine (tanpa groupKey) tetap memulihkan semua posisi simbol.
      if (this.config.groupKey && this.config.strategyKey) {
        orphans = orphans.filter((row) => {
          let stratOfTrade = null;
          try { stratOfTrade = row.indicators ? JSON.parse(row.indicators)?.strategy : null; } catch { /* ignore */ }
          // Engine grup non-leader: hanya klaim trade dengan atribusi strategi yang cocok.
          // Engine grup LEADER (isGroupLeader=true): juga klaim legacy trades tanpa
          // atribusi strategi — agar posisi yang dibuka sebelum multi-strategy di-deploy
          // tetap bisa dipantau SL/TP dan ditutup dengan benar (tidak stuck selamanya).
          if (stratOfTrade === null) return !!this.config.isGroupLeader;
          return stratOfTrade === this.config.strategyKey;
        });
      }
      if (orphans.length > 0) {
        this._log("info", `${orphans.length} posisi open dari sesi lama ditemukan — sinkronisasi dengan exchange...`);

        if (!this.config.dryRun) {
          try {
            const livePosns = await this.client.getPositions(this.config.symbol);
            const liveByKey = new Map(livePosns.map(p => [p.side, p]));

            for (const dbTrade of orphans) {
              if (liveByKey.has(dbTrade.side)) {
                // Masih terbuka di exchange → angkat ke state sesi ini
                const lp        = liveByKey.get(dbTrade.side);
                const markPrice = lp.markPrice || dbTrade.entry_price;
                const size      = dbTrade.size || 0;
                // Hitung unrealized PnL secara manual jika exchange return 0
                const upnlFromExchange = lp.unrealizedPL ?? 0;
                const upnlCalc = markPrice > 0 && dbTrade.entry_price > 0
                  ? (dbTrade.side === "LONG"
                      ? (markPrice - dbTrade.entry_price) * size
                      : (dbTrade.entry_price - markPrice) * size)
                  : 0;
                const unrealizedPL = upnlFromExchange !== 0 ? upnlFromExchange : upnlCalc;

                this.state.openPositions.push({
                  id:           dbTrade.order_id || `restored_${dbTrade.id}`,
                  dbId:         dbTrade.id,        // tetap pakai id trade lama di DB
                  side:         dbTrade.side,
                  entry:        dbTrade.entry_price,
                  sl:           dbTrade.sl,
                  tp:           dbTrade.tp,
                  size,
                  openTime:     new Date(dbTrade.open_time).getTime(),
                  atr:          dbTrade.atr,
                  manualSLTP:   false,
                  unrealizedPL,
                  markPrice,
                  restoredFrom: dbTrade.session_id,
                  // SL+ tracking (restored dari nilai DB)
                  remainingSize: size,
                  R:             dbTrade.atr ? dbTrade.atr * this.config.atrMultiplier : 0,
                  slCurrent:     dbTrade.sl,
                  m1: false, m2: false, m3: false,
                });
                this._log("trade", `✓ Posisi ${dbTrade.side} @$${dbTrade.entry_price} dipulihkan (sesi #${dbTrade.session_id})`);
              } else {
                // Tidak ada di exchange → tutup di DB (kena SL/TP saat offline)
                const exitPrice = this.state.lastPrice || dbTrade.entry_price;
                const pnl       = dbTrade.side === "LONG"
                  ? (exitPrice - dbTrade.entry_price) * (dbTrade.size || 0)
                  : (dbTrade.entry_price - exitPrice) * (dbTrade.size || 0);
                // Close terdeteksi offline → fill aktual tak bisa dipetakan; estimasi fee
                const fee = this._estimateFee(dbTrade.entry_price, exitPrice, dbTrade.size || 0);
                this._log("warn", `Posisi ${dbTrade.side} sesi #${dbTrade.session_id} sudah ditutup di exchange saat offline — PnL ≈ $${pnl.toFixed(2)} (fee est -$${fee.toFixed(4)})`);
                try {
                  const offlinePos = { entry: dbTrade.entry_price, sl: dbTrade.sl, tp: dbTrade.tp, dbId: dbTrade.id };
                  await this._closeTradeInDb(offlinePos, {
                    exitPrice,
                    pnl,
                    fee,
                    reason:    "Closed_Offline",
                    closeTime: new Date().toISOString(),
                  });
                  onEngineTradeClose(dbTrade.id, pnl);
                } catch { /* jangan crash */ }
              }
            }
          } catch (err) {
            // Exchange gagal — restore semua dari DB sebagai fallback
            this._log("warn", `Gagal sync exchange: ${err.message} — restore posisi dari DB`);
            for (const dbTrade of orphans) {
              this.state.openPositions.push({
                id:           dbTrade.order_id || `restored_${dbTrade.id}`,
                dbId:         dbTrade.id,
                side:         dbTrade.side,
                entry:        dbTrade.entry_price,
                sl:           dbTrade.sl,
                tp:           dbTrade.tp,
                size:         dbTrade.size,
                openTime:     new Date(dbTrade.open_time).getTime(),
                atr:          dbTrade.atr,
                manualSLTP:   false,
                restoredFrom: dbTrade.session_id,
              });
            }
          }
        } else {
          // Dry run: restore langsung dari DB tanpa sync exchange
          for (const dbTrade of orphans) {
            this.state.openPositions.push({
              id:           dbTrade.order_id || `restored_${dbTrade.id}`,
              dbId:         dbTrade.id,
              side:         dbTrade.side,
              entry:        dbTrade.entry_price,
              sl:           dbTrade.sl,
              tp:           dbTrade.tp,
              size:         dbTrade.size,
              openTime:     new Date(dbTrade.open_time).getTime(),
              atr:          dbTrade.atr,
              restoredFrom: dbTrade.session_id,
            });
          }
        }

        if (this.state.openPositions.length > 0)
          this._log("info", `${this.state.openPositions.length} posisi aktif dipulihkan ✓`);
      }

      // Re-reserve margin di koordinator untuk posisi yang dipulihkan (#5) — agar
      // setelah restart/redeploy, margin posisi terbuka tetap diperhitungkan dan
      // tidak terjadi over-commit oleh bot lain.
      if (!this.config.dryRun && this.config.coordinator && this.state.openPositions.length > 0) {
        const p   = this.state.openPositions[0];
        const lev = this.config.leverage || 1;
        const sz  = p.remainingSize || p.size || 0;
        const margin = (p.entry * sz) / lev;
        const botKey = this.config.botKey || `${this.config.userId ?? "anon"}:${this.config.symbol}`;
        this.config.coordinator.reserve(botKey, {
          symbol: this.config.symbol, margin,
          groupKey: this.config.groupKey ?? null,
          strategyKey: this.config.strategyKey ?? null,
          direction: p.side,
        });
      }
    } catch (err) {
      this._log("warn", `Gagal restore posisi lama: ${err.message}`);
    }

    this.emit("status", this.getState());

    await this._tick();

    // stop() mendarat selama open-session/restore/tick → jangan pasang interval apa pun.
    if (this._stopRequested || !this.state.running) {
      this._log("warn", "Warm-up dibatalkan — stop diminta; interval tidak dipasang");
      return;
    }

    // Jitter + stagger antar strategi (tickStaggerMs) sebarkan start-time interval
    // agar multi-strategy pada koin sama tidak burst getCandles bersamaan.
    //
    // PENTING (anti-zombie): pemasangan setInterval DITUNDA via setTimeout yang
    // handle-nya disimpan (this._startTimer), BUKAN `await new Promise(setTimeout)`.
    // Dengan await, bila stop() dipanggil selama jendela jitter, stop() membersihkan
    // this._interval (yang masih null) lalu jitter selesai & memasang interval SETELAH
    // stop → ticker zombie jalan selamanya walau bot sudah di-stop. Pola deferred
    // setTimeout membuat stop() bisa membatalkan pemasangan lewat clearTimeout, dan
    // guard di dalam timer mencegah pemasangan bila stop sudah terjadi.
    const baseJitter = Math.floor(Math.random() * Math.min(this.config.checkInterval, 15_000));
    const jitterMs = (this.config.tickStaggerMs || 0) + baseJitter;
    this._startTimer = setTimeout(() => {
      this._startTimer = null;
      // Bot sudah di-stop selama warm-up → jangan pasang ticker (cegah zombie)
      if (!this.state.running || this._stopRequested) return;
      // CHAINED setTimeout (anti death-spiral): setInterval TIDAK menunggu _tick()
      // async selesai → tick overlap → pool Postgres & Prisma terkuras. Jadwalkan
      // tick berikutnya HANYA setelah tick selesai; delay = max(0, interval - elapsed)
      // agar rate tetap ~checkInterval saat tick cepat, dan tidak overlap saat lambat.
      const scheduleNext = () => {
        if (!this.state.running || this._stopRequested) return;
        const started = Date.now();
        Promise.resolve()
          .then(() => this._tick())
          .catch((err) => {
            try { this._log("warn", `Tick error: ${err?.message || err}`); } catch { /* jangan crash */ }
          })
          .finally(() => {
            if (!this.state.running || this._stopRequested) return;
            const elapsed = Date.now() - started;
            const delay = Math.max(0, this.config.checkInterval - elapsed);
            this._interval = setTimeout(scheduleNext, delay);
          });
      };
      scheduleNext();
    }, jitterMs);

    // emitStatusReport:false → engine ini bagian dari grup multi-strategi; JANGAN
    // pasang report per-engine. Tanpa guard ini, koin dengan N strategi menumpuk N
    // status report di satu kartu (bug ZEC: 2 strategi → report dobel; ETH 1 strategi
    // tampak normal). Koordinator emit SATU report teragregasi (_emitUnifiedStatus).
    if (this.config.emitStatusReport !== false) {
      this._reportInterval = setInterval(() => this._statusReport(), 60 * 60 * 1000);
    }

    // ══ BOT BERJALAN ══ + ringkasan boot lengkap → emit SATU kartu log.
    // quietStartup: engine ini bagian dari grup multi-strategi → JANGAN emit banner
    // per-engine. Koordinator akan emit SATU banner terpadu untuk seluruh grup
    // (lihat MultiStrategyCoordinator._emitUnifiedBanner) agar config tiap strategi
    // jelas atribusinya — tidak ambigu "cek 60s itu strategi mana".
    if (!this.config.quietStartup) {
      banner.push("");
      banner.push("══ BOT BERJALAN ══");
      banner.push(`Bot aktif  : cek setiap ${this.config.checkInterval / 1000}s`);
      this._logBlock("info", banner);
    }

    } finally {
      this.state.starting = false;
    }
  }

  async stop() {
    // Sinyalkan ke start() yang mungkin masih warm-up agar membatalkan diri. Di-set
    // SYNC sebelum await apa pun, sehingga guard di start() melihatnya.
    this._stopRequested = true;
    // Satu pass SL/TP terakhir sebelum interval dimatikan — hindari posisi "nyangkut"
    // open walau harga sudah lewat SL (mis. LAB mark $14.65 vs SL $18.05).
    if (this.state.openPositions.length > 0) {
      try {
        await this._monitorOpenPositions(null, null, 0);
      } catch (e) {
        this._log("warn", `Final SL/TP check gagal: ${e.message}`);
      }
    }
    // Batalkan timer warm-up jitter jika start() masih dalam jendela jitter — tanpa
    // ini setInterval akan terpasang SETELAH stop() → ticker zombie (lihat start()).
    if (this._startTimer)     { clearTimeout(this._startTimer); this._startTimer = null; }
    if (this._interval)       { clearTimeout(this._interval); this._interval = null; }
    if (this._reportInterval) clearInterval(this._reportInterval);
    this._reportInterval = null;
    this.state.running   = false;

    // Lepas reservasi margin HANYA jika bot sudah flat (#5). Jika masih ada
    // posisi terbuka (akan dipulihkan di start berikutnya), reservasi DIPERTAHANKAN
    // agar margin yang masih terkunci di exchange tetap diperhitungkan bot lain.
    this._releaseMarginIfFlat();

    // Tutup sesi di DB
    // Posisi yang masih open (close_time IS NULL) tetap tersimpan di tabel trades
    // dan akan di-restore oleh start() berikutnya via getOpenTradesBySymbol()
    if (this.sessionId) {
      const wins        = this.state.trades.filter(t => t.pnl > 0).length;
      const losses      = this.state.trades.filter(t => t.pnl <= 0).length;
      const totalTrades = this.state.trades.length + this.state.openPositions.length;
      const openCount   = this.state.openPositions.length;

      // ── finalCapital = modal awal bot ini + PnL trade bot ini sendiri ──
      // JANGAN pakai this.state.capital (balance exchange bersama 3 bot!)
      const tradePnL   = this.state.trades.reduce((s, t) => s + (t.pnl || 0), 0);
      const finalCapital = this.state.startCapital + tradePnL;

      await db.closeSession(this.sessionId, {
        finalCapital,
        totalTrades,
        wins,
        losses,
      });

      if (openCount > 0)
        this._log("warn", `Session DB #${this.sessionId} ditutup (${openCount} posisi masih open — akan dipulihkan di sesi berikutnya)`);
      else
        this._log("warn", `Session DB #${this.sessionId} ditutup`);

      this.sessionId = null;
    }

    this._log("warn", "Bot dihentikan");
    this.emit("status", this.getState());
  }

  // ─────────────────────────────────────────────
  // STARTUP
  // ─────────────────────────────────────────────
  async _startup() {
    // Kumpulkan SEMUA baris konfigurasi ke dalam satu array, lalu emit sebagai
    // SATU kartu log di akhir start() — bukan ~13 kartu terpisah. Mengembalikan
    // array ini agar start() bisa menambah baris "Session DB" / "cek tiap Ns"
    // sebelum emit, sehingga seluruh ringkasan boot tampil dalam 1 grup.
    const banner = [];
    banner.push(`══ QUANTARA BOT — ${this.config.exchangeLabel.toUpperCase()} ══`);
    banner.push(`Mode       : ${this.config.dryRun ? "DRY RUN (simulasi)" : "LIVE TRADING"}`);
    banner.push(`Exchange   : ${this.config.exchangeLabel}`);
    banner.push(`Symbol     : ${this.config.symbol}`);
    banner.push(`Interval   : ${this.config.interval}`);
    banner.push(`Strategi   : ${stratLabel(this.config.strategyKey)}`);
    banner.push(`EMA        : Fast(${this.config.emaFast}) / Slow(${this.config.emaSlow})`);
    banner.push(`RSI        : Overbought(${this.config.rsiOverbought}) / Oversold(${this.config.rsiOversold})`);
    banner.push(`Risk/trade : ${(this.config.riskPerTrade * 100).toFixed(1)}%  |  Leverage: ${this.config.leverage}x  |  RR: 1:${this.config.riskReward}`);

    // Gunakan kredensial yang sudah di-resolve (DB key dari Settings > env var)
    const noKey = !this.config._hasCredentials;

    if (noKey) {
      if (!this.config.dryRun) throw new Error("API Key exchange belum dikonfigurasi. Tambahkan di menu Settings → API Keys.");
      banner.push("API Key    : tidak ditemukan — DRY RUN tanpa koneksi exchange (simulasi)");
      this.state.capital = this.state.startCapital = this.config.capital || 500;
    } else {
      try {
        // Use pre-fetched balance from MultiStrategyCoordinator if available (avoids
        // N redundant getBalance() calls when N engines share the same coin/account).
        const bal = this.config.sharedBalance
          ? this.config.sharedBalance
          : await this.client.getBalance(this.config.marginCoin);
        const totalEquity = (bal.equity > 0 ? bal.equity : bal.available);

        if (this.config.dryRun) {
          // Dry-run: modal simulasi dari config DB, BUKAN saldo exchange nyata.
          this.state.capital = this.state.startCapital = this.config.capital || 500;
          // Jika engine adalah bagian dari grup multi-strategy, tampilkan modal
          // per-engine DAN total grup agar tidak membingungkan.
          const modalLog = this.config.groupTotalCapital && this.config.groupTotalCapital !== this.state.capital
            ? `Modal      : DRY RUN $${this.state.capital.toFixed(2)} USDT per strategi (total bot: $${this.config.groupTotalCapital.toFixed(2)}) (exchange: $${totalEquity.toFixed(2)} — hanya referensi)`
            : `Modal      : DRY RUN $${this.state.capital.toFixed(2)} USDT (exchange: $${totalEquity.toFixed(2)} — hanya referensi)`;
          banner.push(modalLog);
        } else {
          // Live: gunakan equity total (available + margin terkunci).
          this.state.capital      = totalEquity;
          this.state.startCapital = totalEquity;
          banner.push(`Balance    : $${totalEquity.toFixed(2)} USDT (available: $${bal.available.toFixed(2)})`);
          if (this.config.sharedLeverageSet) {
            // Leverage + margin mode already set once by coordinator for this symbol.
            banner.push(`Leverage   : ${this.config.leverage}x diset ✓ (koordinator)`);
          } else {
            await this.client.setLeverage(this.config.symbol, this.config.leverage);
            await this.client.setMarginMode(this.config.symbol, "crossed");
            banner.push(`Leverage   : ${this.config.leverage}x diset ✓`);
          }
        }
      } catch (err) {
        const _em = err.message || "";
        const _okxIpCode = _em.match(/"?code"?\s*:\s*"?50110"?/i);
        const _okxIpAddr = _em.match(/IP\s+([\da-f:.]+)/i)?.[1];
        const _displayMsg = _okxIpCode
          ? `IP server tidak di-whitelist OKX${_okxIpAddr ? ` (IP: ${_okxIpAddr})` : ""}. Solusi: buka OKX → Profile → API → Edit API key → hapus semua isian IP whitelist (biarkan kosong), atau tambahkan IP server ke whitelist, lalu simpan.`
          : _em;
        // Error koneksi tetap kartu terpisah (level error → merah, mudah terlihat).
        this._log("error", `Gagal connect ke ${this.config.exchangeLabel}: ${_displayMsg}`);
        if (!this.config.dryRun) throw err;
        this.state.capital = this.state.startCapital = this.config.capital || 500;
        banner.push(`Modal      : Fallback DRY RUN $${this.state.capital.toFixed(2)} (koneksi exchange gagal)`);
      }
    }

    // ── Pulihkan circuit-breaker risiko dari DB (#3) ──────────────────────────
    // Tanpa ini, stop→start / redeploy mereset daily-loss & loss-streak ke 0,
    // sehingga batas kerugian harian bisa ditembus. Hitung ulang dari trade
    // yang sudah closed HARI INI (UTC) untuk user+symbol+mode ini.
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const risk = await db.getTodayRiskStats({
        userId:  this.config.userId ?? null,
        symbol:  this.config.symbol,
        dryRun:  this.config.dryRun,
      });
      this.state.dailyLoss         = risk.dailyLoss;
      this.state.dailyTradeCount   = risk.dailyTradeCount;
      this.state.consecLoss        = risk.consecLoss;
      this.state.lastDayReset      = todayStr;
      // dailyStartCapital ≈ modal saat ini + loss hari ini (perkiraan modal awal hari).
      this.state.dailyStartCapital = this.state.capital + risk.dailyLoss;
      if (risk.dailyTradeCount > 0) {
        banner.push(
          `🛡️ Risk      : dipulihkan dari DB — trade hari ini ${risk.dailyTradeCount}, ` +
          `daily loss $${risk.dailyLoss.toFixed(2)}, loss beruntun ${risk.consecLoss}`
        );
      }
    } catch (e) {
      banner.push(`Risk       : gagal dipulihkan dari DB (${e.message}) — mulai dari 0`);
    }

    return banner;
  }

  // ─────────────────────────────────────────────
  // RISK MANAGEMENT HELPERS
  // ─────────────────────────────────────────────

  /** Reset counter harian jika sudah ganti hari */
  _resetDailyIfNeeded() {
    const now     = new Date();
    const todayStr = now.toISOString().slice(0, 10); // "2026-06-03"
    if (this.state.lastDayReset !== todayStr) {
      this.state.dailyTradeCount   = 0;
      this.state.dailyLoss         = 0;
      this.state.dailyStartCapital = this.state.capital;
      this.state.lastDayReset      = todayStr;
      this.state.consecLoss        = 0;
      this.state.cooldownUntil     = null;
      this._log("info", `📅 Hari baru — daily counter di-reset`);
    }
  }

  /**
   * Periksa apakah boleh buka trade baru.
   * Returns { ok: true } atau { ok: false, reason: string }
   */
  /**
   * @param {number} atr
   * @param {number} price
   * @param {object|null} [atrGateCfg] — optional ATR gate config (leg overrides +
   *   atrBaseline for atrGateRelative). Defaults to this.config.
   */
  _checkRiskGates(atr, price, atrGateCfg = null) {
    // Order matters (preserved from pre-2g BotEngine):
    //   per-bot gates → account coordinator (#5) → ATR range.
    const gate = checkEntryRiskGates({
      state: this.state,
      config: this.config,
      now: Date.now(),
    });
    if (!gate.ok) return gate;

    // 4b. Daily loss AGREGAT akun lintas-bot (#5)
    if (!this.config.dryRun && this.config.coordinator) {
      const acc = this.config.coordinator.canTradeAccount();
      if (!acc.ok) return { ok: false, reason: acc.reason };
    }

    // 5. ATR range filter (SIDEWAYS dipindah ke _tick() per-strategi)
    // atrGateCfg lets Scalping pass atrGateRelative + rolling baseline (live/backtest parity).
    return checkAtrRangeGate(atr, price, atrGateCfg || this.config);
  }

  /** Panggil setelah trade ditutup untuk update counter risk */
  _updateRiskAfterClose(pnl, pos = null) {
    if (pnl < 0) {
      this.state.dailyLoss   += Math.abs(pnl);
      this.state.consecLoss  += 1;
      // Anti-churn: rekam signature setup yang baru saja loss (side + harga entry).
      // Entry berikutnya dengan signature IDENTIK ditolak — mencegah bot membeli
      // ulang setup yang baru terbukti salah pada candle/sinyal yang sama.
      if (pos?.side && pos?.entry != null) {
        this.state.lastLossSetup = `${pos.side}@${pos.entry}`;
      }
      // Set cooldown
      if (this.config.cooldownAfterLoss > 0) {
        this.state.cooldownUntil = Date.now() + this.config.cooldownAfterLoss * 60 * 1000;
        this._log("warn", `🕐 Cooldown ${this.config.cooldownAfterLoss} menit aktif setelah loss`);
      }
    } else {
      this.state.consecLoss = 0; // Reset streak setelah win
    }
  }

  // ─────────────────────────────────────────────
  // MAIN TICK
  // ─────────────────────────────────────────────
  async _tick() {
    // Guard stop: bot sudah dihentikan (atau diminta stop) → jangan proses tick.
    // Mencegah tick zombie yang sempat ter-antri sebelum clearInterval tetap menaruh
    // order setelah bot "stopped" (langgar aturan: bot dihentikan harus benar berhenti).
    if (this._stopRequested || !this.state.running) {
      return;
    }
    // Guard re-entrancy (#6): _tick async & bisa lebih lama dari checkInterval
    // (ada sleep retry SL 3s + backoff 120s). Tanpa guard, setInterval memicu
    // tick paralel → entry ganda & race pada openPositions.
    if (this._ticking) {
      this._log("info", "Tick sebelumnya masih berjalan — lewati tick ini");
      return;
    }
    this._ticking = true;

    this.state.checkCount++;
    this.state.lastTick = new Date().toISOString();

    // Reset daily counter jika hari baru
    this._resetDailyIfNeeded();

    try {
      const candles = await this._fetchCandles();
      this._lastCandles = candles;
      if (!candles || candles.length < this.config.emaSlow + 20) {
        this._log("warn", "Candle tidak cukup untuk kalkulasi indikator");
        // Posisi terbuka tetap wajib dimonitor SL/TP meski indikator belum siap.
        if (this.state.openPositions.length > 0) {
          await this._monitorOpenPositions(null, null, 0);
        }
        return;
      }

      const indicators = calcIndicators(candles, {
        emaFast:   this.config.emaFast,
        emaSlow:   this.config.emaSlow,
        emaTrend:  this.config.emaTrend,
        rsiPeriod: this.config.rsiPeriod,
        atrPeriod: this.config.atrPeriod,
      });

      // MEAN_REVERSION ADX regime gate (MD-SUB-01) reads indicators.adx on the entry TF.
      if (isMeanReversionKey(this.config.strategyKey) || isMeanReversionKey(this.config.signalType)) {
        indicators.adx = calcADX(indicators.highs, indicators.lows, indicators.closes, 14).adx;
      }

      // ── HTF Trend Filter ───────────────────────────────────────────────────
      let htfCandlesCache = null;  // disimpan untuk sideways breakout detection
      if (this.config.higherTf) {
        try {
          const htfCandles = await this._fetchHtfCandles();
          if (htfCandles?.length) {
            htfCandlesCache = htfCandles;
            this.state.htfTrend = detectHTFTrend(htfCandles, {
              htfEmaFast:           this.config.htfEmaFast,
              htfEmaSlow:           this.config.htfEmaSlow,
              sidewaysThresholdPct: this.config.sidewaysThresholdPct,
            });
          } else {
            this.state.htfTrend = "UNKNOWN";
          }
        } catch {
          // Tidak bisa fetch HTF → UNKNOWN. Entry baru DIBLOK (fail-closed) di
          // STEP 3 — tanpa data regime, jangan ambil posisi baru. Posisi terbuka
          // tetap dikelola normal (SL/TP jalan terus).
          this.state.htfTrend = "UNKNOWN";
        }
      }

      // Daily regime (ADX-proxy on 1d) — SA TRANSITION gate + CSV export parity
      await this._refreshDailyRegime(candles[lastIdx]?.timestamp ?? Date.now());

      // Reset sidewaysBreakout state jika HTF sudah tidak SIDEWAYS lagi
      if (this.state.htfTrend !== "SIDEWAYS" && this.state.sidewaysBreakout) {
        this._log("info", `HTF ${this.config.higherTf} tidak lagi SIDEWAYS — reset sideways breakout state`);
        this.state.sidewaysBreakout = null;
      }

      const lastIdx  = candles.length - 2;
      const price    = candles[lastIdx].close;
      const emaF     = indicators.emaFast[lastIdx];
      const emaS     = indicators.emaSlow[lastIdx];
      const emaTrend = this.config.emaTrend > 0 && indicators.emaTrend ? indicators.emaTrend[lastIdx] : null;
      const rsi      = indicators.rsi[lastIdx];
      const atr      = indicators.atr[lastIdx];

      this.state.lastPrice = price;

      if (this.state.checkCount % 5 === 1) {
        const htfLabel   = this.config.higherTf ? ` | HTF(${this.config.higherTf}): ${this.state.htfTrend}` : "";
        const trendLabel = emaTrend
          ? (price > emaTrend ? "↑ MAJOR" : "↓ MAJOR")
          : (emaF > emaS ? "↑ BULLISH" : "↓ BEARISH");
        this._log("price",
          `${this.config.symbol} $${price.toLocaleString()} | ` +
          `EMA${this.config.emaFast}=${emaF?.toFixed(2)} EMA${this.config.emaSlow}=${emaS?.toFixed(2)}` +
          (emaTrend ? ` EMA${this.config.emaTrend}=${emaTrend?.toFixed(2)}` : "") + ` | ` +
          `RSI=${rsi?.toFixed(1)} ATR=${atr?.toFixed(2)} | ` +
          `Trend: ${trendLabel}${htfLabel} | Strat: ${stratLabel(this.config.strategyKey)}`
        );
      }

      await this._monitorOpenPositions(candles, price, atr);

      // Lapor risk ke koordinator akun tiap tick (#5) — termasuk saat memegang
      // posisi — agar gate daily-loss agregat lintas-bot selalu pakai data segar.
      if (!this.config.dryRun && this.config.coordinator) {
        const floatingLoss = this.state.openPositions.reduce((s, p) => {
          const u = p.unrealizedPL || 0;
          return u < 0 ? s + Math.abs(u) : s;
        }, 0);
        const botKey = this.config.botKey || `${this.config.userId ?? "anon"}:${this.config.symbol}`;
        this.config.coordinator.reportRisk(botKey, { realizedLoss: this.state.dailyLoss, floatingLoss });
      }

      // ── MetaSelector shadow hook (Sprint 3 / MS-1) ───────────────────────
      // Fire-and-forget — NEVER blocking, never modifies execution
      if (this.metaSelector && this.config.strategyKey) {
        const _msIndicators = {
          ema9:   indicators.emaFast?.[lastIdx]  ?? null,
          ema21:  indicators.emaSlow?.[lastIdx]  ?? null,
          ema50:  indicators.emaTrend?.[lastIdx] ?? null,
          atr:    indicators.atr?.[lastIdx]      ?? null,
          atrAvg: indicators.atr?.slice(Math.max(0, lastIdx - 19), lastIdx + 1)
                    .filter(v => v != null)
                    .reduce((s, v, _, a) => s + v / a.length, 0) || null,
          volume: indicators.volumes?.[lastIdx]  ?? null,
          volAvg: indicators.volSMA?.[lastIdx]   ?? null,
        };
        this.metaSelector.recommend(
          this.config.symbol,
          _msIndicators,
          [this.config.strategyKey],
        ).catch(() => {});
      }

      if (this.config.strategyKey === "GROK_AI_TRADING") {
        await this._tickGrokAi(price, indicators, lastIdx, htfCandlesCache);
      } else if (this.config.legacyMonitorOnly) {
        if (this._shouldLogDecision()) {
          this._log("info", "⏸ Legacy monitor-only — tidak buka posisi baru");
        }
      } else if (this.state.openPositions.length < this.config.maxPositions) {
        // ── STEP 1: Risk gates (daily loss, cooldown, max trades, ATR, HTF) ──
        const atrLegOv = resolveAtrLegOverride(this.config, null);
        const atrBaselineArr = atrLegOv.atrGateRelative === true || this.config.atrGateRelative === true
          ? buildAtrBaseline(indicators.atr)
          : null;
        const atrBaselineNow = atrBaselineArr?.[lastIdx] ?? null;
        const atrGateCfg = {
          ...this.config,
          ...atrLegOv,
          atrBaseline: atrBaselineNow,
          _atrBaseline: atrBaselineNow,
        };
        const gate = this._checkRiskGates(atr, price, atrGateCfg);
        if (!gate.ok) {
          if (this._shouldLogDecision()) {
            this._log("info", `⏸ Belum entry — ${gate.reason}`);
          }
        } else {
          // Legacy PDF sideways only — modern strategies proceed via STEP 2b (mirror AdaptiveStrategyEngine).
          const useLegacySideways = this.state.htfTrend === "SIDEWAYS"
            && LEGACY_PDF_SIDEWAYS_SIGNAL_TYPES.has(this.config.signalType);
          if (useLegacySideways) {
            // ── STEP 2a: SIDEWAYS — PDF Strat A/B/C ───
            await this._checkSidewaysEntry(htfCandlesCache, price, atr, indicators, lastIdx, emaF, emaS, emaTrend, rsi);
          } else {
            // ── STEP 2b: TRENDING — sinyal trend-following normal ───────────────
            // Hitung volatility & trend_strength untuk AFS component ranking (#BugA).
            // Tanpa ini AFS menerima default (volatility=1, trend_strength=0.1) → komponen
            // dipilih berdasarkan asumsi "dead market" bukan kondisi market nyata.
            const atrPctNow = atr && price ? (atr / price) * 100 : 1.0;
            const emaDelta  = emaS > 0 ? Math.abs(emaF - emaS) / emaS : 0;
            const trendStr  = Math.min(emaDelta * 50, 1.0); // normalisasi 0–1

            let htfTrendStrength = null;
            if (htfCandlesCache?.length >= 30) {
              const hLast = htfCandlesCache.length - 1;
              const hCloses = htfCandlesCache.map(c => c.close);
              const hHighs = htfCandlesCache.map(c => c.high);
              const hLows = htfCandlesCache.map(c => c.low);
              const hEmaF = calcEMA(hCloses, this.config.htfEmaFast)[hLast];
              const hEmaS = calcEMA(hCloses, this.config.htfEmaSlow)[hLast];
              const hAtr = calcATR(hHighs, hLows, hCloses, this.config.atrPeriod || 14)[hLast];
              if (hAtr > 0) htfTrendStrength = Math.min(Math.abs(hEmaF - hEmaS) / hAtr, 1.0);
              // TS structure gate reads highsHTF/lowsHTF + htfIdx (closed HTF bar).
              indicators.highsHTF = hHighs;
              indicators.lowsHTF = hLows;
              indicators.closesHTF = hCloses;
            }

            const signal = detectSignal(indicators, lastIdx, {
              ...this.config,
              rsiOverbought:    this.config.rsiOverbought,
              rsiOversold:      this.config.rsiOversold,
              rsiLongMin:       this.config.rsiLongMin,
              rsiLongMax:       this.config.rsiLongMax,
              rsiShortMin:      this.config.rsiShortMin,
              rsiShortMax:      this.config.rsiShortMax,
              useBothSides:     this.config.useBothSides,
              signalType:       this.config.signalType,
              volSmaMultiplier: this.config.volSmaMultiplier,
              symbol:           this.config.symbol,
              // AFS: kondisi market nyata agar komponen dipilih dengan benar
              volatility:       atrPctNow,
              trend_strength:   trendStr,
              balance:          this.state.capital,

              // alignment, anti-chase, dan SL komponen-C (VOLATILE) aktif live.
              afMinVotes:           this.config.afMinVotes,
              afRejectOnDissent:    this.config.afRejectOnDissent,
              maxEntryExtensionATR: this.config.maxEntryExtensionATR,
              htfTrend:             this.state.htfTrend,
              htfTrendStrength,
              htfTrendStrengthMin:  this.config.htfTrendStrengthMin,
              pairTier:             this.config.pairTier,
              tierOverrides:        this.config.tierOverrides,
              htfIdx: htfCandlesCache?.length >= 30 ? htfCandlesCache.length - 1 : undefined,
              tsCombinationMode:    this.config.tsCombinationMode || "race",
              tsUseStructureGate:   this.config.tsUseStructureGate,
              tsUseVwapPrecision:   this.config.tsUseVwapPrecision,
              vwapAtrMult:          this.config.vwapAtrMult,
              selectedComponents:   this.config.selectedComponents || this.config.activeStrategyComponents,
              dailyRegime:          this.state.dailyRegime,
            });


            // MR tanpa filter akan counter-trend terus saat strong bull/bear →
            // SL beruntun → daily loss limit. Blokir SHORT di strong bull dan
            // LONG di strong bear, juga saat ATR HTF spike. Fail-open bila HTF
            // tidak bisa diambil (konsisten dgn HTF trend filter di bawah).
            let mrSignal = signal;
            if (signal && (isMeanReversionKey(this.config.strategyKey) || isMeanReversionKey(this.config.signalType))) {
              try {
                const htf = htfCandlesCache || await this._fetchHtfCandles();
                if (htf && htf.length >= 30) {
                  const hCloses = htf.map(c => c.close);
                  const hHighs  = htf.map(c => c.high);
                  const hLows   = htf.map(c => c.low);
                  const lastNN  = (a) => { for (let k = a.length - 1; k >= 0; k--) if (a[k] != null) return a[k]; return null; };
                  const atrArr  = calcATR(hHighs, hLows, hCloses, 14);
                  const htfData = {
                    emaFast:     lastNN(calcEMA(hCloses, 9)),
                    emaSlow:     lastNN(calcEMA(hCloses, 21)),
                    rsi:         lastNN(calcRSI(hCloses, 14)),
                    close:       hCloses[hCloses.length - 1],
                    atr:         lastNN(atrArr),
                    atrBaseline: lastNN(calcSMA(atrArr.map(v => (v == null ? 0 : v)), 20)),
                  };
                  const regimeCheck = meanReversionRegimeFilter({ direction: signal, htfData });
                  if (!regimeCheck.allowed) {
                    mrSignal = null;
                    this._log("info", `[MR] Entry diblokir (${regimeCheck.regime}): ${regimeCheck.reason}`);
                  }
                }
              } catch (e) {
                this._log("warn", `[MR] HTF regime check gagal — fail-open: ${e.message}`);
              }
            }

            // ── STEP 3: HTF trend filter (HTF_Mode SSOT) ───────────────────────
            // REQUIRED_ALIGN: hard directional block. CONTEXT_ONLY / SOFT_BIAS /
            // REGIME_GATE: no engine 7a — strategy-internal scoring/gates apply.
            const htfModeKey = normalizeStrategyKey(this.config.signalType)
              || normalizeStrategyKey(this.config.strategyKey);
            let filteredSignal = mrSignal;
            if (mrSignal) {
              if (
                this.config.higherTf
                && this.state.htfTrend === "UNKNOWN"
                && requiresHtfFailClosed(htfModeKey)
              ) {
                filteredSignal = null;
                if (this._shouldLogDecision()) {
                  this._log("info", `⛔ Sinyal dibatalkan — data tren ${this.config.higherTf} tidak tersedia (fail-closed demi keamanan)`);
                }
              } else if (shouldBlockHtfDirectional(htfModeKey, mrSignal, this.state.htfTrend)) {
                filteredSignal = null;
                this._log("info", `[HTF] ${mrSignal} diblok — ${this.config.higherTf} ${this.state.htfTrend} (REQUIRED_ALIGN)`);
              }
            }

            // ── STEP 3b: Anti-churn — tolak setup identik dengan loss terakhir ──
            // Data dry-run 11-12 Jun: 3 klaster re-entry pada side+harga entry yang
            // sama persis setelah SL (candle sama, sinyal basi) → loss duplikat.
            // Signature direkam di _updateRiskAfterClose; candle baru → harga close
            // berbeda → guard otomatis lolos.
            if (filteredSignal && this.state.lastLossSetup === `${filteredSignal}@${price}`) {
              this._log("info", `[CHURN] Entry diblok — setup identik dengan loss terakhir (${filteredSignal} @ $${price}); tunggu candle baru`);
              filteredSignal = null;
            }

            // ── MULTI-POSITION MODE (v3.0): ADAPTIVE_FUSION independent components ──
            // Sprint 8: use AdaptiveFusionUmbrella (SMC + Wyckoff + VSA voting).
            if (this.config.strategyKey === "ADAPTIVE_FUSION" && this.state.positions) {
              const { strategyRegistry } = require("../../../core/strategy-engine/index");
              let afInstance = strategyRegistry.get("SMART_MONEY_CONCEPTS");
              if (!afInstance || typeof afInstance.detectSignalMulti !== "function") {
                const AdaptiveFusionUmbrella = require("../../../core/strategy-engine/umbrellas/AdaptiveFusionUmbrella");
                afInstance = new AdaptiveFusionUmbrella();
              }
              const multiSignal = afInstance.detectSignalMulti(indicators, lastIdx, {
                ...this.config,
                volatility:           atrPctNow,
                trend_strength:       trendStr,
                balance:              this.state.capital,
                afRejectOnDissent:    this.config.afRejectOnDissent,
                maxEntryExtensionATR: this.config.maxEntryExtensionATR,
                htfTrend:             this.state.htfTrend,
                htfTrendStrength,
                htfTrendStrengthMin:  this.config.htfTrendStrengthMin,
                pairTier:             this.config.pairTier,
                symbol:               this.config.symbol,
                tierOverrides:        this.config.tierOverrides,
                volSmaMultiplier:     this.config.volSmaMultiplier,
                afEnabledComponents:  this.config.afEnabledComponents,
                afMinComponentConfidence: this.config.afMinComponentConfidence,
                afMinAggregateConfidence: this.config.afMinAggregateConfidence,
                afUseThreeComponentVoting: this.config.afUseThreeComponentVoting,
                afCombinationMode:    this.config.afCombinationMode,
                afMinVotes:           this.config.afMinVotes,
                selectedComponents:   this.config.selectedComponents || this.config.activeStrategyComponents,
                afActiveRacers:       this.config.afActiveRacers || this.config.afActiveVoters,
                typeOverrides:        this.config.typeOverrides,
                candleTimestamp:      Date.now(),
                dailyRegime:          this.state.dailyRegime,
              });
              // Persist vote breakdown onto indicator snapshot for entryContext
              if (multiSignal?.meta?.afVotes || multiSignal?.meta?.signalComponents || multiSignal?.meta?.afRace) {
                indicatorSnapshot.signalComponents = multiSignal.meta.signalComponents
                  || multiSignal.meta.afVotes?.breakdown
                  || {};
                indicatorSnapshot.afVotes = multiSignal.meta.afVotes || null;
                indicatorSnapshot.afRace = multiSignal.meta.afRace || null;
                if (multiSignal.meta.winningComponent) {
                  indicatorSnapshot.winningComponent = multiSignal.meta.winningComponent;
                  indicatorSnapshot.strategyLabel = multiSignal.meta.strategyLabel || null;
                }
              }

              // Check each component independently for entry
              // Direction lock across A/B/C: first open component locks direction for the tick.
              let lockedDirection = null;
              for (const [, openPos] of this.state.positions) {
                if (openPos?.side) { lockedDirection = openPos.side; break; }
              }
              for (const componentId of ["A", "B", "C"]) {
                const componentSignal = multiSignal[componentId];
                if (!componentSignal) continue;

                // Check if this component already has an open position
                if (this.state.positions.has(componentId)) {
                  continue; // Component already trading
                }

                // Cross-component hedge guard (legacy AF multi-position path)
                if (lockedDirection && componentSignal !== lockedDirection) {
                  this._log("info",
                    `[Multi-AF:${componentId}] ${componentSignal} ditolak — komponen lain sudah ${lockedDirection}`
                  );
                  continue;
                }

                // Check component-level risk gates
                const compCooldown = this.state.componentCooldown.get(componentId);
                if (compCooldown && Date.now() < compCooldown) {
                  continue; // Component in cooldown
                }

                const compConsecLoss = this.state.componentConsecLoss.get(componentId) || 0;
                if (compConsecLoss >= this.config.maxConsecLoss) {
                  continue; // Component exceeded max consecutive loss
                }

                // Multi-position entry (pass the real regime so strong-trend TP can fire)
                await this._handleMultiPositionSignal(componentId, componentSignal, price, atr, indicators, lastIdx, indicatorSnapshot, multiSignal.meta?.marketCond, multiSignal.meta?.confidence?.[componentId]);
                if (this.state.positions.has(componentId)) {
                  lockedDirection = componentSignal;
                }
              }
              // Skip single-position logic below for AF in multi-position mode
              return;
            }

            if (filteredSignal && filteredSignal !== this.state.lastSignal) {
              const vol    = indicators.volumes[lastIdx]  ?? 0;
              const volSMA = indicators.volSMA[lastIdx]   ?? 1;
              const indicatorSnapshot = {
                rsi:          rsi     != null ? parseFloat(rsi.toFixed(2))   : null,
                atr:          atr     != null ? parseFloat(atr.toFixed(4))   : null,
                atrPct:       atr && price ? parseFloat(((atr / price) * 100).toFixed(3)) : null,
                emaFast:      emaF    != null ? parseFloat(emaF.toFixed(4))  : null,
                emaSlow:      emaS    != null ? parseFloat(emaS.toFixed(4))  : null,
                emaTrendVal:  emaTrend != null ? parseFloat(emaTrend.toFixed(4)) : null,
                emaTrendBias: emaTrend != null ? (price > emaTrend ? "bullish" : "bearish") : null,
                volumeRatio:  volSMA > 0 ? parseFloat((vol / volSMA).toFixed(2)) : null,
                htfTrend:     this.state.htfTrend ?? null,
                strategy:     this.config.strategyKey ?? null,
              };

              // P1: For ADAPTIVE_FUSION, use component-aware SL/TP
              let signalOptions = {};
              if (this.config.signalType === "ADAPTIVE_FUSION") {
                const meta = getAdaptiveFusionMeta();
                if (meta) {
                  const SmartMoneyConceptsStrategy = require("../../../core/strategy-engine/implementations/SmartMoneyConceptsStrategy");
                  const afsInstance = new SmartMoneyConceptsStrategy();
                  const riskCfg = afsInstance.calculateRiskConfig(price, atr, filteredSignal, meta.component, {
                    marketCond: meta.marketCond,
                    strongTrendTPMult: this.config.strongTrendTPMult ?? 1,
                  });
                  signalOptions.slDist = riskCfg.slDistance;
                  signalOptions.tpDist = riskCfg.tpDistance;
                  if (meta.marketCond === "STRONG_TREND" && this.config.riskPerTradeStrong > 0) {
                    signalOptions.riskPerTrade = this.config.riskPerTradeStrong;
                  }
                  indicatorSnapshot.afComponent  = meta.component;
                  indicatorSnapshot.afVotes      = meta.votes;
                  indicatorSnapshot.afMarketCond = meta.marketCond;
                  indicatorSnapshot.afConfidence = meta.componentConfidence ?? null;
                  indicatorSnapshot.afAggregateConfidence = meta.aggregateConfidence ?? null;
                  const tpMultNote = riskCfg.strongTrendTPApplied
                    ? ` | TP×${this.config.strongTrendTPMult} (STRONG_TREND)`
                    : "";
                  const confNote = meta.aggregateConfidence != null ? ` | Conf ${meta.aggregateConfidence}%` : "";
                  this._log("info",
                    `[AF] Component: ${meta.component} | Votes: ${JSON.stringify(meta.votes)} | ` +
                    `RR 1:${riskCfg.riskReward} | SL×${riskCfg.slMultiplier} TP×${riskCfg.tpMultiplier}${tpMultNote}${confNote}`
                  );
                }
              } else if (normalizeStrategyKey(this.config.signalType) === "BREAKOUT_RETEST") {
                const brInstance = getBreakoutRetestInstance();
                const brMeta = getBreakoutRetestMeta() || {};
                const riskCfg = brInstance.calculateRiskConfig(price, atr, filteredSignal, {
                  breakoutLevel: brMeta.breakoutLevel,
                  retestExtreme: brMeta.retestExtreme,
                });
                signalOptions.slDist = riskCfg.slDistance;
                signalOptions.tpDist = riskCfg.tpDistance;
                // RR slippage: default full TP; if user force-partial, cap first take to 33%
                signalOptions.tpMode = riskCfg.preferredTpMode || this.config.tpMode || "full";
                if (signalOptions.tpMode === "partial") {
                  signalOptions.slPlusPartial1Pct = riskCfg.slPlusPartial1Pct ?? 0.33;
                }
                indicatorSnapshot.entryMode = "breakout_retest";
                indicatorSnapshot.breakoutLevel = brMeta.breakoutLevel ?? null;
                indicatorSnapshot.retestExtreme = brMeta.retestExtreme ?? null;
                indicatorSnapshot.barsSinceBreakout = brMeta.barsSinceBreakout ?? null;
                applyBsBrSnapshotFields(indicatorSnapshot, brMeta);
                this._log("info",
                  `[BR] RR 1:${riskCfg.riskReward} | SL×${riskCfg.slMultiplier} TP×${riskCfg.tpMultiplier}` +
                  ` | wait ${brMeta.barsSinceBreakout ?? "?"} bars | tpMode ${signalOptions.tpMode}`
                );
              }

              if (signalOptions.slDist == null) {
                signalOptions.slDist = atr * this.config.atrMultiplier;
              }
              if (signalOptions.tpDist == null) {
                signalOptions.tpDist = signalOptions.slDist * this.config.riskReward;
              }

              const grokGate = await this._applyGrokConfirmGate(
                filteredSignal, price, atr, indicatorSnapshot, signalOptions
              );
              if (!grokGate.signal) {
                filteredSignal = null;
              } else {
                filteredSignal = grokGate.signal;
                signalOptions = grokGate.signalOptions;
              }


              // Cegah dua posisi terbuka untuk sinyal yang sama bila tick/candle
              // diproses dua kali (mis. polling overlap atau WS reconnect).
              // Key = symbol + strategy + candleOpenTime + direction (TTL 5 menit).
              const candleOpenTime = candles[lastIdx].timestamp ?? candles[lastIdx].openTime;
              const dup = isDuplicate({
                symbol:         this.config.symbol,
                strategy:       this.config.strategyKey,
                candleOpenTime,
                direction:      filteredSignal,
              });

              if (dup) {
                this._log("warn", `Duplicate signal dibuang — ${filteredSignal} @candle ${candleOpenTime}`);
              } else {
                await this._handleSignal(filteredSignal, price, atr, indicatorSnapshot, signalOptions);
                this.state.lastSignal = filteredSignal;
              }
            } else if (!filteredSignal) {
              this.state.lastSignal = null;
              // ── Diagnostic: log kenapa belum ada entry (throttle 3 menit) ──────
              if (this._shouldLogDecision()) {
                this._logNoEntryDiagnostic(indicators, lastIdx, { emaF, emaS, emaTrend, rsi, atr, price });
              }
            }
          }
        }
      }

      this.state.errors = 0;

      // Refresh capital dari exchange setiap 5 menit (live mode)
      // Pakai equity total (bukan available) agar grafik tidak anjlok saat posisi terbuka
      if (!this.config.dryRun && this.state.checkCount % 5 === 0) {
        try {
          const bal = await this.client.getBalance(this.config.marginCoin);
          const totalEquity = bal.equity > 0 ? bal.equity : bal.available;
          if (totalEquity > 0) this.state.capital = totalEquity;
        } catch { /* silent — pakai nilai sebelumnya */ }
      }

      // Snapshot equity ke DB setiap 5 ticks (throttle — bukan setiap tick)
      // Strat A (30s): 576 row/hari per bot vs 2880 sebelumnya
      if (this.sessionId && this.state.checkCount % 5 === 0) {
        try {
          db.snapshotEquity({
            sessionId:     this.sessionId,
            capital:       this.state.capital,
            price,
            openPositions: this.state.openPositions.length,
          });
        } catch { /* jangan crash karena snapshot error */ }
      }

      this.emit("status", this.getState());

    } catch (err) {
      this.state.errors++;
      this._log("error", `Tick error (${this.state.errors}/10): ${err.message}`);
      // Naikkan threshold 5 → 10 dan jangan stop permanen — skip tick saja
      if (this.state.errors >= 10) {
        this._log("error", "10 error berturut-turut — skip 2 menit, lanjut otomatis.");
        this.state.errors = 0; // reset agar bot tidak mati permanen
        await new Promise(r => setTimeout(r, 120_000)); // tunggu 2 menit
      }
    } finally {
      // Selalu lepas guard re-entrancy, termasuk setelah backoff 120s di atas.
      this._ticking = false;
    }
  }

  // ─────────────────────────────────────────────
  // FETCH CANDLES — dengan cache DB
  // ─────────────────────────────────────────────
  async _fetchCandles() {
    const minBars = this.config.emaSlow + 20;
    const timeframe = this.config.interval.toLowerCase();

    try {
      return await fetchCandlesWithCache(this.client, {
        exchange:         this.config.exchange,
        symbol:           this.config.symbol,
        interval:         timeframe,
        limit:            200,
        cacheTtlSeconds:  LTF_CACHE_TTL,
        minBars,
      });
    } catch (err) {
      // THROTTLE (anti DB-storm): saat exchange DOWN, tiap tick gagal → tiap _log warn
      // memicu DUA tulisan DB (persistBotLog Prisma + insertLog pg pool). Dikali N bot ×
      // tiap tick = badai koneksi yang menguras pool Postgres (akar insiden "insertLog
      // gagal: timeout" + login timeout). Coalesce: hanya log sekali per 60s selama
      // kegagalan beruntun, sertakan hitungan agar tetap terlihat.
      const nowTs = Date.now();
      this._candleFailStreak = (this._candleFailStreak || 0) + 1;
      const throttleMs = 60_000;
      if (!this._lastCandleFailLogTs || nowTs - this._lastCandleFailLogTs >= throttleMs) {
        const streak = this._candleFailStreak;
        this._lastCandleFailLogTs = nowTs;
        this._candleFailStreak = 0;
        this._log(
          isRateLimitError(err) ? "info" : "warn",
          `Gagal ambil candles dari exchange${streak > 1 ? ` (${streak}× dalam 60s)` : ""}: ${err.message}`
        );
      }
    }

    // Fallback simulasi — coba ambil harga terkini dulu via ticker (juga public),
    //    sehingga ATR / SL / TP simulasi tetap proporsional dengan harga nyata.
    let seedPrice = null;
    try {
      const ticker = await this.client.getTicker(this.config.symbol);
      if (ticker?.last && ticker.last > 0) {
        seedPrice = ticker.last;
        this._log("info", `Simulasi candle — seed price dari ticker: $${seedPrice.toLocaleString()}`);
      }
    } catch { /* ticker juga gagal — gunakan harga hardcode sebagai last resort */ }

    return this._generateDryRunCandles(seedPrice);
  }

  /** Daily regime cache — ADX-proxy on 1d candles (parity with RealStrategyBacktestService). */
  async _refreshDailyRegime(timestamp) {
    try {
      const dailyCandles = await fetchCandlesWithCache(this.client, {
        exchange:        this.config.exchange,
        symbol:          this.config.symbol,
        interval:        "1d",
        limit:           120,
        cacheTtlSeconds: HTF_CACHE_TTL,
        minBars:         30,
      });
      if (!dailyCandles?.length) {
        this.state.dailyRegime = "UNKNOWN";
        return;
      }
      const dailyTrend = computeDailyTrendStrength({
        close: dailyCandles.map((c) => c.close),
        high: dailyCandles.map((c) => c.high),
        low: dailyCandles.map((c) => c.low),
      });
      const dateMap = new Map();
      for (let i = 0; i < dailyCandles.length; i++) {
        dateMap.set(new Date(dailyCandles[i].timestamp).toISOString().split("T")[0], i);
      }
      this._dailyTrendCache = { dailyTrend, dateMap };
      const entryDate = new Date(timestamp).toISOString().split("T")[0];
      this.state.dailyRegime = getRegimeForDate(entryDate, this._dailyTrendCache);
    } catch {
      this.state.dailyRegime = "UNKNOWN";
    }
  }

  /** HTF candles dengan cache DB (10 menit) — hindari fetch tiap tick / tiap strategi. */
  async _fetchHtfCandles() {
    if (!this.config.higherTf) return null;
    const limit = Math.max(this.config.htfEmaSlow + 10, 50);
    const minBars = Math.max(this.config.htfEmaSlow + 5, 30);
    try {
      return await fetchCandlesWithCache(this.client, {
        exchange:        this.config.exchange,
        symbol:          this.config.symbol,
        interval:        this.config.higherTf,
        limit,
        cacheTtlSeconds: HTF_CACHE_TTL,
        minBars,
      });
    } catch {
      return null;
    }
  }

  /** Multi-TF candles untuk Grok AI prompt builder. */
  async _fetchMultiTfCandles(timeframes = ["1m", "5m", "15m", "30m", "1h", "4h"]) {
    const out = {};
    await Promise.all(
      timeframes.map(async (tf) => {
        try {
          const candles = await fetchCandlesWithCache(this.client, {
            exchange:        this.config.exchange,
            symbol:          this.config.symbol,
            interval:        tf,
            limit:           200,
            cacheTtlSeconds: tf === "1m" || tf === "5m" ? LTF_CACHE_TTL : HTF_CACHE_TTL,
            minBars:         30,
          });
          if (candles?.length) out[tf] = candles;
        } catch { /* skip TF */ }
      })
    );
    return out;
  }

  /**
   * Siklus Grok AI — evaluasi posisi terbuka + entry baru dengan TP/SL eksplisit.
   */
  async _tickGrokAi(price, indicators, lastIdx, htfCandlesCache) {
    const cycleMs = cfg.GROK_TRADING_CYCLE_MS;
    const now = Date.now();
    if (this._lastGrokCallAt && now - this._lastGrokCallAt < cycleMs) {
      return;
    }

    const atr = indicators.atr[lastIdx];
    const gate = this._checkRiskGates(atr, price);

    let multiTfCandles = {};
    try {
      multiTfCandles = await this._fetchMultiTfCandles(["1m", "5m", "15m", "30m", "1h", "4h"]);
    } catch (err) {
      this._log("warn", `[GROK] Gagal fetch multi-TF: ${err.message}`);
    }

    const grokCtx = {
      symbol: this.config.symbol,
      price,
      indicators,
      lastIdx,
      multiTfCandles,
      htfCandles: htfCandlesCache,
      minConfidenceEntry: this.config.minConfidenceEntry ?? cfg.GROK_TRADING_MIN_CONFIDENCE_ENTRY,
      minConfidenceTpSl:  this.config.minConfidenceTpSl  ?? cfg.GROK_TRADING_MIN_CONFIDENCE_TP_SL,
      atrMinMult:         this.config.atrMinMult ?? 1.0,
      minRiskReward:      this.config.minRiskReward ?? 1.2,
      atr,
      leverage:           this.config.leverage,
      riskPerTrade:       this.config.riskPerTrade,
      maxConcurrentPositions: this.config.maxPositions,
      account: {
        balance: this.state.capital,
        openPositions: this.state.openPositions.map(p => ({
          side: p.side, entry: p.entry, sl: p.sl, tp: p.tp,
        })),
        unrealizedPnl: this.state.openPositions.reduce((s, p) => s + (p.unrealizedPL || 0), 0),
      },
      hasOpenPosition: this.state.openPositions.length > 0,
      botId: this.config.botId,
      userId: this.config.userId,
    };

    this._lastGrokCallAt = now;

    if (this.state.openPositions.length > 0) {
      const pos = this.state.openPositions[0];
      try {
        const action = await GrokTradingService.requestPositionAction({ ...grokCtx, position: pos });
        if (action?.action === "CLOSE") {
          this._log("trade", `[GROK] Tutup posisi — ${action.reasoning || "AI decision"}`);
          await this._closePosition("GROK_AI_DECISION", price);
          return;
        }
      } catch (err) {
        this._log("error", `[GROK] Evaluasi posisi gagal: ${err.message}`);
      }
    }

    if (this.state.openPositions.length >= this.config.maxPositions) return;
    if (!gate.ok) {
      if (this._shouldLogDecision()) {
        this._log("info", `[GROK] Belum entry — ${gate.reason}`);
      }
      return;
    }

    try {
      const decision = await GrokTradingService.requestTradeDecision(grokCtx);
      if (!decision || !decision.valid) {
        if (decision?.rejected) {
          this._log("info", `[GROK] Sinyal ditolak — ${decision.rejected}`);
        }
        return;
      }

      if (!decision.entryAllowed) {
        this._log("info",
          `[GROK] TP/SL valid (conf ${decision.confidence}) — entry ditolak, perlu conf >= ${grokCtx.minConfidenceEntry}`
        );
        return;
      }

      const logLine =
        `[GROK] ${decision.side} ${this.config.symbol} | conf ${decision.confidence}/10 | ` +
        `TP ${decision.take_profit} | SL ${decision.stop_loss}` +
        (decision.reasoning ? ` | ${decision.reasoning}` : "");
      this._log("trade", logLine);

      const grokDryRun = this.config.dryRun || cfg.GROK_TRADING_DRY_RUN;
      if (grokDryRun) {
        this._log("info",
          `[GROK DRY-RUN] ${decision.side} conf=${decision.confidence} TP=${decision.take_profit} SL=${decision.stop_loss}`
        );
        return;
      }

      await this._openPositionWithExplicitTpSl(decision, price, atr);
    } catch (err) {
      this._log("error", `[GROK] Request trade gagal: ${err.message}`);
    }
  }

  /**
   * Buka posisi dengan TP/SL absolut dari respons Grok (bukan ATR×RR default).
   */
  async _openPositionWithExplicitTpSl(decision, price, atr) {
    const { side, take_profit, stop_loss, confidence, reasoning } = decision;
    const slDist = Math.abs(price - stop_loss);
    const tpDist = Math.abs(take_profit - price);

    const indicatorSnapshot = {
      source: "GROK_AI",
      confidence,
      reasoning,
      grokTp: take_profit,
      grokSl: stop_loss,
      htfTrend: this.state.htfTrend ?? null,
      strategy: this.config.strategyKey,
      atr: atr != null ? parseFloat(Number(atr).toFixed(4)) : null,
    };

    await this._handleSignal(side, price, atr, indicatorSnapshot, { slDist, tpDist });
  }

  /**
   * Mode B — Grok Confirm Gate: konfirmasi entry + optional TP adjust (SL tetap rules).
   * @returns {{ signal: string|null, signalOptions: object }}
   */
  async _applyGrokConfirmGate(signal, price, atr, indicatorSnapshot, signalOptions) {
    const noop = { signal, signalOptions };

    if (
      !signal ||
      !cfg.GROK_CONFIRM_ENABLED ||
      !this.config.grokConfirmEnabled ||
      this.config.strategyKey === "GROK_AI_TRADING" ||
      !GROK_CONFIRM_STRATEGIES.has(this.config.strategyKey)
    ) {
      return noop;
    }

    const slDist = signalOptions.slDist;
    const tpDist = signalOptions.tpDist;
    const slPrice = signal === "LONG" ? price - slDist : price + slDist;
    const tpRules = signal === "LONG" ? price + tpDist : price - tpDist;

    let signalReason = "";
    if (indicatorSnapshot.afComponent) {
      signalReason =
        `Component ${indicatorSnapshot.afComponent}, votes ${JSON.stringify(indicatorSnapshot.afVotes ?? {})}, ` +
        `marketCond ${indicatorSnapshot.afMarketCond ?? "N/A"}`;
    }

    try {
      const confirm = await GrokConfirmService.requestConfirmation({
        symbol: this.config.symbol,
        strategyKey: this.config.strategyKey,
        side: signal,
        price,
        atr,
        sl_rules: slPrice,
        tp_rules: tpRules,
        indicatorSnapshot,
        htfTrend: this.state.htfTrend,
        signalReason,
        minConfidenceEntry: this.config.grokConfirmMinEntry ?? cfg.GROK_CONFIRM_MIN_CONFIDENCE_ENTRY,
        minTpConfidence: this.config.grokConfirmMinTp ?? cfg.GROK_CONFIRM_MIN_TP_CONFIDENCE,
        userId: this.config.userId,
        botId: this.config.botId,
      });

      if (confirm.failOpen) {
        this._log("warn", `[GROK CONFIRM] API error — fail-open, lanjut dengan SL/TP rules`);
        return noop;
      }

      if (!confirm?.confirm_entry) {
        this._log("info",
          `[GROK CONFIRM] REJECT entry — conf ${confirm?.confidence ?? 0}/10` +
          (confirm?.reasoning ? ` | ${confirm.reasoning}` : "")
        );
        return { signal: null, signalOptions };
      }

      const tpRejectAction = this.config.grokConfirmTpRejectAction ?? cfg.GROK_CONFIRM_TP_REJECT_ACTION;

      if (!confirm.tp_approved && tpRejectAction === "skip") {
        this._log("info",
          `[GROK CONFIRM] REJECT TP — ${confirm.tp_reasoning || "not approved"}`
        );
        return { signal: null, signalOptions };
      }

      let finalTp = tpRules;
      const useGrokTp = this.config.grokConfirmTpAdjust !== false &&
        confirm.tp_approved &&
        confirm.suggested_tp != null &&
        Number.isFinite(confirm.suggested_tp);

      if (useGrokTp) {
        finalTp = GrokConfirmService.resolveTakeProfit({
          tpRules,
          suggestedTp: confirm.suggested_tp,
          side: signal,
          price,
          atr,
          bandPct: this.config.grokConfirmTpBandPct ?? cfg.GROK_CONFIRM_TP_ADJUST_BAND_PCT,
          maxAtrMult: cfg.GROK_CONFIRM_TP_MAX_ATR_MULT,
        });
      } else if (!confirm.tp_approved && tpRejectAction === "use_rules_tp") {
        finalTp = tpRules;
      }

      const rrCheck = GrokConfirmService.validateRiskReward({
        side: signal,
        price,
        slPrice,
        tpPrice: finalTp,
        minRiskReward: this.config.minRiskReward ?? 1.2,
      });
      if (!rrCheck.valid) {
        this._log("info",
          `[GROK CONFIRM] REJECT — R:R ${rrCheck.riskReward} < min setelah TP adjust`
        );
        return { signal: null, signalOptions };
      }

      const nextOptions = {
        ...signalOptions,
        tpDist: Math.abs(finalTp - price),
        tpMode: confirm.tp_mode ?? "full",
      };

      const tpModeLabel = (confirm.tp_mode ?? "full") === "partial" ? "Partial TP" : "Full TP";
      const tpNote = finalTp !== tpRules
        ? `TP ${tpRules.toFixed(2)}→${finalTp.toFixed(2)} (Grok adjust)`
        : `TP ${finalTp.toFixed(2)} (rules)`;

      // Detail Grok masuk kartu ENTRY terpadu — bukan log INFO terpisah (UX Bot Logs).
      indicatorSnapshot.grokConfirm = {
        confidence: confirm.confidence,
        tp_confidence: confirm.tp_confidence,
        tp_mode: confirm.tp_mode,
        tp_mode_confidence: confirm.tp_mode_confidence,
        reasoning: confirm.reasoning,
        tp_reasoning: confirm.tp_reasoning,
        tp_rules: tpRules,
        tp_final: finalTp,
        sl_rules: slPrice,
        tp_mode_label: tpModeLabel,
        tp_note: tpNote,
      };

      return { signal, signalOptions: nextOptions };
    } catch (err) {
      if (cfg.GROK_CONFIRM_FAIL_MODE === "open") {
        this._log("warn", `[GROK CONFIRM] Error — fail-open: ${err.message}`);
        return noop;
      }
      this._log("error", `[GROK CONFIRM] Error — skip trade: ${err.message}`);
      return { signal: null, signalOptions };
    }
  }

  /**
   * Tutup posisi terbuka pertama (market) — dipakai Grok position_actions CLOSE.
   */
  async _closePosition(reason = "MANUAL", exitPrice = null) {
    const pos = this.state.openPositions[0];
    if (!pos) return;

    const price = exitPrice ?? this.state.lastPrice ?? pos.entry;
    const remaining = pos.remainingSize > 0 ? pos.remainingSize : pos.size;

    if (!this.config.dryRun) {
      try {
        const closeSide = pos.side === "LONG" ? "close_long" : "close_short";
        await this.client.closePosition(this.config.symbol, closeSide, remaining);
      } catch (err) {
        this._log("error", `[GROK] Gagal tutup posisi: ${err.message}`);
        return;
      }
    }

    const pnl = pos.side === "LONG"
      ? (price - pos.entry) * remaining
      : (pos.entry - price) * remaining;
    const pnlPct = pos.entry > 0
      ? ((price - pos.entry) / pos.entry) * 100 * (pos.side === "LONG" ? 1 : -1)
      : 0;
    const fee = await this._resolveFee(pos, price, remaining);

    if (this.config.dryRun) {
      const marginBack = pos.marginReserved != null
        ? pos.marginReserved
        : pos.entry * remaining * this.config.riskPerTrade;
      this.state.capital += pnl - fee + marginBack;
    }

    if (this.sessionId && pos.dbId) {
      try {
        await this._closeTradeInDb(pos, {
          exitPrice: price,
          pnl,
          pnlPct,
          fee,
          reason,
          closeTime: new Date().toISOString(),
        });
        onEngineTradeClose(pos.dbId, pnl);
      } catch (err) {
        this._log("warn", `Gagal tutup trade #${pos.dbId} di DB: ${err.message}`);
      }
    }

    this._log("trade",
      `[GROK] Posisi ditutup (${reason}) ${pos.side} @ $${fmtPx(price)} | Net ${pnl - fee >= 0 ? "+" : ""}$${(pnl - fee).toFixed(2)}`
    );

    this._notifyClose({
      symbol:     this.config.symbol,
      side:       pos.side,
      entryPrice: pos.entry,
      exitPrice:  price,
      pnl,
      pnlPct,
      reason,
      dryRun:     this.config.dryRun,
    });

    this.state.trades.push({ ...pos, size: remaining, exit: price, pnl, pnlPct, fee, reason, closedAt: Date.now() });
    this._capTrades();
    this._updateRiskAfterClose(pnl, pos);
    this.state.openPositions = this.state.openPositions.filter(p => p.id !== pos.id);
    this._releaseMarginIfFlat();
    this._syncSessionStats();
  }

  // seedPrice: harga real dari ticker (null = tidak tersedia, pakai hardcode per simbol)
  _generateDryRunCandles(seedPrice = null, n = 200) {
    // Harga hardcode hanya sebagai LAST RESORT jika ticker dan OHLCV keduanya gagal
    const FALLBACK_PRICES = {
      BTCUSDT: 65000,
      ETHUSDT: 3500,
      SOLUSDT: 160,
      BNBUSDT: 650,
    };
    const sym   = (this.config.symbol || "BTCUSDT").replace("/", "").replace(":USDT", "");
    let price   = seedPrice ?? FALLBACK_PRICES[sym] ?? 100;

    const candles = [];
    const now = Date.now();
    const intervalMs = this.config.interval === "1H" ? 3600000
      : this.config.interval === "4H" ? 14400000 : 86400000;

    let trend = 0.0005;
    for (let i = n; i >= 0; i--) {
      if (i % 40 === 0) trend = (Math.random() - 0.5) * 0.003;
      const change = trend + (Math.random() - 0.5) * 0.025;
      const open   = price;
      const close  = Math.max(price * (1 + change), price * 0.8);
      candles.push({
        timestamp: now - i * intervalMs,
        date:      new Date(now - i * intervalMs).toISOString(),
        open:      +open.toFixed(2),
        high:      +(Math.max(open, close) * (1 + Math.random() * 0.008)).toFixed(2),
        low:       +(Math.min(open, close) * (1 - Math.random() * 0.008)).toFixed(2),
        close:     +close.toFixed(2),
        volume:    Math.random() * 1000,
      });
      price = close;
    }
    return candles;
  }

  // ─────────────────────────────────────────────
  // HANDLE SIGNAL — simpan trade ke DB
  // ─────────────────────────────────────────────
  /**
   * @param {object} options
   *   slDist {number} — override jarak SL (default: ATR × atrMultiplier).
   *                     Dipakai untuk sideways breakout/retest entry dimana
   *                     SL ditempatkan di tepi range, bukan berbasis ATR.
   */
  /**
   * Gate cap posisi-terbuka AKUN per-tier (per-tier account open-position cap).
   *
   * Menghitung posisi terbuka NYATA milik user dari DB (close_time IS NULL) lintas
   * SEMUA koin/strategi — SENGAJA BUKAN AccountCoordinator.openCount()/reservations.size,
   * karena reservasi dibuat saat bot START (satu per strategi per koin) & baru dilepas
   * saat stop → reservations.size ≈ jumlah slot strategi ter-arm (~100 utk 27 bot),
   * memakainya sebagai cap akan memblokir SEMUA entry. Cap berlaku di dry-run & live.
   *
   * Resilient: bila jumlah posisi tak bisa dibaca (DB error / helper absen) → FAIL-OPEN
   * dengan warning (jangan crash entry), karena gate ini sifatnya proteksi tambahan.
   *
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  async _checkAccountOpenCap() {
    const cap = Number(this.config.maxAccountOpenPositions) || 0;
    if (!(cap > 0)) return { allowed: true }; // belum dikonfigurasi → tidak membatasi
    const userId = this.config.userId;
    if (!userId) return { allowed: true };    // tanpa userId tak bisa hitung → jangan blokir
    try {
      const db = require("../../../infrastructure/db/database");
      if (typeof db.countOpenTradesByUser !== "function") return { allowed: true };
      // Filter per-mode (dry/live) agar konsisten dgn MultiStrategyCoordinator.canEnter.
      const currentOpen = await db.countOpenTradesByUser(userId, this.config.dryRun);
      if (currentOpen >= cap) {
        return {
          allowed: false,
          reason: `Batas posisi terbuka akun tercapai (${currentOpen}/${cap}) untuk tier kamu — ` +
                  `entry ditahan sampai ada posisi yang tutup`,
        };
      }
      return { allowed: true };
    } catch (e) {
      this._log("warn", `Cap posisi akun: gagal baca jumlah posisi terbuka (${e.message}) — fail-open`);
      return { allowed: true };
    }
  }

  /**
   * Build ML entry payload (Sprint 16 / Phase 1): top-level fields + enriched entryContext.
   */
  _buildMlEntryPayload(enrichedSnapshot, { price, openTime, attributionKey }) {
    const openDate = openTime ? new Date(openTime) : new Date();
    const signalTs = enrichedSnapshot?.candleTimestamp
      ?? enrichedSnapshot?.signalTimestamp
      ?? openDate.getTime();
    const signalDelayMs = resolveSignalDelayMs(signalTs, openDate);
    const pairTier = this.config.pairTier ?? "LIQUID";
    const winningComponent = attributionKey ?? enrichedSnapshot?.winningComponent ?? null;

    const base = indicatorsSnapshotToEntryContext(enrichedSnapshot || {}, {
      strategyKey: winningComponent ?? this.config.strategyKey,
      entryPrice:  price,
      openTime,
      pairTier,
      leverage:    this.config.leverage,
      capital:     this.state.capital,
      htfTrend:    this.state.htfTrend,
      marketCond:  enrichedSnapshot?.afMarketCond,
      confidence:  resolveGradedSignalConfidence(enrichedSnapshot),
    });

    const entryContext = enrichEntryContextLive(base, {
      entryTime: openDate,
      candles:   this._lastCandles ?? [],
      snapshot:  enrichedSnapshot ?? {},
      pairTier,
      signalDelayMs,
      winningComponent,
      htfTrend:  this.state.htfTrend,
      regime:    enrichedSnapshot?.afMarketCond,
    });

    return { winningComponent, signalDelayMs, pairTier, entryContext };
  }

  /**
   * Build ML exit payload (Sprint 16 / Phase 1): enriched exitContext.
   */
  _buildMlExitPayload(pos, { exitPrice, pnl, pnlPct, fee, funding, reason }) {
    const reasonUp = String(reason || "MANUAL").toUpperCase();
    let expectedPrice = null;
    if (reasonUp.includes("TP")) expectedPrice = pos.tp;
    else if (reasonUp.includes("SL")) expectedPrice = pos.sl;

    return enrichExitContextLive({}, {
      pnl,
      pnlPct,
      exitPrice,
      expectedPrice,
      fundingCost: funding ?? 0,
      regimeAtExit: classifyHtfTrend(this.state.htfTrend),
      exitReason:   reason,
      closedAt:     new Date().toISOString(),
    });
  }

  /** Persist trade close with ML exitContext enrichment. */
  async _closeTradeInDb(pos, params) {
    const exitContext = this._buildMlExitPayload(pos, params);
    return db.closeTrade(pos.dbId, { ...params, exitContext });
  }

  async _handleSignal(signal, price, atr, indicatorSnapshot = null, options = {}) {
    if (!atr) { this._log("warn", "ATR tidak tersedia, skip signal"); return; }

    // BUG-003: dedup open — cegah pembukaan posisi duplikat untuk symbol+side yang
    // sama dalam jendela singkat (mis. tick ganda / restart bot men-trigger ulang
    // sinyal yang sama). Tanpa ini muncul "ghost trade" entry==exit pnl=0.
    const DEDUP_WINDOW_MS = 5000;
    const dedupKey = `${this.config.symbol}:${signal}`;
    this._lastOpenAt = this._lastOpenAt || {};
    const now0 = Date.now();
    if (this._lastOpenAt[dedupKey] && now0 - this._lastOpenAt[dedupKey] < DEDUP_WINDOW_MS) {
      this._log("warn", `Dedup: open ${signal} ${this.config.symbol} diabaikan (duplikat <${DEDUP_WINDOW_MS}ms)`);
      return;
    }
    // Juga skip jika sudah ada posisi terbuka apa pun untuk simbol ini
    // (single-position-per-symbol — jangan hanya dedup same-side).
    if (this.state.openPositions.length > 0) {
      this._log("warn", `Dedup: sudah ada posisi ${this.config.symbol} terbuka — skip open duplikat`);
      return;
    }

    // ── Per-tier account open-position cap ────────────────────────────────────
    // Fix bug meter "Account Risk → Open positions" yang menampilkan "8 / 4":
    // cap account-wide TAK PERNAH ditegakkan. Gate INDEPENDEN dari anggaran margin
    // (canOpen/reserveGroup) — membatasi JUMLAH posisi terbuka serentak LINTAS
    // semua koin/strategi sesuai tier user. Chokepoint tunggal di sini meng-cover
    // kedua jalur (engine tunggal & multi-strategi: AdaptiveStrategyEngine memanggil
    // super._handleSignal). WAJIB jalan di DRY-RUN juga (kasus dilaporkan = simulasi)
    // — TIDAK ditempatkan di balik guard !dryRun. Sumber hitung = posisi terbuka
    // NYATA dari DB, BUKAN reservations.size (= slot strategi ter-arm).
    const capVerdict = await this._checkAccountOpenCap();
    if (!capVerdict.allowed) {
      this._log("warn", `🚦 ${capVerdict.reason}`);
      return;
    }

    this._lastOpenAt[dedupKey] = now0;

    // Pair-tier SL override: VOLATILE 1.5× / STABLE 1.1× / LIQUID 1.0×. Memperlebar
    // SL agar tidak ter-stop oleh noise di koin volatil; sizing berbasis-risk otomatis
    // memperkecil posisi saat SL lebih lebar (risk $ tetap). Default 1 bila tak diset.
    const pairSlMult = this.config.pairSlMultiplier || 1;
    const baseSlDist = options.slDist != null ? options.slDist : atr * this.config.atrMultiplier;
    const slDist = baseSlDist * pairSlMult;
    // tpDist can be overridden independently (used by ADAPTIVE_FUSION per-component RR)
    const tpDist = options.tpDist != null ? options.tpDist * pairSlMult : slDist * this.config.riskReward;
    const sl = signal === "LONG" ? price - slDist : price + slDist;
    const tp = signal === "LONG" ? price + tpDist : price - tpDist;

    // BUG-08: Hard guard — SL/TP harus finite, positif, dan berada di sisi yang benar.
    // Sinyal dengan SL/TP invalid tidak boleh membuka posisi (unlimited-loss risk).
    if (!Number.isFinite(sl) || sl <= 0 || !Number.isFinite(tp) || tp <= 0) {
      this._log("warn",
        `[GUARD-SL/TP] SL/TP tidak valid — sinyal diabaikan. ` +
        `sl=${sl} tp=${tp} price=${price} slDist=${slDist?.toFixed?.(4)} tpDist=${tpDist?.toFixed?.(4)}`
      );
      return;
    }
    if ((signal === "LONG" && sl >= price) || (signal === "SHORT" && sl <= price)) {
      this._log("warn",
        `[GUARD-SL/TP] SL berada di sisi salah untuk ${signal} — sinyal diabaikan. sl=${sl} price=${price}`
      );
      return;
    }
    if ((signal === "LONG" && tp <= price) || (signal === "SHORT" && tp >= price)) {
      this._log("warn",
        `[GUARD-SL/TP] TP berada di sisi salah untuk ${signal} — sinyal diabaikan. tp=${tp} price=${price}`
      );
      return;
    }

    // ── FEE-03: Fee-aware min-edge gate ───────────────────────────────────────
    // Edge per trade harus jauh lebih besar dari biaya. Roundtrip fee =
    // entry+exit = 2×fee (pakai makerFeeRate bila entryMode=maker). Tolak entry
    // bila reward leg (jarak ke TP sbg fraksi harga) tak menutup
    // minEdgeFeeMultiple× fee roundtrip → mencegah scalp marginal yang fee-nya
    // menelan profit (akar kerugian net: fee 8× lebih besar dari edge per trade).
    const minEdgeMult = this.config.minEdgeFeeMultiple ?? 0;
    if (minEdgeMult > 0 && price > 0) {
      const perSideFee     = this.config.entryMode === "maker"
        ? (this.config.makerFeeRate ?? 0.0002)
        : (this.config.feeRate ?? 0.0006);
      const roundtripFee   = 2 * perSideFee;
      const tpFrac         = tpDist / price;
      if (tpFrac < minEdgeMult * roundtripFee) {
        this._log("warn",
          `[FEE-GATE] Edge terlalu tipis vs fee — sinyal ${signal} diabaikan. ` +
          `TP=${(tpFrac * 100).toFixed(3)}% < ${minEdgeMult}× fee roundtrip ` +
          `(${(minEdgeMult * roundtripFee * 100).toFixed(2)}% minimum)`
        );
        return;
      }
    }

    // ── Atribusi strategi per-trade (TASK 2.3 — Multi-Strategy per Coin) ───────
    // Tiap engine (termasuk yang di-spawn MultiStrategyCoordinator) punya satu
    // strategyKey. Simpan atribusi eksplisit + SL/TP + multiplier ke snapshot
    // indikator yang dipersist di kolom trades.indicators agar setiap trade bisa
    // ditelusuri ke strategi yang memfire-nya (AC-04).
    // Sprint 12 AF/TS race: prefer winning racer label over umbrella key.
    let attributionKey = this.config.strategyKey;
    let attributionLabel = this.config.strategyLabel;
    try {
      const sk = normalizeStrategyKey(String(this.config.strategyKey || this.config.signalType || "").toUpperCase());
      if (sk === "TREND_FOLLOWING") {
        const tfMeta = getTrendFollowingInstance()?.getLastSignalMeta?.();
        if (tfMeta?.winningComponent) {
          attributionKey = tfMeta.winningComponent;
          attributionLabel = tfMeta.strategyLabel || attributionLabel;
          if (indicatorSnapshot) {
            indicatorSnapshot.winningComponent = tfMeta.winningComponent;
            indicatorSnapshot.strategyLabel = attributionLabel;
            indicatorSnapshot.signalComponents = tfMeta.signalComponents || null;
            indicatorSnapshot.tsRace = tfMeta.tsRace || null;
            // Sprint 15: per-racer ML metadata → persisted trade.indicators
            if (tfMeta.winningComponent === "AUCTION_MARKET_THEORY") {
              indicatorSnapshot.vpVwapLevel = tfMeta.vpVwapLevel ?? null;
              indicatorSnapshot.vpVahLevel = tfMeta.vpVahLevel ?? null;
              indicatorSnapshot.vpValLevel = tfMeta.vpValLevel ?? null;
              indicatorSnapshot.vpPocLevel = tfMeta.vpPocLevel ?? null;
              indicatorSnapshot.vpTriggerType = tfMeta.vpTriggerType ?? null;
            } else if (tfMeta.winningComponent === "TREND_FOLLOWING") {
              indicatorSnapshot.tfAdxStrength = tfMeta.tfAdxStrength ?? null;
              indicatorSnapshot.tfDonchianPeriod = tfMeta.tfDonchianPeriod ?? null;
              indicatorSnapshot.tfBarsInTrend = tfMeta.tfBarsInTrend ?? null;
              indicatorSnapshot.tfVolRatio = tfMeta.tfVolRatio ?? null;
              indicatorSnapshot.tfHtfTrendConfirmed = tfMeta.tfHtfTrendConfirmed ?? null;
            } else if (tfMeta.winningComponent === "MARKET_STRUCTURE") {
              indicatorSnapshot.msSwingHighPrice = tfMeta.msSwingHighPrice ?? null;
              indicatorSnapshot.msSwingLowPrice = tfMeta.msSwingLowPrice ?? null;
              indicatorSnapshot.msPullbackDepthAtr = tfMeta.msPullbackDepthAtr ?? null;
              indicatorSnapshot.msHhPattern = tfMeta.msHhPattern ?? null;
              indicatorSnapshot.msLlPattern = tfMeta.msLlPattern ?? null;
              indicatorSnapshot.msPullbackConfirmed = tfMeta.msPullbackConfirmed ?? null;
            }
          }
        }
      } else if (
        sk === "SMART_MONEY_CONCEPTS" || sk === "WYCKOFF" || sk === "VOLUME_SPREAD_ANALYSIS"
      ) {
        const afMeta = (() => {
          try {
            const { strategyRegistry: reg } = require("../../../core/strategy-engine/index");
            return reg.get("SMART_MONEY_CONCEPTS")?.getLastSignalMeta?.()
              || reg.get(sk)?.getLastSignalMeta?.()
              || null;
          } catch {
            return null;
          }
        })();
        if (afMeta?.winningComponent) {
          attributionKey = afMeta.winningComponent;
          attributionLabel = afMeta.strategyLabel || attributionLabel;
          if (indicatorSnapshot) {
            indicatorSnapshot.winningComponent = afMeta.winningComponent;
            indicatorSnapshot.strategyLabel = attributionLabel;
            indicatorSnapshot.signalComponents = afMeta.signalComponents || null;
            indicatorSnapshot.afRace = afMeta.afRace || null;
            if (afMeta.afVotes) indicatorSnapshot.afVotes = afMeta.afVotes;
            if (afMeta.winningComponent === "VOLUME_SPREAD_ANALYSIS") {
              indicatorSnapshot.vsaPatternType = afMeta.vsaPatternType ?? null;
              indicatorSnapshot.vsaSpread = afMeta.vsaSpread ?? null;
              indicatorSnapshot.vsaVolume = afMeta.vsaVolume ?? null;
              indicatorSnapshot.vsaAvgSpread = afMeta.vsaAvgSpread ?? null;
              indicatorSnapshot.vsaAvgVolume = afMeta.vsaAvgVolume ?? null;
              indicatorSnapshot.vsaSwingProximity = afMeta.vsaSwingProximity ?? null;
              indicatorSnapshot.vsaReversal = afMeta.vsaReversal ?? null;
            } else if (afMeta.winningComponent === "WYCKOFF") {
              indicatorSnapshot.wyPatternType = afMeta.wyPatternType ?? null;
              indicatorSnapshot.wyAccumulationBars = afMeta.wyAccumulationBars ?? null;
              indicatorSnapshot.wyFakeBreakDepthAtr = afMeta.wyFakeBreakDepthAtr ?? null;
              indicatorSnapshot.wyReclameBars = afMeta.wyReclameBars ?? null;
              indicatorSnapshot.wyVolumeRatio = afMeta.wyVolumeRatio ?? null;
              indicatorSnapshot.wySosOrSow = afMeta.wySosOrSow ?? null;
              indicatorSnapshot.wyLpsLevel = afMeta.wyLpsLevel ?? null;
            }
          }
        }
      } else if (
        sk === "MEAN_REVERSION" || sk === "SUPPLY_AND_DEMAND" || sk === "STATISTICAL_ARBITRAGE"
        || sk === "MEAN_DRIFT"
      ) {
        const mdMeta = (() => {
          try {
            const { strategyRegistry: reg } = require("../../../core/strategy-engine/index");
            return reg.get("MEAN_REVERSION")?.getLastSignalMeta?.()
              || reg.get(sk)?.getLastSignalMeta?.()
              || null;
          } catch {
            return null;
          }
        })();
        if (mdMeta) {
          const mdComponents = new Set(["MEAN_REVERSION", "SUPPLY_AND_DEMAND", "STATISTICAL_ARBITRAGE"]);
          const winner = mdMeta.winningComponent || (mdComponents.has(sk) ? sk : "MEAN_REVERSION");
          attributionKey = winner;
          attributionLabel = mdMeta.strategyLabel || attributionLabel;
          if (indicatorSnapshot) {
            indicatorSnapshot.winningComponent = winner;
            indicatorSnapshot.strategyLabel = attributionLabel;
            if (winner === "MEAN_REVERSION") {
              indicatorSnapshot.mrRsiValue = mdMeta.mrRsiValue ?? null;
              indicatorSnapshot.mrBbMidLevel = mdMeta.mrBbMidLevel ?? null;
              indicatorSnapshot.mrBbUpperLevel = mdMeta.mrBbUpperLevel ?? null;
              indicatorSnapshot.mrBbLowerLevel = mdMeta.mrBbLowerLevel ?? null;
              indicatorSnapshot.mrVwapLevel = mdMeta.mrVwapLevel ?? null;
              indicatorSnapshot.mrVwapDeviation = mdMeta.mrVwapDeviation ?? null;
              indicatorSnapshot.mrAdxRegime = mdMeta.mrAdxRegime ?? null;
            } else if (winner === "SUPPLY_AND_DEMAND") {
              indicatorSnapshot.sdZoneType = mdMeta.sdZoneType ?? null;
              indicatorSnapshot.sdZoneLevel = mdMeta.sdZoneLevel ?? null;
              indicatorSnapshot.sdZoneSizeAtr = mdMeta.sdZoneSizeAtr ?? null;
              indicatorSnapshot.sdRetestDepthAtr = mdMeta.sdRetestDepthAtr ?? null;
              indicatorSnapshot.sdVolumeConfirmation = mdMeta.sdVolumeConfirmation ?? null;
              indicatorSnapshot.sdTimeToRetestBars = mdMeta.sdTimeToRetestBars ?? null;
              indicatorSnapshot.sdConfluence = mdMeta.sdConfluence ?? null;
            } else if (winner === "STATISTICAL_ARBITRAGE") {
              indicatorSnapshot.saZScore = mdMeta.saZScore ?? null;
              indicatorSnapshot.saMaValue = mdMeta.saMaValue ?? null;
              indicatorSnapshot.saStdDev = mdMeta.saStdDev ?? null;
              indicatorSnapshot.saUpperBand = mdMeta.saUpperBand ?? null;
              indicatorSnapshot.saLowerBand = mdMeta.saLowerBand ?? null;
              indicatorSnapshot.saBandTouch = mdMeta.saBandTouch ?? null;
              indicatorSnapshot.saMeanRevertBars = mdMeta.saMeanRevertBars ?? null;
            }
          }
        }
      } else if (
        sk === "BREAKOUT_RETEST" || sk === "ICT_STYLE_TRADING" || sk === "LIQUIDATION_SQUEEZE" || sk === "BREAKOUT_STORM"
      ) {
        const bsMeta = (() => {
          try {
            const { strategyRegistry: reg } = require("../../../core/strategy-engine/index");
            return reg.get(sk)?.getLastSignalMeta?.()
              || getBreakoutRetestMeta?.()
              || null;
          } catch {
            return getBreakoutRetestMeta?.() || null;
          }
        })();
        if (bsMeta) {
          const bsComponents = new Set(["BREAKOUT_RETEST", "ICT_STYLE_TRADING", "LIQUIDATION_SQUEEZE"]);
          const winner = bsMeta.winningComponent || (bsComponents.has(sk) ? sk : "BREAKOUT_RETEST");
          attributionKey = winner;
          attributionLabel = bsMeta.strategyLabel || attributionLabel;
          if (indicatorSnapshot) {
            indicatorSnapshot.winningComponent = winner;
            indicatorSnapshot.strategyLabel = attributionLabel;
            if (winner === "BREAKOUT_RETEST") {
              applyBsBrSnapshotFields(indicatorSnapshot, bsMeta);
            } else if (winner === "ICT_STYLE_TRADING") {
              indicatorSnapshot.ictKillZoneHour = bsMeta.ictKillZoneHour ?? null;
              indicatorSnapshot.ictKillZoneLevel = bsMeta.ictKillZoneLevel ?? null;
              indicatorSnapshot.ictRaidType = bsMeta.ictRaidType ?? null;
              indicatorSnapshot.ictRaidDepthAtr = bsMeta.ictRaidDepthAtr ?? null;
              indicatorSnapshot.ictVolumeRatio = bsMeta.ictVolumeRatio ?? null;
              indicatorSnapshot.ictReversal = bsMeta.ictReversal ?? null;
              indicatorSnapshot.ictMssPct = bsMeta.ictMssPct ?? null;
            } else if (winner === "LIQUIDATION_SQUEEZE") {
              indicatorSnapshot.lsOiValue = bsMeta.lsOiValue ?? null;
              indicatorSnapshot.lsOiPercentile = bsMeta.lsOiPercentile ?? null;
              indicatorSnapshot.lsBbWidth = bsMeta.lsBbWidth ?? null;
              indicatorSnapshot.lsBbWidthPercentile = bsMeta.lsBbWidthPercentile ?? null;
              indicatorSnapshot.lsLiquidationLevel = bsMeta.lsLiquidationLevel ?? null;
              indicatorSnapshot.lsWickDepthAtr = bsMeta.lsWickDepthAtr ?? null;
              indicatorSnapshot.lsOiForecast24h = bsMeta.lsOiForecast24h ?? null;
            }
          }
        }
      }
    } catch { /* degrade — umbrella attribution still recorded */ }
    try {
      const { strategyRegistry: reg } = require("../../../core/strategy-engine/index");
      const stratKey = normalizeStrategyKey(String(this.config.strategyKey || this.config.signalType || "").toUpperCase());
      const strat = reg.get(stratKey);
      applyGradedScoreToSnapshot(indicatorSnapshot, strat?.getLastSignalMeta?.(), attributionKey);
    } catch { /* degrade — graded score optional */ }
    const enrichedSnapshot = {
      ...(indicatorSnapshot || {}),
      ...buildTradeAttribution({
        strategyKey: attributionKey,
        strategyLabel: attributionLabel,
        sl, tp, slDist, tpDist, atr,
      }),
    };
    // NOTE: "Fired by" attribution folded into the consolidated entry banner below
    // (one card per entry instead of six). enrichedSnapshot still persisted to DB.

    // ── Sprint 16 Phase 2: ML win-probability gate ─────────────────────────────
    if (!this._mlGate) {
      this._mlGate = MLGateService.autoStart();
    }
    if (this._mlGate) {
      const mlGatePayload = this._buildMlEntryPayload(enrichedSnapshot, {
        price,
        openTime: Date.now(),
        attributionKey,
      });
      let closedTradeCount = 999;
      if (this.sessionId) {
        try {
          const stats = await db.getTradeStats(this.sessionId, this.config.userId);
          closedTradeCount = parseInt(stats?.total, 10) || 0;
        } catch { /* fail-open */ }
      }
      const mlVerdict = this._mlGate.evaluateEntry({
        entryContext:     mlGatePayload.entryContext,
        strategyKey:      attributionKey,
        symbol:           this.config.symbol,
        regime:           enrichedSnapshot?.afMarketCond,
        tradeCount:       closedTradeCount,
        signalConfidence: resolveGradedSignalConfidence(enrichedSnapshot),
      });
      if (!mlVerdict.allowed) {
        this._log("info", `⏸ ML gate — ${mlVerdict.reason}`);
        return;
      }
      if (mlVerdict.mode === "shadow" && mlVerdict.pWin < (mlVerdict.threshold ?? 0.45)) {
        this._log("info", `[ML shadow] Would skip: ${mlVerdict.reason}`);
      }
    }

    // Tentukan modal acuan untuk sizing.
    // LIVE: WAJIB dari balance exchange yang valid. Jika gagal/0 → ABORT trade.
    // Jangan pernah pakai angka hardcoded di live: akun kecil bisa 10x oversize
    // → likuidasi langsung. (SEV1 #2)
    let availCap;
    if (this.config.dryRun) {
      availCap = this.state.capital;
    } else {
      try {
        const bal = await this.client.getBalance(this.config.marginCoin);
        availCap  = bal.available;
        // Bagikan equity akun ke koordinator margin lintas-bot (#5)
        if (this.config.coordinator) {
          this.config.coordinator.setAccountEquity(bal.equity > 0 ? bal.equity : bal.available);
        }
      } catch (e) {
        this._log("error", `Balance gagal dibaca — skip entry demi keamanan (${e.message})`);
        return;
      }
      if (!Number.isFinite(availCap) || availCap <= 0) {
        this._log("warn", `Balance tidak valid (${availCap}) — skip entry`);
        return;
      }
    }

    // Pair-tier position adjustment (v2.3): VOLATILE 0.55× / SEMI_VOLATILE 0.75× /
    // STABLE 0.95× / LIQUID 1.0×. Mengecilkan posisi (manajemen risiko) di koin
    // berisiko tinggi. SELALU dikalikan ke sizing (STRATEGIES.md §9). Default 1.
    const pairPosAdj = this.config.pairPositionSizeAdjustment || 1;
    const riskPct = options.riskPerTrade ?? this.config.riskPerTrade;
    const size = calcPositionSize(availCap, riskPct, price, sl) * pairPosAdj;
    if (size <= 0) { this._log("warn", "Position size terlalu kecil, skip signal"); return; }

    // ── Minimum lot size Bitget — flexible leverage guard ─────────────────────
    // Jika size < minLot, coba pakai minLot dan hitung risk aktualnya.
    // Kalau risk aktual masih ≤ maxRiskPerTrade → tetap buka (jangan lewatkan momentum).
    // Kalau risk aktual > maxRiskPerTrade → skip (terlalu berisiko).
    const MIN_LOT = { BTCUSDT: 0.001, ETHUSDT: 0.01, SOLUSDT: 0.1, BNBUSDT: 0.01 };
    const sym     = (this.config.symbol || "").replace("/", "").replace(":USDT", "");
    const minLot  = MIN_LOT[sym] ?? 0.001;

    let finalSize    = size;
    let actualRiskPct = riskPct;

    if (finalSize < minLot) {
      const riskIfMinLot = (minLot * Math.abs(price - sl)) / availCap;
      // Batas penerimaan min-lot dibuat lebih ketat (#11): maksimal 2x risk normal,
      // dan tidak boleh melewati maxRiskPerTrade. Sebelumnya boleh sampai 5% (5x niat).
      const minLotRiskCap = Math.min(this.config.maxRiskPerTrade, riskPct * 2);
      if (riskIfMinLot <= minLotRiskCap) {
        finalSize    = minLot;
        actualRiskPct = riskIfMinLot;
        this._log("info",
          `Size ideal ${size.toFixed(4)} < min lot ${minLot} ${sym} → pakai min lot. ` +
          `Risk aktual: ${(riskIfMinLot * 100).toFixed(2)}% (batas: ${(minLotRiskCap * 100).toFixed(2)}%)`
        );
      } else {
        this._log("warn",
          `Size ideal ${size.toFixed(4)} < min lot ${minLot} ${sym}. ` +
          `Risk jika pakai min lot: ${(riskIfMinLot * 100).toFixed(2)}% > batas ${(minLotRiskCap * 100).toFixed(2)}% → skip. ` +
          `(Butuh modal ~$${((minLot * Math.abs(price - sl)) / riskPct).toFixed(2)} untuk trade ${sym} normal)`
        );
        return;
      }
    }
    // Ganti variabel size → finalSize untuk sisa kode di bawah

    // ── Koordinasi margin lintas-bot (#5) ─────────────────────────────────────
    // Margin awal = notional / leverage. Cek anggaran akun BERSAMA sebelum buka,
    // supaya beberapa bot di akun yang sama tidak over-commit → likuidasi.
    const lev            = this.config.leverage || 1;
    const requiredMargin = (price * finalSize) / lev;
    const botKey         = this.config.botKey || `${this.config.userId ?? "anon"}:${this.config.symbol}`;
    // Group guard: ALWAYS when a coordinator is wired (live + dry-run).
    // Previously dry-run without groupKey skipped the coordinator → AC-05 / 1-per-symbol
    // could be bypassed in paper mode. Dry-run still skips the equity budget gate inside
    // canOpen when accountEquity is 0.
    const useGroupGuard = !!this.config.coordinator;
    // AUDIT fix: reserve BEFORE the await openPosition to close the canOpen→reserve
    // TOCTOU window (two engines could both pass canOpen before either reserved).
    let marginReservedEarly = false;
    if (useGroupGuard) {
      let marginToCheck = requiredMargin;
      const verdict = this.config.coordinator.canOpen({
        botKey, symbol: this.config.symbol, requiredMargin: marginToCheck,
        groupKey:  this.config.groupKey ?? null,
        direction: signal,
      });
      if (!verdict.ok) {
        // Jika gagal karena budget margin (bukan batas posisi/simbol), coba
        // scale-down size agar pas dalam anggaran yang tersisa.
        if (verdict.budget !== undefined && verdict.committed !== undefined) {
          const availBudget = verdict.budget - verdict.committed;
          if (availBudget > 0) {
            const scaledSize = Math.floor((availBudget * lev / price) / minLot) * minLot;
            if (scaledSize >= minLot) {
              finalSize    = scaledSize;
              marginToCheck = (price * finalSize) / lev;
              const verdict2 = this.config.coordinator.canOpen({
                botKey, symbol: this.config.symbol, requiredMargin: marginToCheck,
                groupKey: this.config.groupKey ?? null, direction: signal,
              });
              if (verdict2.ok) {
                this._log("info",
                  `📐 Size dikecilkan ke ${finalSize} ${sym} agar masuk anggaran ` +
                  `($${marginToCheck.toFixed(2)} margin dari $${availBudget.toFixed(2)} tersisa)`
                );
                // update actualRiskPct karena size berubah
                actualRiskPct = (finalSize * Math.abs(price - sl)) / availCap;
              } else {
                this._log("warn", `🚦 Entry ditahan koordinator akun: ${verdict.reason}`);
                return;
              }
            } else {
              this._log("warn",
                `🚦 Entry ditahan: anggaran tersisa $${availBudget.toFixed(2)} < ` +
                `margin min lot ${sym} $${((price * minLot) / lev).toFixed(2)}. ` +
                `Top-up akun atau tunggu posisi lain tutup.`
              );
              return;
            }
          } else {
            this._log("warn", `🚦 Entry ditahan koordinator akun: ${verdict.reason}`);
            return;
          }
        } else {
          this._log("warn", `🚦 Entry ditahan koordinator akun: ${verdict.reason}`);
          return;
        }
      }

      // Optimistic reserve immediately after canOpen — released on order failure.
      const earlyMargin = (price * finalSize) / lev;
      this.config.coordinator.reserve(botKey, {
        symbol: this.config.symbol, margin: earlyMargin,
        groupKey: this.config.groupKey ?? null,
        strategyKey: this.config.strategyKey ?? null,
        direction: signal,
      });
      marginReservedEarly = true;
    }

    // requiredMargin mungkin berubah jika size di-scale-down oleh koordinator
    const finalMargin = (price * finalSize) / lev;

    // Increment trade counter harian
    this.state.dailyTradeCount += 1;

    // ── Entry banner terpadu — SATU kartu, bukan 6 log terpisah ──────────────
    // Sebelumnya: SINYAL + alasan + Entry detail + STATS + Fired-by + DRY RUN
    // masing-masing emit sendiri → panel log penuh kartu kembar di satu detik.
    const why = [];
    if (indicatorSnapshot) {
      const s = indicatorSnapshot;
      if (s.emaTrendBias)        why.push(`tren ${s.emaTrendBias}`);
      if (s.htfTrend)            why.push(`HTF ${s.htfTrend}`);
      if (s.rsi != null)         why.push(`RSI ${s.rsi}`);
      if (s.volumeRatio != null) why.push(`volume ${s.volumeRatio}× SMA`);
      if (s.afComponent)         why.push(`komponen ${s.afComponent}`);
    }
    const slMult = enrichedSnapshot.slMultiplier;
    const tpMult = enrichedSnapshot.tpMultiplier;
    const entryLines = [
      `══ ENTRY ${signal} — ${this.config.symbol} · ${stratLabel(this.config.strategyKey)} ══`,
    ];
    if (why.length) entryLines.push(`Sinyal     : ${why.join(" · ")}`);
    const grok = indicatorSnapshot?.grokConfirm;
    if (grok) {
      const tpModeLabel = grok.tp_mode_label
        ?? ((grok.tp_mode ?? "full") === "partial" ? "Partial TP" : "Full TP");
      entryLines.push(
        `Grok       : conf ${grok.confidence ?? "?"}/10 · ${tpModeLabel}` +
        (grok.tp_mode_confidence != null ? ` (mode ${grok.tp_mode_confidence}/10)` : "") +
        (grok.tp_confidence != null ? ` · TP conf ${grok.tp_confidence}/10` : "")
      );
      if (grok.reasoning) entryLines.push(`Konfirmasi : ${grok.reasoning}`);
      if (grok.tp_note) entryLines.push(`TP Grok    : ${grok.tp_note}`);
    }
    entryLines.push(`Entry      : $${fmtPx(price)}`);
    entryLines.push(`SL / TP    : $${fmtPx(sl)} / $${fmtPx(tp)}${slMult ? `  (${slMult}×/${tpMult}× ATR)` : ""}`);
    entryLines.push(`Size       : ${finalSize} · Risk ${(actualRiskPct * 100).toFixed(2)}%`);
    entryLines.push(`Stats      : Trade ${this.state.dailyTradeCount}/${this.config.maxTradesPerDay} · Loss beruntun ${this.state.consecLoss}/${this.config.maxConsecLoss}`);
    entryLines.push(`Mode       : ${this.config.dryRun ? "DRY RUN (order tidak dikirim)" : "LIVE"}`);
    this._logBlock("trade", entryLines);

    const openTime = Date.now();

    if (!this.config.dryRun) {
      try {
        const side     = signal === "LONG" ? "open_long" : "open_short";
        const holdSide = signal === "LONG" ? "long" : "short";

        // ── Buka posisi + embed preset SL/TP atomik (CCXT v4.5 Bitget V2) ──────
        // Kirim harga SL/TP MENTAH — client yang format ke tick-size. toFixed(2)
        // lama merusak trigger price koin murah (mis. XPL → SL/TP jadi $0.09).
        // FEE-02: entryMode="maker" → rute limit post-only (fee maker) dengan
        // fallback taker bila tak ke-fill. Default taker → jalur lama identik.
        const useMaker = this.config.entryMode === "maker" &&
          typeof this.client.openPositionMaker === "function";
        const order = useMaker
          ? await this.client.openPositionMaker(this.config.symbol, side, finalSize, "USDT", sl, tp)
          : await this.client.openPosition(this.config.symbol, side, finalSize, "USDT", sl, tp);
        if (order?.entryFill) {
          enrichedSnapshot.entryFill = order.entryFill;
          this._log("trade",
            `Entry fill: ${order.entryFill}` +
            (order.filledMaker ? ` (maker ${order.filledMaker}/${finalSize})` : "")
          );
        }
        this._log("trade", `Order terkirim! ID: ${order?.orderId || "N/A"}`);

        // Keep reservation in sync with final margin (idempotent overwrite).
        if (this.config.coordinator) {
          this.config.coordinator.reserve(botKey, {
            symbol: this.config.symbol, margin: finalMargin,
            groupKey: this.config.groupKey ?? null,
            strategyKey: this.config.strategyKey ?? null,
            direction: signal,
          });
        }

        const pos = {
          id: order?.orderId, side: signal, entry: price, sl, tp, size: finalSize, openTime, atr, manualSLTP: false,
          marginReserved: finalMargin,
          tpMode: options.tpMode ?? this.config.tpMode ?? "full",
          slPlusPartial1Pct: options.slPlusPartial1Pct ?? this.config.slPlusPartial1Pct,
          slPlusPartial2Pct: options.slPlusPartial2Pct ?? this.config.slPlusPartial2Pct,
          slPlusM1R: options.slPlusM1R ?? this.config.slPlusM1R ?? 1.0,
          slPlusM2R: options.slPlusM2R ?? this.config.slPlusM2R ?? 2.0,
          slPlusBeOffsetR: options.slPlusBeOffsetR ?? this.config.slPlusBeOffsetR ?? 0.3,
          // BUG-004: simpan snapshot indikator entry agar partial-close bisa
          // menyalin RSI/ATR/ATR% (tanpa ini partial trade dapat NaN).
          entrySnapshot: enrichedSnapshot,
          // Persist winning-racer / attribution key (not umbrella engine alone).
          strategyName:  attributionKey ?? this.config.strategyKey ?? null,
          // SL+ tracking
          remainingSize: finalSize,
          R:             slDist,   // 1R = jarak SL asli dari entry
          slCurrent:     sl,       // SL aktif saat ini (bergerak setelah milestone)
          m1: false,               // +1R milestone: partial 40%, SL → +0.3R
          m2: false,               // +2R milestone: partial 27.5%, SL → +1R
          m3: false,               // +3R: biarkan menuju TP
        };

        // Verifikasi apakah preset SL/TP berhasil di-embed
        if (order?.presetSLTP) {
          this._log("trade", `SL/TP di-embed dalam order ✓ | SL: $${fmtPx(sl)} | TP: $${fmtPx(tp)}`);
        } else {
          // Fallback: pasang SL/TP terpisah jika preset tidak tersupport / gagal
          this._log("info", `Preset SL/TP tidak terkonfirmasi, pasang terpisah via plan order...`);
          await new Promise(r => setTimeout(r, 2000));

          let slOk = false, tpOk = false;
          let slErr = "", tpErr = "";

          for (let attempt = 1; attempt <= 3; attempt++) {
            if (!slOk) {
              const r = await this.client.setTPSL(this.config.symbol, "loss_plan",   sl, holdSide, finalSize);
              slOk = r.success;
              if (!slOk) slErr = r.message || "unknown";
            }
            if (!tpOk) {
              const r = await this.client.setTPSL(this.config.symbol, "profit_plan", tp, holdSide, finalSize);
              tpOk = r.success;
              if (!tpOk) tpErr = r.message || "unknown";
            }
            if (slOk && tpOk) break;
            if (attempt < 3) {
              this._log("info", `SL/TP attempt ${attempt} gagal, retry dalam 3s...`);
              await new Promise(r => setTimeout(r, 3000));
            }
          }

          if (slOk && tpOk) {
            this._log("trade", `SL/TP dipasang ✓ | SL: $${fmtPx(sl)} | TP: $${fmtPx(tp)}`);
          } else if (!slOk) {
            // SL TIDAK terkonfirmasi = posisi telanjang (kerugian tak terbatas).
            // Perlakukan sebagai kondisi fatal: TUTUP posisi segera, jangan andalkan
            // monitor manual (bergantung tick ≤60s + harga basi). (SEV1 #4)
            if (!slOk) this._log("error", `SL gagal: ${slErr}`);
            if (!tpOk) this._log("error", `TP gagal: ${tpErr}`);
            this._log("error", `🚨 SL tidak terkonfirmasi — TUTUP posisi darurat (anti naked position)`);
            // Anti-churn: tanpa cooldown, tick berikutnya membuka simbol yang sama →
            // gagal SL → tutup darurat lagi (insiden LAB live: 5× open/tutup dalam 6 menit,
            // bocor fee + spam Telegram). Kunci re-entry beberapa menit lewat mekanisme
            // cooldown yang sudah ada (dicek di gate entry _checkRiskGates).
            const slFailCd = Math.max(this.config.cooldownAfterLoss || 30, 15);
            this.state.cooldownUntil = Date.now() + slFailCd * 60 * 1000;
            this._log("warn", `🕐 Cooldown ${slFailCd} menit (SL gagal) — hindari buka ulang tanpa proteksi`);
            try {
              const closeSide = signal === "LONG" ? "close_long" : "close_short";
              await this.client.closePosition(this.config.symbol, closeSide, finalSize);
              this._log("warn", `Posisi ${signal} ditutup darurat ✓ — tidak ada order tanpa SL`);
              // Posisi sudah ditutup → lepas reservasi margin di koordinator (#5)
              if (this.config.coordinator) this.config.coordinator.release(botKey);
              this._notifyClose({
                symbol: this.config.symbol, side: signal, entryPrice: price,
                exitPrice: price, pnl: 0, pnlPct: 0, reason: "SL_FAILED_EMERGENCY_CLOSE",
                dryRun: false,
              });
            } catch (closeErr) {
              // Gagal tutup pun → JANGAN catat sebagai posisi sehat. Tandai manual +
              // alert keras agar operator turun tangan.
              this._log("error", `‼️ GAGAL tutup darurat: ${closeErr.message} — INTERVENSI MANUAL DIPERLUKAN di exchange!`);
              pos.manualSLTP = true;
              pos.slFailed   = true;
            }
            // Jika berhasil ditutup, hentikan pemrosesan posisi ini (jangan simpan/track)
            if (!pos.slFailed) return;
          } else {
            // TP gagal tapi SL OK — tidak fatal (downside terlindungi). Monitor manual TP.
            this._log("error", `TP gagal: ${tpErr}`);
            this._log("warn", `[WARN] TP GAGAL (SL OK) — bot monitor TP manual`);
            pos.manualSLTP = true;
          }
        }

        // Simpan ke DB
        if (this.sessionId) {
          const mlEntry = this._buildMlEntryPayload(enrichedSnapshot, { price, openTime, attributionKey });
          pos.entryContext = mlEntry.entryContext;
          pos.dbId = await db.insertTrade({
            sessionId:  this.sessionId,
            exchange:   this.config.exchange,
            symbol:     this.config.symbol,
            side:       signal,
            entryPrice: price,
            sl, tp, size: finalSize, openTime, atr,
            dryRun:     false,
            orderId:    order?.orderId,
            indicators: enrichedSnapshot,
            // Persist winning-racer canonical key (WYCKOFF / MARKET_STRUCTURE / …), not umbrella.
            strategyName: attributionKey ?? this.config.strategyKey ?? null,
            winningComponent: mlEntry.winningComponent,
            signalDelayMs:    mlEntry.signalDelayMs,
            pairTier:         mlEntry.pairTier,
            entryContext:     mlEntry.entryContext,
          });
          onEngineTradeOpen(pos.dbId, enrichedSnapshot, {
            strategyKey: attributionKey ?? this.config.strategyKey,
            symbol:      this.config.symbol,
            side:        signal,
            entryPrice:  price,
            openTime,
            leverage:    this.config.leverage,
            capital:     this.state.capital,
            pairTier:    mlEntry.pairTier,
            entryContext: mlEntry.entryContext,
          });
        }

        this.state.openPositions.push(pos);

        // Notifikasi Telegram — open posisi live
        this._notifyOpen({
          symbol:     this.config.symbol,
          side:       signal,
          entryPrice: price,
          size:       finalSize,
          sl, tp,
          leverage:   this.config.leverage,
          dryRun:     false,
        });
      } catch (err) {
        this._log("error", `Gagal buka posisi: ${err.message}`);
        // Roll back optimistic reserve so peer engines are not blocked forever.
        if (marginReservedEarly && this.config.coordinator) {
          this.config.coordinator.release(botKey);
        }
      }
    } else {
      // (mode "DRY RUN" sudah tertera di entry banner — tak perlu log terpisah)
      // Margin yang "dikunci" disimpan persis di posisi (#9) agar saat close
      // dikembalikan dalam jumlah yang sama — sebelumnya open & close memakai
      // rumus berbeda → equity simulasi drift.
      const marginReserved = availCap * actualRiskPct;
      this.state.capital -= marginReserved;

      const pos = {
        id: `dry_${openTime}`, side: signal, entry: price, sl, tp, size: finalSize, openTime, atr,
        marginReserved,
        tpMode: options.tpMode ?? this.config.tpMode ?? "full",
        slPlusPartial1Pct: options.slPlusPartial1Pct ?? this.config.slPlusPartial1Pct,
        slPlusPartial2Pct: options.slPlusPartial2Pct ?? this.config.slPlusPartial2Pct,
        slPlusM1R: options.slPlusM1R ?? this.config.slPlusM1R ?? 1.0,
        slPlusM2R: options.slPlusM2R ?? this.config.slPlusM2R ?? 2.0,
        slPlusBeOffsetR: options.slPlusBeOffsetR ?? this.config.slPlusBeOffsetR ?? 0.3,
        // BUG-004: snapshot entry untuk diwariskan ke partial-close.
        entrySnapshot: enrichedSnapshot,
        strategyName:  attributionKey ?? this.config.strategyKey ?? null,
        // SL+ tracking
        remainingSize: finalSize,
        R:             slDist,
        slCurrent:     sl,
        m1: false, m2: false, m3: false,
      };

      // Dry-run: keep/refresh coordinator reservation (early reserve already set when
      // coordinator is present; overwrite with paper margin so AC-05 stays accurate).
      if (this.config.coordinator) {
        this.config.coordinator.reserve(botKey, {
          symbol: this.config.symbol, margin: marginReserved,
          groupKey: this.config.groupKey ?? null,
          strategyKey: this.config.strategyKey ?? null,
          direction: signal,
        });
      }

      // Simpan ke DB (dry run)
      if (this.sessionId) {
        const mlEntry = this._buildMlEntryPayload(enrichedSnapshot, { price, openTime, attributionKey });
        pos.entryContext = mlEntry.entryContext;
        pos.dbId = await db.insertTrade({
          sessionId:  this.sessionId,
          exchange:   this.config.exchange,
          symbol:     this.config.symbol,
          side:       signal,
          entryPrice: price,
          sl, tp, size: finalSize, openTime, atr,
          dryRun:     true,
          orderId:    pos.id,
          // Persist winning-racer canonical key + attribution snapshot.
          indicators: enrichedSnapshot,
          strategyName: attributionKey ?? this.config.strategyKey ?? null,
          winningComponent: mlEntry.winningComponent,
          signalDelayMs:    mlEntry.signalDelayMs,
          pairTier:         mlEntry.pairTier,
          entryContext:     mlEntry.entryContext,
        });
        onEngineTradeOpen(pos.dbId, enrichedSnapshot, {
          strategyKey: attributionKey ?? this.config.strategyKey,
          symbol:      this.config.symbol,
          side:        signal,
          entryPrice:  price,
          openTime,
          leverage:    this.config.leverage,
          capital:     this.state.capital,
          pairTier:    mlEntry.pairTier,
          entryContext: mlEntry.entryContext,
        });
      }

      this.state.openPositions.push(pos);

      // Notifikasi Telegram — open posisi dry run
      this._notifyOpen({
        symbol:     this.config.symbol,
        side:       signal,
        entryPrice: price,
        size:       finalSize,
        sl, tp,
        leverage:   this.config.leverage,
        dryRun:     true,
      });
    }
  }

  // ─────────────────────────────────────────────
  // MULTI-POSITION SIGNAL HANDLING (v3.0)
  // ─────────────────────────────────────────────

  async _handleMultiPositionSignal(componentId, signal, price, atr, indicators, lastIdx, indicatorSnapshot, marketCond = "NORMAL", confidence = null) {
    if (!signal || !atr) return;

    const SmartMoneyConceptsStrategy = require("../../../core/strategy-engine/implementations/SmartMoneyConceptsStrategy");
    const afStrategy = new SmartMoneyConceptsStrategy();
    const { resolveScalpingGateFlags, resolveIntradayGateFlags, resolveSwingGateFlags, applySmcSideRegimeGate, applySmcFundingGuard } = require("../../../core/strategy-engine/af/smcEntry");
    const { checkNoTradeSessionGate } = require("../../../core/risk-engine/entryRiskGates");

    // Map legacy letters → type names for typeOverrides lookup
    const typeName = { A: "Scalping", B: "Intraday", C: "Swing" }[componentId] || componentId;

    // Sprint 14 live-safety gate: unproven legs (the new 5m Scalping) are
    // Advance-backtest-only and must not trade real money until they clear
    // walk-forward validation. Real-live only (dryRun === false) — dry-run still
    // exercises every leg. Skip-only: cannot enable anything, only blocks.
    if (this.config.dryRun === false) {
      const { isTypeLiveEligible } = require("../../../config/liveTradeTypeGate");
      const stratKey = this.config.signalType || this.config.strategyKey || this.config.name;
      if (!isTypeLiveEligible(stratKey, typeName)) {
        this._log("info", `[Multi-AF:${componentId}] ${typeName} leg skipped — backtest-only, not live-eligible (Sprint 14)`);
        return;
      }
    }

    const typeOverride = this.config.typeOverrides?.[typeName] || this.config.typeOverrides?.[componentId] || {};

    // Sprint 13: Side×Regime for Scalping LONGs in CHOP (live parity with backtest)
    if (typeName === "Scalping") {
      const flags = resolveScalpingGateFlags({ ...this.config, ...typeOverride, typeOverrides: this.config.typeOverrides });
      const ts = indicatorSnapshot?.candleTimestamp
        ?? indicators?.timestamps?.[lastIdx]
        ?? Date.now();
      const sessionGate = checkNoTradeSessionGate({
        timestamp: ts,
        noTradeSessions: flags.noTradeSessions,
        enabled: flags.smcSessionFilter,
        tradeTier: "Scalping",
        strategyKey: this.config.strategyKey || "SMART_MONEY_CONCEPTS",
      });
      if (!sessionGate.ok) {
        this._log("info", `[Multi-AF:${componentId}] ${signal} ditolak — ${sessionGate.reason}`);
        return;
      }
      const dailyRegime = this.state.dailyRegime || indicatorSnapshot?.dailyRegime || "UNKNOWN";
      const sideGate = applySmcSideRegimeGate({
        signal,
        dailyRegime,
        enabled: flags.smcBlockLongInChop === true,
      });
      if (!sideGate.allow) {
        this._log("info", `[Multi-AF:${componentId}] ${signal} ditolak — ${sideGate.reason}`);
        return;
      }
    }

    // Sprint 22: Intraday session (London block) + CHOP all-sides gate (live parity)
    if (typeName === "Intraday") {
      const flags = resolveIntradayGateFlags({ ...this.config, ...typeOverride, typeOverrides: this.config.typeOverrides });
      const ts = indicatorSnapshot?.candleTimestamp
        ?? indicators?.timestamps?.[lastIdx]
        ?? Date.now();
      const sessionGate = checkNoTradeSessionGate({
        timestamp: ts,
        noTradeSessions: flags.noTradeSessions,
        enabled: flags.smcSessionFilter,
        tradeTier: "Intraday",
        strategyKey: this.config.strategyKey || "SMART_MONEY_CONCEPTS",
      });
      if (!sessionGate.ok) {
        this._log("info", `[Multi-AF:${componentId}] ${signal} ditolak — ${sessionGate.reason}`);
        return;
      }
      const dailyRegime = this.state.dailyRegime || indicatorSnapshot?.dailyRegime || "UNKNOWN";
      const sideGate = applySmcSideRegimeGate({
        signal,
        dailyRegime,
        enabled: flags.smcBlockAllInChop === true,
        blockAllInChop: true,
      });
      if (!sideGate.allow) {
        this._log("info", `[Multi-AF:${componentId}] ${signal} ditolak — ${sideGate.reason}`);
        return;
      }
    }

    // Sprint 13 Swing: funding premium guard
    if (typeName === "Swing") {
      const swingFlags = resolveSwingGateFlags({ ...this.config, ...typeOverride, typeOverrides: this.config.typeOverrides });
      if (swingFlags.smcFundingGuard) {
        const rate = indicatorSnapshot?.fundingRate
          ?? indicators?.fundingRate?.[lastIdx]
          ?? this.state.fundingRate
          ?? null;
        const fundGate = applySmcFundingGuard({
          signal,
          fundingRate: rate,
          enabled: true,
          maxAbsRate: swingFlags.smcMaxFundingRate,
        });
        if (!fundGate.allow) {
          this._log("info", `[Multi-AF:${componentId}] ${signal} ditolak — ${fundGate.reason} (funding=${rate})`);
          return;
        }
      }
    }

    // Calculate risk config for this component. Pass the real regime so
    // strongTrendTPMult (let winners run in STRONG_TREND) can fire.
    // Sprint 13: honour typeOverrides SL/TP so Planned RR matches backtest (RR 2.0).
    const riskCfg = afStrategy.calculateRiskConfig(price, atr, signal, typeName, {
      marketCond: marketCond || "NORMAL",
      strongTrendTPMult: this.config.strongTrendTPMult ?? 1,
      slMultiplier: typeOverride.slAtrMult ?? this.config.slAtrMult,
      tpMultiplier: typeOverride.tpAtrMult ?? this.config.tpAtrMult,
      tpMode: typeOverride.tpMode,
      slPlusPartial1Pct: typeOverride.slPlusPartial1Pct,
      slPlusPartial2Pct: typeOverride.slPlusPartial2Pct,
      slPlusM1R: typeOverride.slPlusM1R,
      slPlusM2R: typeOverride.slPlusM2R,
      slPlusBeOffsetR: typeOverride.slPlusBeOffsetR,
      minRr: typeOverride.minRr,
      minSlPct: typeOverride.minSlPct,
      minSlPctMode: typeOverride.minSlPctMode,
      minSlAtrMult: typeOverride.minSlAtrMult,
    });

    if (!riskCfg || !(riskCfg.slDistance > 0) || !(riskCfg.tpDistance > 0)) {
      this._log("info", `[Multi-AF:${componentId}] ${signal} ditolak — risk config rejected (min SL / invalid levels)`);
      return;
    }

    const baseSlDist = riskCfg.slDistance;
    const slDist = baseSlDist * (this.config.pairSlMultiplier || 1);
    const tpDist = riskCfg.tpDistance * (this.config.pairSlMultiplier || 1);

    const sl = signal === "LONG" ? price - slDist : price + slDist;
    const tp = signal === "LONG" ? price + tpDist : price - tpDist;

    // Validate SL/TP
    if (!Number.isFinite(sl) || sl <= 0 || !Number.isFinite(tp) || tp <= 0) {
      this._log("warn", `[Multi-AF:${componentId}] Invalid SL/TP — sl=${sl} tp=${tp}`);
      return;
    }
    if ((signal === "LONG" && sl >= price) || (signal === "SHORT" && sl <= price)) {
      this._log("warn", `[Multi-AF:${componentId}] SL on wrong side for ${signal}`);
      return;
    }

    // Calculate position size based on risk — loss when SL hits must equal
    // riskAmt, so qty = riskAmt / slDist. Dividing by the full SL→TP span (as
    // before) silently under-sized every position ~2.8×.
    //
    // riskPerTrade is the COMBINED cap across all concurrent AF components, not

    // (A/Scalping 0.5 : B/Intraday 1 : C/Swing 2) via the SAME riskShareForType
    // helper the backtest engines use — single source of truth, so live sizing
    // can never silently drift from the backtest (the 3× SMC live-risk bug
    // class, 311e18d). With combined 0.035 → A 0.5%, B 1%, C 2%.
    const { riskShareForType, applyLegRiskShare } = require("../../../core/risk-engine/typeRiskLadder");
    const enabledComponents =
      this.config.afEnabledComponents ||
      this.config.enabledComponents ||
      this.config.smcEnabledComponents ||
      ["Scalping", "Intraday", "Swing"];
    const legOverrides =
      this.config.typeOverrides?.[typeName] ||
      this.config.typeOverrides?.[componentId] ||
      {};
    const riskPerTrade = applyLegRiskShare(
      riskShareForType(
        componentId,
        enabledComponents,
        this.config.riskPerTrade || 0.01,
        this.config.typeRiskWeights,
      ),
      legOverrides,
    );
    // Parity with RealStrategyBacktestService riskSizingBasis:"initial".
    const riskBasis = this.config.riskSizingBasis === "initial"
      ? (this.state.startCapital || this.config.capital || this.state.capital)
      : this.state.capital;
    const riskAmt = riskBasis * riskPerTrade;
    const qty = slDist > 0 ? riskAmt / slDist : 0;

    if (qty <= 0) {
      this._log("warn", `[Multi-AF:${componentId}] Invalid qty=${qty}`);
      return;
    }

    // AccountCoordinator gate (was missing on legacy AF multi-position path).
    const botKey = this.config.botKey || `${this.config.userId ?? "anon"}:${this.config.symbol}:AF:${componentId}`;
    const lev = this.config.leverage || 1;
    const requiredMargin = (price * qty) / lev;
    if (this.config.coordinator) {
      const verdict = this.config.coordinator.canOpen({
        botKey,
        symbol: this.config.symbol,
        requiredMargin,
        groupKey: this.config.groupKey ?? null,
        direction: signal,
      });
      if (!verdict.ok) {
        this._log("warn", `[Multi-AF:${componentId}] Entry ditahan koordinator: ${verdict.reason}`);
        return;
      }
      this.config.coordinator.reserve(botKey, {
        symbol: this.config.symbol,
        margin: requiredMargin,
        groupKey: this.config.groupKey ?? null,
        strategyKey: this.config.strategyKey ?? null,
        direction: signal,
      });
    }

    // Create position object
    const positionId = `${componentId}-${Date.now()}`;
    const tpMode = riskCfg.preferredTpMode || typeOverride.tpMode || this.config.tpMode || "full";
    const position = {
      positionId,
      componentId,
      tradeType: typeName,
      symbol: this.config.symbol,
      side: signal,
      entry: price,
      sl,
      tp,
      qty,
      size: qty,
      riskAmt,
      openTime: new Date().toISOString(),
      openCandle: lastIdx,
      unrealizedPL: 0,
      confidence: confidence ?? null,
      marketCond: marketCond || "NORMAL",
      marginReserved: requiredMargin,
      coordinatorBotKey: botKey,
      // SL+ / partial ladder — parity with backtest typeOverrides + calculateRiskConfig
      tpMode,
      slPlusPartial1Pct: riskCfg.slPlusPartial1Pct ?? typeOverride.slPlusPartial1Pct ?? this.config.slPlusPartial1Pct,
      slPlusPartial2Pct: riskCfg.slPlusPartial2Pct ?? typeOverride.slPlusPartial2Pct ?? this.config.slPlusPartial2Pct,
      slPlusM1R: riskCfg.slPlusM1R ?? typeOverride.slPlusM1R ?? this.config.slPlusM1R ?? 1.0,
      slPlusM2R: riskCfg.slPlusM2R ?? typeOverride.slPlusM2R ?? this.config.slPlusM2R ?? 2.0,
      slPlusBeOffsetR: riskCfg.slPlusBeOffsetR ?? typeOverride.slPlusBeOffsetR ?? this.config.slPlusBeOffsetR ?? 0.3,
      remainingSize: qty,
      R: slDist,
      slCurrent: sl,
      m1: false, m2: false, m3: false,
      makerEntry: typeOverride.makerEntry === true || this.config.makerEntry === true,
    };

    // Store position
    this.state.positions.set(componentId, position);

    const confNote = confidence != null ? ` | Conf ${confidence}%` : "";
    this._log("info",
      `[Multi-AF:${componentId}] ENTRY ${signal} @ $${price.toFixed(2)} | ` +
      `SL $${sl.toFixed(2)} TP $${tp.toFixed(2)} | ` +
      `RR 1:${riskCfg.riskReward.toFixed(2)} | Qty ${qty.toFixed(4)}${confNote}`
    );

    // Execute order in live mode
    if (!this.config.dryRun && this.client) {
      try {
        const order = await this.client.createOrder({
          symbol: this.config.symbol,
          side: signal,
          type: "MARKET",
          quantity: qty,
          takeProfitPrice: tp,
          stopLossPrice: sl,
        });
        position.orderId = order.id;
        this._log("info", `[Multi-AF:${componentId}] Order placed: ${order.id}`);
      } catch (err) {
        this._log("error", `[Multi-AF:${componentId}] Order failed: ${err.message}`);
        this.state.positions.delete(componentId);
        if (this.config.coordinator) {
          this.config.coordinator.release(botKey);
        }
      }
    }
  }

  // ─────────────────────────────────────────────
  // SIDEWAYS MODE — BREAKOUT (Strat B) + RETEST (Strat C)
  // ─────────────────────────────────────────────

  /**
   * Handler utama saat HTF = SIDEWAYS.
   * Dipanggil dari _tick() menggantikan detectSignal() biasa.
   *
   * Aggressive Scalping (PDF_SCALPING)   → diam total, 1m terlalu noise saat 15m sideways
   * Day Trading (PDF_DAYTRADING)         → breakout langsung jika candle HTF close keluar range
   * Swing Trading (PDF_SWING)            → tunggu breakout valid, lalu entry setelah retest
   */
  async _checkSidewaysEntry(htfCandles, price, atr, indicators, lastIdx, emaF, emaS, emaTrend, rsi) {
    const signalType = this.config.signalType;

    // ── Strat A: diam total ────────────────────────────────────────────────────
    if (signalType === "PDF_SCALPING") {
      if (this.state.checkCount % 10 === 1) {
        this._log("info", `[HTF] ${this.config.strategyKey} SIDEWAYS — menunggu trend jelas (Strat A diam)`);
      }
      return;
    }

    const boConfig = {
      rangeLookback:  this.config.sidewaysRangeLookback,
      volMultiplier:  this.config.sidewaysBreakoutVolMult,
      bufferAtrMult:  this.config.sidewaysBreakoutBufMult,
      htfEmaFast:     this.config.htfEmaFast,
      htfEmaSlow:     this.config.htfEmaSlow,
    };

    // ── Strat B: breakout langsung ─────────────────────────────────────────────
    if (signalType === "PDF_DAYTRADING") {
      const bo = detectSidewaysBreakout(htfCandles, boConfig);

      if (!bo) {
        if (this.state.checkCount % 10 === 1) {
          this._log("info", `[HTF] ${this.config.strategyKey} SIDEWAYS — menunggu breakout range`);
        }
        return;
      }

      // Pastikan sinyal tidak duplikat dari entry terakhir
      if (bo.signal === this.state.lastSignal) return;

      this._log("trade",
        `[BREAKOUT] SIDEWAYS ${bo.signal}! ` +
        `Range [${bo.rangeLow.toFixed(2)}-${bo.rangeHigh.toFixed(2)}] ditembus`
      );

      // SL ditempatkan di balik tepi range (bukan ATR dari entry)
      const slDist = Math.abs(price - bo.rangeEdge) + bo.atr * 0.5;

      const vol    = indicators.volumes[lastIdx] ?? 0;
      const volSMA = indicators.volSMA[lastIdx]  ?? 1;
      const snap   = {
        rsi:          rsi  != null ? parseFloat(rsi.toFixed(2))   : null,
        atr:          atr  != null ? parseFloat(atr.toFixed(4))   : null,
        atrPct:       atr && price ? parseFloat(((atr / price) * 100).toFixed(3)) : null,
        emaFast:      emaF != null ? parseFloat(emaF.toFixed(4))  : null,
        emaSlow:      emaS != null ? parseFloat(emaS.toFixed(4))  : null,
        emaTrendVal:  emaTrend != null ? parseFloat(emaTrend.toFixed(4)) : null,
        emaTrendBias: emaTrend != null ? (price > emaTrend ? "bullish" : "bearish") : null,
        volumeRatio:  volSMA > 0 ? parseFloat((vol / volSMA).toFixed(2)) : null,
        htfTrend:     "SIDEWAYS",
        strategy:     this.config.strategyKey,
        entryMode:    "sideways_breakout",
        rangeHigh:    +bo.rangeHigh.toFixed(4),
        rangeLow:     +bo.rangeLow.toFixed(4),
      };

      await this._handleSignal(bo.signal, price, atr, snap, { slDist });
      this.state.lastSignal = bo.signal;
      return;
    }

    // ── Strat C: retest entry ──────────────────────────────────────────────────
    if (signalType === "PDF_SWING") {
      // Belum ada breakout tersimpan → cari dulu
      if (!this.state.sidewaysBreakout) {
        const bo = detectSidewaysBreakout(htfCandles, boConfig);
        if (bo) {
          this.state.sidewaysBreakout = { ...bo, detectedAt: Date.now() };
          this._log("info",
            `[BREAKOUT] ${this.config.strategyKey} Breakout ${bo.signal} terdeteksi ` +
            `@ range edge ${bo.rangeEdge.toFixed(2)} — menunggu retest...`
          );
        } else if (this.state.checkCount % 10 === 1) {
          this._log("info", `[HTF] ${this.config.strategyKey} SIDEWAYS — menunggu breakout + retest`);
        }
        return;
      }

      // Ada breakout tersimpan: timeout check (10 × checkInterval)
      const timeout = this.config.checkInterval * 10;
      if (Date.now() - this.state.sidewaysBreakout.detectedAt > timeout) {
        this._log("info", `[TIMEOUT] ${this.config.strategyKey} Breakout timeout — reset state sideways`);
        this.state.sidewaysBreakout = null;
        return;
      }

      // Cek retest atau false breakout
      const retestResult = this._checkRetestEntry(price, atr);

      if (retestResult === null) {
        // False breakout: harga kembali ke dalam range
        this._log("warn",
          `[INVALID] ${this.config.strategyKey} Breakout ${this.state.sidewaysBreakout.signal} INVALID ` +
          `— harga balik ke range. Reset.`
        );
        this.state.sidewaysBreakout = null;
        return;
      }

      if (retestResult === false) {
        // Belum retest, masih dalam mode tunggu
        if (this.state.checkCount % 5 === 1) {
          const bo = this.state.sidewaysBreakout;
          this._log("info",
            `[RETEST] ${this.config.strategyKey} Menunggu retest ke ` +
            `${bo.signal === "LONG" ? `area ${bo.rangeHigh.toFixed(2)}` : `area ${bo.rangeLow.toFixed(2)}`}...`
          );
        }
        return;
      }

      // Retest valid → entry!
      const bo     = this.state.sidewaysBreakout;
      const slDist = bo.signal === "LONG"
        ? price - (bo.rangeLow - bo.atr * 0.3)         // SL di bawah range low
        : (bo.rangeHigh + bo.atr * 0.3) - price;       // SL di atas range high

      this._log("trade",
        `[VALID] ${this.config.strategyKey} RETEST VALID! ${bo.signal} @ $${price.toFixed(2)} ` +
        `(range edge: $${bo.rangeEdge.toFixed(2)} | SL dist: $${slDist.toFixed(2)})`
      );

      const vol    = indicators.volumes[lastIdx] ?? 0;
      const volSMA = indicators.volSMA[lastIdx]  ?? 1;
      const snap   = {
        rsi:          rsi  != null ? parseFloat(rsi.toFixed(2))   : null,
        atr:          atr  != null ? parseFloat(atr.toFixed(4))   : null,
        atrPct:       atr && price ? parseFloat(((atr / price) * 100).toFixed(3)) : null,
        emaFast:      emaF != null ? parseFloat(emaF.toFixed(4))  : null,
        emaSlow:      emaS != null ? parseFloat(emaS.toFixed(4))  : null,
        emaTrendVal:  emaTrend != null ? parseFloat(emaTrend.toFixed(4)) : null,
        emaTrendBias: emaTrend != null ? (price > emaTrend ? "bullish" : "bearish") : null,
        volumeRatio:  volSMA > 0 ? parseFloat((vol / volSMA).toFixed(2)) : null,
        htfTrend:     "SIDEWAYS",
        strategy:     this.config.strategyKey,
        entryMode:    "sideways_retest",
        rangeHigh:    +bo.rangeHigh.toFixed(4),
        rangeLow:     +bo.rangeLow.toFixed(4),
      };

      this.state.sidewaysBreakout = null;   // clear setelah entry
      await this._handleSignal(bo.signal, price, atr, snap, { slDist });
      this.state.lastSignal = bo.signal;
    }
  }

  /**
   * Cek apakah harga sudah memasuki zona retest dari breakout tersimpan.
   *
   * @returns {true}  — retest valid, lanjut entry
   * @returns {false} — belum retest, masih tunggu
   * @returns {null}  — false breakout (harga balik ke dalam range), harus reset
   */
  _checkRetestEntry(price, atr) {
    const bo = this.state.sidewaysBreakout;
    if (!bo) return null;

    const { signal, rangeHigh, rangeLow, buffer, atr: boAtr } = bo;
    const retestTolerance = (boAtr || atr) * 0.5;  // seberapa dekat ke range edge = valid retest

    if (signal === "LONG") {
      // False breakout: harga balik jauh ke dalam range (di bawah rangeLow + buffer)
      if (price < rangeLow + buffer) return null;

      // Retest zone: harga kembali mendekati rangeHigh dari atas
      // [rangeHigh - tolerance, rangeHigh + buffer]
      const retestLow  = rangeHigh - retestTolerance;
      const retestHigh = rangeHigh + buffer;
      if (price >= retestLow && price <= retestHigh) return true;

      return false;  // Masih di atas range, belum pullback ke retest area
    }

    if (signal === "SHORT") {
      // False breakout: harga balik jauh ke dalam range (di atas rangeHigh - buffer)
      if (price > rangeHigh - buffer) return null;

      // Retest zone: harga kembali mendekati rangeLow dari bawah
      // [rangeLow - buffer, rangeLow + tolerance]
      const retestLow  = rangeLow - buffer;
      const retestHigh = rangeLow + retestTolerance;
      if (price >= retestLow && price <= retestHigh) return true;

      return false;  // Masih di bawah range, belum pullback ke retest area
    }

    return false;
  }

  // ─────────────────────────────────────────────
  // SL+ — TRAILING PARTIAL TAKE PROFIT
  // Dipanggil setiap tick untuk setiap posisi terbuka.
  // ─────────────────────────────────────────────

  /**
   * Periksa milestone +1R / +2R / +3R dan eksekusi partial close + geser SL.
   * @param {object} pos   — item dari this.state.openPositions
   * @param {number} price — harga penutupan candle terakhir
   */
  async _checkSLPlusMilestones(pos, price) {
    // tpMode "full" → skip semua milestone; posisi lari ke TP penuh tanpa dipotong.
    // Backward compat: bila tpMode belum diset (bot lama), default ke "full".
    if ((pos.tpMode ?? this.config.tpMode ?? "full") === "full") return;
    if (!this.config.slPlusEnabled) return;
    if (pos.remainingSize <= 0) return;

    const R = pos.R;
    // QA-002: cegah pembagian rMult = gain/R saat R = 0 / non-finite (atr≈0 atau
    // slDist override strategi = 0). Tanpa guard → rMult = Infinity/NaN yang
    // men-trigger SEMUA milestone (+1R/+2R/+3R) sekaligus → cascade partial close
    // dan NaN merembet ke kalkulasi PnL. Skip milestone bila R tidak valid.
    if (!Number.isFinite(R) || R <= 0) {
      if (this.state.checkCount % 20 === 1) {
        this._log("warn", `SL+ milestone di-skip: risk distance (R) tidak valid (R=${R}) ${this.config.symbol}`);
      }
      return;
    }
    const gain  = pos.side === "LONG" ? price - pos.entry : pos.entry - price;
    const rMult = gain / R;

    // Minimum lot per simbol — partial di bawah ini ditolak exchange
    const MIN_LOT = { BTCUSDT: 0.001, ETHUSDT: 0.01, SOLUSDT: 0.1, BNBUSDT: 0.01 };
    const sym     = (this.config.symbol || "").replace("/", "").replace(":USDT", "");
    const minLot  = MIN_LOT[sym] ?? 0.001;

    // ── Milestone 1: +M1R → partial (or 0% = BE-trail), SL → entry±beOff*R ──
    // Default beOff=0.3 (VAULT). Wyckoff Scalping uses beOff=0 via pos/config.
    // HARUS identik dengan RealStrategyBacktestService.checkPartialMilestones.
    const m1R = Number.isFinite(pos.slPlusM1R) ? pos.slPlusM1R : (this.config.slPlusM1R ?? 1.0);
    const m2R = Number.isFinite(pos.slPlusM2R) ? pos.slPlusM2R : (this.config.slPlusM2R ?? 2.0);
    const beOff = Number.isFinite(pos.slPlusBeOffsetR)
      ? pos.slPlusBeOffsetR
      : (Number.isFinite(this.config.slPlusBeOffsetR) ? this.config.slPlusBeOffsetR : 0.3);
    const pct1 = pos.slPlusPartial1Pct ?? this.config.slPlusPartial1Pct;
    const pct2 = pos.slPlusPartial2Pct ?? this.config.slPlusPartial2Pct;

    if (!pos.m1 && rMult >= m1R) {
      const partial = parseFloat((pos.size * pct1).toFixed(8));
      const newSL   = pos.side === "LONG" ? pos.entry + beOff * R : pos.entry - beOff * R;
      pos.m1 = true;

      // p1≥1 (or size≈remaining) = full bank at m1R as limit TP — no runner left.
      const rem = pos.remainingSize ?? pos.size;
      if (partial >= minLot && partial >= rem * 0.999) {
        await this._executePartialClose(pos, price, rem, "TP", newSL, `full@${m1R}R`);
      } else if (partial >= minLot) {
        await this._executePartialClose(pos, price, partial, "Partial_1R", newSL, `+${beOff}R`);
      } else {
        // Size terlalu kecil / 0% BE-trail — geser SL saja agar tetap terlindungi
        this._log("info",
          `SL+ M1: partial ${partial.toFixed(4)} < min lot ${minLot} ${sym} ` +
          `— skip partial, SL digeser ke +${beOff}R $${newSL.toFixed(2)} ✓`
        );
        pos.slCurrent = newSL;
        if (!this.config.dryRun) await this._updateSLOnExchange(pos, newSL);
      }
    }

    // ── Milestone 2: +M2R → partial of ORIGINAL, SL → +1R ──────────────────
    if (pos.m1 && !pos.m2 && rMult >= m2R) {
      const fromOriginal = parseFloat((pos.size * pct2).toFixed(8));
      const partial      = Math.min(fromOriginal, parseFloat((pos.remainingSize * 0.90).toFixed(8)));
      const newSL        = pos.side === "LONG" ? pos.entry + R : pos.entry - R; // +1R
      pos.m2 = true;

      if (partial >= minLot) {
        await this._executePartialClose(pos, price, partial, "Partial_2R", newSL, "+1R");
      } else {
        this._log("info",
          `SL+ M2: partial ${partial.toFixed(4)} < min lot ${minLot} ${sym} ` +
          `— skip partial, SL digeser ke +1R $${newSL.toFixed(2)} ✓`
        );
        pos.slCurrent = newSL;
        if (!this.config.dryRun) await this._updateSLOnExchange(pos, newSL);
      }
    }

    // ── Milestone 3: +3R → log saja, biarkan sisa ke TP ────────────────────
    if (pos.m1 && pos.m2 && !pos.m3 && rMult >= 3.0) {
      pos.m3 = true;
      const remaining = pos.remainingSize;
      this._sep(`SL+ MILESTONE +3R`);
      this._log("trade", `[+3R] ${pos.side} +3R tercapai! Sisa ${remaining.toFixed(4)} unit menuju TP $${pos.tp?.toFixed(2) || "N/A"}`);
      this._log("info",  `SL terkunci di +1R ($${pos.slCurrent?.toFixed(2)}) — posisi tidak bisa rugi`);
    }
  }

  /**
   * Eksekusi partial close + geser SL ke level baru.
   */
  async _executePartialClose(pos, price, partialSize, reason, newSL, newSLLabel) {
    if (partialSize <= 0) return;

    const pnl    = pos.side === "LONG"
      ? (price - pos.entry) * partialSize
      : (pos.entry - price) * partialSize;
    const pnlPct = ((price - pos.entry) / pos.entry) * 100 * (pos.side === "LONG" ? 1 : -1);
    const fee    = await this._resolveFee(pos, price, partialSize);

    this._sep(`SL+ ${reason}`);
    this._log("trade", `PARTIAL CLOSE [${reason}] ${pos.side} — ${partialSize.toFixed(4)} unit @ $${price.toFixed(2)}`);
    this._log("trade", `PnL partial gross: +$${pnl.toFixed(2)} | Fee: -$${fee.toFixed(4)} | Net: +$${(pnl - fee).toFixed(2)} | SL → $${newSL.toFixed(2)} (${newSLLabel})`);

    if (!this.config.dryRun) {
      // ── Partial close di exchange ──────────────────────────────────────────
      try {
        const closeSide = pos.side === "LONG" ? "close_long" : "close_short";
        await this.client.closePosition(this.config.symbol, closeSide, partialSize);
        this._log("trade", `Partial close terkirim ke exchange ✓`);
      } catch (e) {
        this._log("error", `Partial close gagal: ${e.message} — skip milestone`);
        return; // jangan geser SL jika partial close gagal
      }

      // ── Update SL di exchange ──────────────────────────────────────────────
      await this._updateSLOnExchange(pos, newSL);
    }

    // ── Update state posisi ──────────────────────────────────────────────────
    pos.remainingSize = parseFloat((pos.remainingSize - partialSize).toFixed(8));
    pos.slCurrent     = newSL;
    pos.sl            = newSL; // update SL aktif (dry-run monitoring pakai pos.sl)

    // ── Catat partial di state.trades ────────────────────────────────────────
    this.state.trades.push({
      ...pos,
      size:      partialSize,
      exit:      price,
      pnl,
      pnlPct,
      fee,
      reason,
      closedAt:  Date.now(),
      partial:   true,
    });
    this._capTrades();
    this._updateRiskAfterClose(pnl, pos);

    // ── Catat ke DB (insert + langsung close) ────────────────────────────────
    if (this.sessionId) {
      try {
        const partialSnapshot = pos.entrySnapshot ?? (pos.atr != null
          ? { atr: pos.atr, atrPct: pos.entry ? parseFloat(((pos.atr / pos.entry) * 100).toFixed(3)) : null }
          : null);
        const mlEntry = this._buildMlEntryPayload(partialSnapshot, {
          price: pos.entry,
          openTime: pos.openTime,
          attributionKey: pos.strategyName ?? this.config.strategyKey,
        });
        const partialDbId = await db.insertTrade({
          sessionId:  this.sessionId,
          exchange:   this.config.exchange,
          symbol:     this.config.symbol,
          side:       pos.side,
          entryPrice: pos.entry,
          sl:         pos.sl,
          tp:         pos.tp,
          size:       partialSize,
          openTime:   pos.openTime,
          atr:        pos.atr,
          dryRun:     this.config.dryRun,
          orderId:    `${pos.id}_${reason}`,
          indicators: partialSnapshot,
          strategyName: pos.strategyName ?? this.config.strategyKey ?? null,
          isPartial:    true,
          winningComponent: mlEntry.winningComponent,
          signalDelayMs:    mlEntry.signalDelayMs,
          pairTier:         mlEntry.pairTier,
          entryContext:     mlEntry.entryContext,
        });
        await this._closeTradeInDb(
          { entry: pos.entry, sl: pos.sl, tp: pos.tp, dbId: partialDbId },
          { exitPrice: price, pnl, pnlPct, fee, reason, closeTime: new Date().toISOString() }
        );
        onEngineTradeOpen(partialDbId, pos.entrySnapshot ?? (pos.atr != null
          ? { atr: pos.atr, atrPct: pos.entry ? parseFloat(((pos.atr / pos.entry) * 100).toFixed(3)) : null }
          : {}), {
          strategyKey: pos.strategyName ?? this.config.strategyKey,
          symbol:      this.config.symbol,
          side:        pos.side,
          entryPrice:  pos.entry,
          openTime:    pos.openTime,
          leverage:    this.config.leverage,
          capital:     this.state.capital,
        });
        onEngineTradeClose(partialDbId, pnl);
      } catch (e) { this._log("warn", `Gagal catat partial-close di DB: ${e.message}`); }
    }

    // ── Notifikasi Telegram ──────────────────────────────────────────────────
    this._notifyClose({
      symbol:     this.config.symbol,
      side:       pos.side,
      entryPrice: pos.entry,
      exitPrice:  price,
      pnl,
      pnlPct,
      reason:     `${reason} — SL pindah ke ${newSLLabel} ($${newSL.toFixed(2)})`,
      dryRun:     this.config.dryRun,
    });
  }

  /**
   * Cancel SL lama di Bitget lalu pasang SL baru.
   * TP di-repassang agar tidak hilang saat cancel.
   */
  async _updateSLOnExchange(pos, newSL) {
    const holdSide  = pos.side === "LONG" ? "long" : "short";
    const remaining = pos.remainingSize;

    try {
      // Cancel semua plan order (SL + TP) yang ada
      await this.client.cancelAllPlanOrders(this.config.symbol);
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      this._log("warn", `Cancel plan orders: ${e.message}`);
    }

    // Re-pasang SL baru
    const slRes = await this.client.setTPSL(this.config.symbol, "loss_plan", newSL.toFixed(2), holdSide, remaining);
    if (slRes.success) {
      this._log("trade", `SL baru terpasang @ $${newSL.toFixed(2)} ✓`);
    } else {
      this._log("warn", `SL update gagal: ${slRes.message}`);
    }

    // Re-pasang TP asli (untuk sisa posisi)
    if (pos.tp) {
      await this.client.setTPSL(this.config.symbol, "profit_plan", pos.tp.toFixed(2), holdSide, remaining);
    }
  }

  // ─────────────────────────────────────────────
  // SL/TP MONITOR — harga real-time + rentang intrabar
  // ─────────────────────────────────────────────

  _filterOrphanTradesForThisEngine(orphans) {
    return filterOrphanTradesForEngine(orphans, {
      groupKey: this.config.groupKey,
      strategyKey: this.config.strategyKey,
      isGroupLeader: this.config.isGroupLeader,
    });
  }

  _positionFromDbTrade(dbTrade, livePos = null) {
    return positionFromDbTrade(dbTrade, livePos, {
      atrMultiplier: this.config.atrMultiplier || 1,
    });
  }

  /**
   * Pulihkan posisi DB yang belum ada di state runtime — UI bisa tampil dari DB
   * (mergeBotWithLiveState fallback) sementara engine tidak memonitor SL/TP.
   * Throttled (30s) + retry on pool connect timeout so state does not go stale
   * silently under multi-coin load.
   */
  async _reconcileOpenPositionsFromDb() {
    if (!this.state.running || this._stopRequested) return;
    const RECONCILE_MIN_MS = 30_000;
    const now = Date.now();
    if (this._lastReconcileAt && now - this._lastReconcileAt < RECONCILE_MIN_MS) return;

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        let orphans = await db.getOpenTradesBySymbol(this.config.symbol, this.config.userId ?? null);
        orphans = this._filterOrphanTradesForThisEngine(orphans);
        this._lastReconcileAt = Date.now();
        if (!orphans.length) return;

        const knownDbIds = new Set(
          this.state.openPositions.map(p => p.dbId).filter(Boolean)
        );
        let added = 0;

        if (!this.config.dryRun && this.client?.getPositions) {
          let liveByKey = new Map();
          try {
            const livePosns = await this.client.getPositions(this.config.symbol);
            liveByKey = new Map(livePosns.map(p => [p.side, p]));
          } catch { /* fallback dry-style restore below */ }

          for (const dbTrade of orphans) {
            if (knownDbIds.has(dbTrade.id)) continue;
            const lp = liveByKey.get(dbTrade.side);
            if (lp) {
              this.state.openPositions.push(this._positionFromDbTrade(dbTrade, lp));
              added += 1;
            }
          }
        } else {
          for (const dbTrade of orphans) {
            if (knownDbIds.has(dbTrade.id)) continue;
            this.state.openPositions.push(this._positionFromDbTrade(dbTrade));
            added += 1;
          }
        }

        if (added > 0) {
          this._log("warn",
            `${added} posisi DB dipulihkan ke state runtime (reconcile) — monitor SL/TP aktif kembali`
          );
        }
        return;
      } catch (err) {
        const isPoolTimeout = /timeout exceeded when trying to connect/i.test(err?.message || "");
        if (!isPoolTimeout || attempt === MAX_ATTEMPTS) {
          this._log("warn", `Reconcile posisi DB gagal (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`);
          return;
        }
        await new Promise(r => setTimeout(r, 400 * attempt));
      }
    }
  }

  /** Evaluasi hit SL/TP — intrabar + fallback harga monitor (ticker/last). */
  _evaluateSlTpHit(pos, price, barHigh, barLow) {
    return evaluateSlTpHit(pos, price, barHigh, barLow);
  }

  /**
   * Resolve monitor price + high/low intrabar untuk cek SL/TP.
   * Dipakai BotEngine._tick(), AdaptiveStrategyEngine override, dan pass final saat stop().
   */
  async _resolveSlTpMonitor(candles, confirmedClose, atr) {
    let price = confirmedClose ?? this.state.lastPrice ?? 0;
    const formingBar = candles?.length
      ? (candles[candles.length - 1] || candles[candles.length - 2])
      : null;
    let barHigh = formingBar?.high ?? price;
    let barLow  = formingBar?.low  ?? price;
    let monitorPrice = price;

    if (this.state.openPositions.length > 0 && this.client?.getTicker) {
      try {
        const ticker = await this.client.getTicker(this.config.symbol);
        if (ticker?.last > 0) {
          monitorPrice = ticker.last;
          barHigh = Math.max(barHigh, ticker.last);
          barLow  = Math.min(barLow,  ticker.last);
        }
      } catch { /* fallback ke close candle / lastPrice */ }
    }

    barHigh = Math.max(barHigh, monitorPrice);
    barLow  = Math.min(barLow,  monitorPrice);
    this.state.lastPrice = monitorPrice;

    return { monitorPrice, barHigh, barLow, atr: atr ?? 0 };
  }

  /** Monitor SL/TP posisi terbuka — wrapper agar semua jalur pakai logika yang sama. */
  async _monitorOpenPositions(candles, confirmedClose, atr) {
    await this._reconcileOpenPositionsFromDb();
    if (this.state.openPositions.length === 0) return;
    const { monitorPrice, barHigh, barLow, atr: a } =
      await this._resolveSlTpMonitor(candles, confirmedClose, atr);
    await this._checkOpenPositions(monitorPrice, a, barHigh, barLow);
  }

  /** Resolve maxHoldHours for TIME_STOP from typeOverrides (Scalping 2h / Intraday 6h / Swing 120h). */
  _resolveMaxHoldHours(pos) {
    const typeName = pos.tradeType
      || ({ A: "Scalping", B: "Intraday", C: "Swing" }[pos.componentId] || pos.componentId);
    const holdOv = this.config.typeOverrides?.[typeName] || {};
    return holdOv.maxHoldHours ?? holdOv.scalpingMaxHoldHours ?? holdOv.swingMaxHoldHours
      ?? (typeName === "Scalping" ? this.config.maxHoldHours : null);
  }

  _isTimeStopDue(pos, maxHoldHours) {
    if (!maxHoldHours) return false;
    const openMs = typeof pos.openTime === "number" ? pos.openTime : Date.parse(pos.openTime || 0);
    return Number.isFinite(openMs) && (Date.now() - openMs) > maxHoldHours * 3600 * 1000;
  }

  /** Sprint 13 Swing: Telegram warn once when hold exceeds smcHoldWarnHours (default 168h). */
  async _maybeSwingHoldWarn(pos) {
    const typeName = pos.tradeType
      || ({ A: "Scalping", B: "Intraday", C: "Swing" }[pos.componentId] || pos.componentId);
    if (typeName !== "Swing" || pos._holdWarnSent) return;
    const holdOv = this.config.typeOverrides?.[typeName] || {};
    const warnH = holdOv.smcHoldWarnHours ?? 168;
    const openMsWarn = typeof pos.openTime === "number" ? pos.openTime : Date.parse(pos.openTime || 0);
    if (!Number.isFinite(openMsWarn) || (Date.now() - openMsWarn) <= warnH * 3600 * 1000) return;
    pos._holdWarnSent = true;
    this._log("warn",
      `[HOLD_WARN] ${pos.side} ${this.config.symbol} Swing held >${warnH}h — consider review (funding drag)`
    );
    await this._notifyError(
      `⚠️ Swing hold >${warnH}h: ${pos.side} ${this.config.symbol} entry=${pos.entry} since ${new Date(openMsWarn).toISOString()}`
    );
  }

  /**
   * Force-close when maxHoldHours exceeded — live (market close) and dry-run parity.
   * @returns {Promise<boolean>} true when position was closed (or already flat on exchange)
   */
  async _executeTimeStopClose(pos, price) {
    const maxHoldHours = this._resolveMaxHoldHours(pos);
    if (!this._isTimeStopDue(pos, maxHoldHours)) return false;

    const remaining = pos.remainingSize > 0 ? pos.remainingSize : pos.size;
    let exitPrice = price;

    if (!this.config.dryRun) {
      try {
        await this.client.closePosition(
          this.config.symbol,
          pos.side === "LONG" ? "close_long" : "close_short",
          remaining,
        );
        if (this.client.getRecentFillPrice) {
          const fill = await this.client.getRecentFillPrice(
            this.config.symbol,
            pos.side,
            typeof pos.openTime === "number" ? pos.openTime : Date.parse(pos.openTime || 0),
          );
          if (fill) exitPrice = fill;
        } else if (pos.markPrice) {
          exitPrice = pos.markPrice;
        }
      } catch (e) {
        const isAlreadyClosed =
          e.message?.includes("22002") ||
          e.message?.toLowerCase().includes("no position to close") ||
          e.message?.includes("position not exist");
        if (!isAlreadyClosed) {
          this._log("error", `[TIME_STOP] Gagal tutup posisi ${pos.side}: ${e.message}`);
          return false;
        }
        this._log("info", `[TIME_STOP] ${pos.side} sudah flat di exchange — bukukan TIME_STOP`);
      }
    }

    const pnl = pos.side === "LONG"
      ? (exitPrice - pos.entry) * remaining
      : (pos.entry - exitPrice) * remaining;
    const pnlPct = pos.entry > 0 ? ((pnl / (pos.entry * remaining)) * 100) : 0;
    const fee = await this._resolveFee(pos, exitPrice, remaining);

    if (this.config.dryRun) {
      const marginBack = pos.marginReserved != null
        ? pos.marginReserved
        : pos.entry * remaining * this.config.riskPerTrade;
      this.state.capital += pnl - fee + marginBack;
    }

    const closeTime = Date.now();
    this._log("info",
      `[TIME_STOP] ${pos.side} ${this.config.symbol} closed after ${maxHoldHours}h max hold`
    );

    let applied = true;
    if (this.sessionId && pos.dbId) {
      try {
        const res = await this._closeTradeInDb(pos, {
          exitPrice, pnl, pnlPct, fee,
          reason: "TIME_STOP",
          closeTime: new Date(closeTime).toISOString(),
        });
        applied = res?.applied !== false;
        if (applied) onEngineTradeClose(pos.dbId, pnl);
      } catch (dbErr) {
        applied = false;
        this._log("warn", `Gagal tutup trade #${pos.dbId} (TIME_STOP) di DB: ${dbErr.message}`);
      }
    }

    if (!applied) return false;

    if (!this.config.dryRun) {
      this._notifyClose({
        symbol:     this.config.symbol,
        side:       pos.side,
        entryPrice: pos.entry,
        exitPrice,
        pnl,
        pnlPct,
        reason:     "TIME_STOP",
        dryRun:     false,
      });
    }

    this.state.trades.push({
      ...pos, size: remaining, exit: exitPrice, pnl, pnlPct, fee,
      reason: "TIME_STOP", closedAt: closeTime,
    });
    this._capTrades();
    this._updateRiskAfterClose(pnl, pos);
    return true;
  }

  // ─────────────────────────────────────────────
  // CHECK OPEN POSITIONS — tutup trade di DB
  // ─────────────────────────────────────────────
  async _checkOpenPositions(price, atr, barHigh = price, barLow = price) {
    if (this.state.openPositions.length === 0) return;
    // Rentang intrabar untuk deteksi SL/TP (BUG-TP-INTRABAR). Fallback ke `price`
    // bila pemanggil lama tidak mengirim high/low (mis. test / jalur internal).
    if (!Number.isFinite(barHigh)) barHigh = price;
    if (!Number.isFinite(barLow))  barLow  = price;

    if (!this.config.dryRun) {
      try {
        const live      = await this.client.getPositions(this.config.symbol);
        const liveByKey = new Map(live.map(p => [p.side, p]));

        // Posisi yang ada di state tapi tidak lagi di exchange (SL/TP hit)
        const closedLocal = this.state.openPositions.filter(p => !liveByKey.has(p.side));
        // Set sesi yang perlu di-recalc (cross-session restoration)
        const sessionsToRecalc = new Set();

        for (const pos of closedLocal) {
          const remaining = pos.remainingSize > 0 ? pos.remainingSize : pos.size;

          // ── Dapatkan exit price AKTUAL + resolve reason ke "TP" / "SL" ─────────
          // Penting: frontend hanya kenal reason "TP", "SL", "Exchange".
          // Backend harus resolve ke salah satu dari 3 string ini.
          let exitPrice   = null;
          let exitReason  = "Exchange";   // default: tidak tahu SL atau TP
          let priceSource = "tick";

          const posSL = pos.sl || 0;
          const posTP = pos.tp || 0;

          // Util: tentukan reason berdasarkan harga vs SL/TP posisi
          const resolveReason = (px) => {
            if (!posSL || !posTP) return "Exchange";
            // Toleransi 0.5% dari entry untuk menganggap "hit"
            const tol = pos.entry * 0.005;
            if (Math.abs(px - posTP) <= tol) return "TP";
            if (Math.abs(px - posSL) <= tol) return "SL";
            // Fallback: paling dekat ke mana?
            return Math.abs(px - posSL) < Math.abs(px - posTP) ? "SL" : "TP";
          };

          // 1. Coba ambil actual fill price dari exchange
          if (this.client.getRecentFillPrice) {
            exitPrice = await this.client.getRecentFillPrice(
              this.config.symbol,
              pos.side,
              typeof pos.openTime === "number" ? pos.openTime : Date.parse(pos.openTime || 0)
            );
            if (exitPrice) {
              priceSource = "exchange_fill";
              exitReason  = resolveReason(exitPrice);
            }
          }

          // 2. Fill price tidak tersedia → estimasi dari SL/TP berdasarkan harga tick
          if (!exitPrice) {
            if (posSL && posTP) {
              const dSL = Math.abs(price - posSL);
              const dTP = Math.abs(price - posTP);
              if (dSL < dTP) {
                exitPrice  = posSL;
                exitReason = "SL";
              } else {
                exitPrice  = posTP;
                exitReason = "TP";
              }
              priceSource = "sl_tp_estimate";
            } else {
              exitPrice   = price;
              exitReason  = "Exchange";
              priceSource = "tick_fallback";
            }
          }

          const pnl = pos.side === "LONG"
            ? (exitPrice - pos.entry) * remaining
            : (pos.entry - exitPrice) * remaining;
          const fee = await this._resolveFee(pos, exitPrice, remaining);

          // ── Tutup record di DB DULU (idempotent — penulis pertama menang) ──────
          // Akun ber-netting dibaca banyak engine + resume race lintas restart bisa
          // membuat posisi yang sama diproses >1x. closeTrade hanya berlaku bila
          // record masih terbuka; applied=false → LEWATI semua efek samping (log,
          // notifikasi, stats) agar tidak ada PnL double-book / log ganda.
          let applied = true;
          if (pos.dbId) {
            try {
              const res = await this._closeTradeInDb(pos, { exitPrice, pnl, fee, reason: exitReason, closeTime: new Date().toISOString() });
              applied = res?.applied !== false;
              if (applied) onEngineTradeClose(pos.dbId, pnl);
            } catch (err) {
              // Jangan telan diam-diam: posisi yang gagal ditutup di DB akan "hilang"
              // dari history tanpa jejak. Surface + alert untuk rekonsiliasi.
              applied = false;
              this._log("error", `Gagal tutup trade #${pos.dbId} di DB: ${err.message} — perlu rekonsiliasi manual`);
              try { this._notifyError(`closeTrade gagal sym=${this.config.symbol} dbId=${pos.dbId}: ${err.message}`); } catch { /* notifier opsional */ }
            }
          } else {
            // Live tanpa dbId = insert saat OPEN gagal setelah order terkirim →
            // posisi live tanpa record. Proses sekali, tapi alarmkan.
            this._log("error", `Posisi ${pos.side} ${this.config.symbol} ditutup tanpa record DB (insert saat open gagal?) — cek rekonsiliasi`);
            try { this._notifyError(`Close tanpa dbId sym=${this.config.symbol} side=${pos.side}`); } catch { /* opsional */ }
          }

          if (!applied) {
            // Sudah dibukukan engine/proses lain → buang dari state tanpa log/stat ganda.
            // (state.openPositions dibersihkan oleh filter liveByKey setelah loop.)
            this._log("info", `Close ${pos.side} ${this.config.symbol} sudah dibukukan di tempat lain — skip duplikat`);
            continue;
          }

          // ── Close banner terpadu — SATU kartu dengan Holding time + Net P&L ──
          const net      = pnl - fee;
          const openMs   = typeof pos.openTime === "number" ? pos.openTime : Date.parse(pos.openTime || 0);
          const holdStr  = fmtHoldingMs(Date.now() - openMs);
          const closeLines = [
            `══ POSISI DITUTUP — ${exitReason || "SL/TP"} ══`,
            `${pos.side} ${this.config.symbol} · ${stratLabel(pos.strategyName ?? this.config.strategyKey)}`,
            `Entry → Exit : $${pos.entry} → $${exitPrice.toFixed(2)} [${priceSource}]`,
            `Holding time : ${holdStr}`,
            `Net P&L      : ${net > 0 ? "+" : ""}$${net.toFixed(2)}  (gross ${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)} · fee -$${fee.toFixed(4)})`,
          ];
          if (pos.m1 || pos.m2) {
            const partialPnL = this.state.trades.filter(t => t.partial && t.id === pos.id).reduce((s, t) => s + (t.pnl || 0), 0);
            closeLines.push(`Total (partial+sisa) : ${partialPnL + net > 0 ? "+" : ""}$${(partialPnL + net).toFixed(2)}`);
          }
          this._logBlock("trade", closeLines);

          // Notifikasi Telegram — SELALU dikirim terlepas dari cross-session atau tidak
          const pnlPct = pos.entry > 0 ? ((exitPrice - pos.entry) / pos.entry * 100 * (pos.side === "LONG" ? 1 : -1)) : 0;
          this._notifyClose({
            symbol:     this.config.symbol,
            side:       pos.side,
            entryPrice: pos.entry,
            exitPrice,
            pnl,
            pnlPct,
            reason:     exitReason,
            dryRun:     this.config.dryRun,
          });

          // Catat sesi mana yang perlu diupdate statsnya
          // pos.restoredFrom = sesi asal trade ini (bisa berbeda dari sesi aktif)
          const ownerSession = pos.restoredFrom || this.sessionId;
          sessionsToRecalc.add(ownerSession);

          if (pos.restoredFrom && pos.restoredFrom !== this.sessionId) {
            // Trade dibuka di sesi lama — jangan masuk ke state.trades sesi ini
            // agar _syncSessionStats tidak salah menghitung wins sesi saat ini
            this._log("info", `Trade sesi #${pos.restoredFrom} ditutup di sesi #${this.sessionId} (cross-session) — update sesi asal`);
          } else {
            // Trade milik sesi saat ini — masukkan ke state.trades normal
            this.state.trades.push({ ...pos, size: remaining, exit: exitPrice, pnl, fee, reason: "Exchange", closedAt: Date.now() });
            this._capTrades();
          }

          this._updateRiskAfterClose(pnl, pos);
        }

        // Update stats untuk SETIAP sesi yang terlibat
        for (const sid of sessionsToRecalc) {
          if (sid === this.sessionId) {
            this._syncSessionStats(); // update via state.trades (cepat)
          } else {
            db.recalcSessionStats(sid); // hitung ulang dari DB (untuk sesi lama)
          }
        }

        // Update state: hanya posisi yang masih ada di exchange
        this.state.openPositions = this.state.openPositions.filter(p => liveByKey.has(p.side));
        this._releaseMarginIfFlat(); // lepas margin di koordinator bila sudah flat (#5)

        // Update unrealized PnL + markPrice dari exchange, lalu cek SL+ milestones
        const timeStopIds = [];
        for (const pos of this.state.openPositions) {
          const lp = liveByKey.get(pos.side);
          if (lp) {
            pos.markPrice = lp.markPrice || price;
            // Hitung PnL manual sebagai fallback jika exchange return 0
            const upnlExchange = lp.unrealizedPL ?? 0;
            const markPx       = pos.markPrice;
            const sz           = pos.remainingSize || pos.size || 0;
            const upnlCalc     = markPx > 0 && pos.entry > 0
              ? (pos.side === "LONG"
                  ? (markPx - pos.entry) * sz
                  : (pos.entry - markPx) * sz)
              : 0;
            pos.unrealizedPL = upnlExchange !== 0 ? upnlExchange : upnlCalc;
          }

          // ── SL+ milestone check ────────────────────────────────────────────
          await this._checkSLPlusMilestones(pos, price);

          // TIME_STOP: maxHoldHours (Scalping 2h / Intraday 6h / Swing 120h)
          await this._maybeSwingHoldWarn(pos);
          if (await this._executeTimeStopClose(pos, price)) {
            timeStopIds.push(pos.id);
            continue;
          }

          // Jika SL/TP gagal dipasang tadi, monitor manual sekarang
          if (pos.manualSLTP) {
            const { hitSL, hitTP } = this._evaluateSlTpHit(pos, price, barHigh, barLow);
            if (hitSL || hitTP) {
              const reason = hitSL ? "SL" : "TP";
              this._log("warn", `Manual close ${pos.side} — ${reason} (manual monitor) @ $${price.toFixed(2)}`);
              try {
                await this.client.closePosition(
                  this.config.symbol,
                  pos.side === "LONG" ? "close_long" : "close_short",
                  pos.size,
                );
                this._log("trade", `Posisi ditutup manual`);
              } catch (e) {
                const isAlreadyClosed =
                  e.message?.includes("22002") ||
                  e.message?.toLowerCase().includes("no position to close") ||
                  e.message?.includes("position not exist");

                if (isAlreadyClosed) {
                  this._log("info", `Posisi ${pos.side} sudah ditutup oleh exchange (state sync)`);
                  // Coba ambil fill price aktual; fallback ke SL/TP estimate
                  let exitPrice = null;
                  if (this.client.getRecentFillPrice) {
                    exitPrice = await this.client.getRecentFillPrice(
                      this.config.symbol, pos.side,
                      typeof pos.openTime === "number" ? pos.openTime : Date.parse(pos.openTime || 0)
                    );
                  }
                  if (!exitPrice) {
                    // SL diprioritaskan bila keduanya kena dalam satu bar (konservatif)
                    exitPrice = hitSL ? (pos.sl || price) : (pos.tp || price);
                  }
                  const pnl = pos.side === "LONG"
                    ? (exitPrice - pos.entry) * pos.size
                    : (pos.entry - exitPrice) * pos.size;
                  const fee = await this._resolveFee(pos, exitPrice, pos.size);
                  let applied = true;
                  if (pos.dbId) {
                    try {
                      const res = await this._closeTradeInDb(pos, { exitPrice, pnl, fee, reason: hitSL ? "SL" : "TP", closeTime: new Date().toISOString() });
                      applied = res?.applied !== false;
                      if (applied) onEngineTradeClose(pos.dbId, pnl);
                    } catch (dbErr) {
                      applied = false;
                      this._log("error", `Gagal tutup trade #${pos.dbId} di DB: ${dbErr.message} — perlu rekonsiliasi`);
                      try { this._notifyError(`closeTrade(manual) gagal sym=${this.config.symbol} dbId=${pos.dbId}: ${dbErr.message}`); } catch { /* opsional */ }
                    }
                  }
                  const ownerSid = pos.restoredFrom || this.sessionId;
                  // Hanya bukukan stats/trade bila DB-close benar-benar berlaku (anti double-book).
                  if (applied && (!pos.restoredFrom || pos.restoredFrom === this.sessionId)) {
                    this.state.trades.push({ ...pos, exit: exitPrice, pnl, fee, reason: "Exchange", closedAt: Date.now() });
                    this._capTrades();
                  }
                  if (applied) this._updateRiskAfterClose(pnl, pos);
                  this.state.openPositions = this.state.openPositions.filter(p => p.id !== pos.id);
                  this._releaseMarginIfFlat(); // lepas margin di koordinator (#5)
                  if (ownerSid === this.sessionId) this._syncSessionStats();
                  else db.recalcSessionStats(ownerSid);
                } else {
                  this._log("error", `Manual close gagal: ${e.message}`);
                }
              }
            }
          }
        }

        if (timeStopIds.length > 0) {
          this.state.openPositions = this.state.openPositions.filter(p => !timeStopIds.includes(p.id));
          this._releaseMarginIfFlat();
          this._syncSessionStats();
        }
      } catch (err) {
        this._log("warn", `Sync positions error: ${err.message} — pakai state lokal`);
      }
      return;
    }

    const toClose = [];
    for (const pos of this.state.openPositions) {
      // ── SL+ milestone check (dry run) ─────────────────────────────────────
      await this._checkSLPlusMilestones(pos, price);

      // TIME_STOP: typeOverrides maxHoldHours (Scalping 2h / Intraday 6h / Swing 120h)
      await this._maybeSwingHoldWarn(pos);
      if (await this._executeTimeStopClose(pos, price)) {
        toClose.push(pos.id);
        continue;
      }

      // Cek SL / TP — intrabar wick + fallback harga monitor (ticker).
      const { hitSL, hitTP, isTP } = this._evaluateSlTpHit(pos, price, barHigh, barLow);

      if (hitTP || hitSL) {
        const exitPrice = isTP ? Number(pos.tp) : Number(pos.sl);
        // Pakai remainingSize (bukan size asli) — partial sudah dicatat terpisah
        const remaining = pos.remainingSize > 0 ? pos.remainingSize : pos.size;
        const pnl       = pos.side === "LONG"
          ? (exitPrice - pos.entry) * remaining
          : (pos.entry - exitPrice) * remaining;
        const pnlPct    = ((pnl / (pos.entry * remaining)) * 100);
        const fee       = await this._resolveFee(pos, exitPrice, remaining);

        // Modal pakai NET (#9): kembalikan margin yang DIKUNCI saat open (persis,
        // bukan rumus berbeda), tambah pnl gross, potong fee. Fallback ke rumus
        // lama untuk posisi yang dipulihkan tanpa marginReserved.
        const marginBack = pos.marginReserved != null
          ? pos.marginReserved
          : pos.entry * remaining * this.config.riskPerTrade;
        this.state.capital += pnl - fee + marginBack;
        const reason    = isTP ? "TP" : "SL";
        const closeTime = Date.now();

        // ── Close banner terpadu (dry-run SL/TP) — SATU kartu ──
        const net      = pnl - fee;
        const openMs   = typeof pos.openTime === "number" ? pos.openTime : Date.parse(pos.openTime || 0);
        const holdStr  = fmtHoldingMs(closeTime - openMs);
        const closeLines = [
          `══ POSISI DITUTUP — ${isTP ? "TAKE PROFIT" : "STOP LOSS"} ══`,
          `${pos.side} ${this.config.symbol} · ${stratLabel(pos.strategyName ?? this.config.strategyKey)}`,
          `Entry → Exit : $${pos.entry} → $${exitPrice.toFixed(2)} | Size: ${remaining.toFixed(4)}`,
          `Holding time : ${holdStr}`,
          `Net P&L      : ${net > 0 ? "+" : ""}$${net.toFixed(2)}  (gross ${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)} · fee -$${fee.toFixed(4)})`,
        ];
        if (pos.m1 || pos.m2) {
          const partialPnL = this.state.trades.filter(t => t.partial && t.id === pos.id).reduce((s, t) => s + (t.pnl || 0), 0);
          closeLines.push(`Total (partial+sisa) : ${partialPnL + net > 0 ? "+" : ""}$${(partialPnL + net).toFixed(2)}`);
        }
        this._logBlock("trade", closeLines);

        if (this.sessionId && pos.dbId) {
          try {
            await this._closeTradeInDb(pos, { exitPrice, pnl, pnlPct, fee, reason, closeTime: new Date(closeTime).toISOString() });
            onEngineTradeClose(pos.dbId, pnl);
          } catch (dbErr) {
            // Dry-run: tidak fatal, tapi jangan ditelan diam-diam (audit trail).
            this._log("warn", `Gagal tutup trade #${pos.dbId} (dry-run) di DB: ${dbErr.message}`);
          }
        }

        this._notifyClose({
          symbol:     this.config.symbol,
          side:       pos.side,
          entryPrice: pos.entry,
          exitPrice,
          pnl,
          pnlPct,
          reason,
          dryRun:     this.config.dryRun,
        });

        this.state.trades.push({ ...pos, size: remaining, exit: exitPrice, pnl, pnlPct, fee, reason, closedAt: closeTime });
        this._capTrades();
        this._updateRiskAfterClose(pnl, pos);
        toClose.push(pos.id);
      }
    }
    this.state.openPositions = this.state.openPositions.filter(p => !toClose.includes(p.id));

    // Sync session stats ke DB setelah posisi ditutup (dry run)
    if (toClose.length > 0) this._syncSessionStats();
  }

  // ─────────────────────────────────────────────
  // FEE — estimasi & resolusi biaya trading
  // ─────────────────────────────────────────────
  /**
   * Estimasi fee trading round-trip (entry + exit) dari notional.
   * Fee Bitget dihitung atas notional penuh (harga × size), bukan margin.
   * Inilah penyebab gap "Net PnL gross" vs balance riil: fee tak pernah dikurangi.
   */
  _estimateFee(entryPrice, exitPrice, size) {
    return estimateRoundTripFee(entryPrice, exitPrice, size, {
      feeRate: this.config.feeRate,
      entryMode: this.config.entryMode,
      makerFeeRate: this.config.makerFeeRate,
    });
  }

  /**
   * Tentukan fee untuk satu close.
   * - LIVE: coba fee aktual dari exchange (fetchMyTrades); fallback estimasi.
   * - DRY-RUN/backtest: selalu estimasi notional × feeRate.
   * @returns {Promise<number>} fee absolut (≥0)
   */
  async _resolveFee(pos, exitPrice, size) {
    const estimate = this._estimateFee(pos.entry, exitPrice, size);
    if (this.config.dryRun || !this.client?.getRecentFillFee) return estimate;
    try {
      const openedAt = typeof pos.openTime === "number"
        ? pos.openTime
        : Date.parse(pos.openTime || 0);
      const actual = await this.client.getRecentFillFee(this.config.symbol, openedAt || 0);
      return Number.isFinite(actual) && actual > 0 ? actual : estimate;
    } catch {
      return estimate;
    }
  }

  /**
   * Lepas reservasi margin di koordinator akun bila bot ini sudah FLAT
   * (tidak ada posisi terbuka). Aman dipanggil berkali-kali (idempotent).
   * Tiap bot = 1 simbol = maksimal 1 posisi, jadi flat ⇒ margin bisa dilepas. (#5)
   */
  _releaseMarginIfFlat() {
    if (!this.config.coordinator) return;
    if (this.state.openPositions.length > 0) return;
    const botKey = this.config.botKey || `${this.config.userId ?? "anon"}:${this.config.symbol}`;
    this.config.coordinator.release(botKey);
  }

  // ─────────────────────────────────────────────
  // SYNC SESSION STATS — update DB setelah tiap trade tutup
  // ─────────────────────────────────────────────
  _syncSessionStats() {
    if (!this.sessionId) return;
    try {
      const closed    = this.state.trades.filter(t => !t.partial); // hanya trade utama (bukan partial SL+)
      const wins      = closed.filter(t => t.pnl > 0).length;
      const losses    = closed.filter(t => t.pnl <= 0).length;
      // total_trades = closed saja, open positions belum dihitung agar win rate tidak anomali
      const total     = closed.length;
      // final_capital pakai NET (pnl - fee - funding) agar cocok balance riil
      const tradeNet  = this.state.trades.reduce((s, t) => s + ((t.pnl || 0) - (t.fee || 0) - (t.funding || 0)), 0);
      const finalCap  = this.state.startCapital + tradeNet;
      db.updateSessionStats(this.sessionId, { finalCapital: finalCap, totalTrades: total, wins, losses });
    } catch { /* jangan crash */ }
  }

  // ─────────────────────────────────────────────
  // STATUS REPORT
  // ─────────────────────────────────────────────
  _statusReport() {
    const totalPnL = this.state.trades.reduce((s, t) => s + t.pnl, 0);
    const wins     = this.state.trades.filter(t => t.pnl > 0).length;
    this._sep("STATUS REPORT");
    this._log("info", `Capital: $${this.state.capital.toFixed(2)} | PnL: ${totalPnL > 0 ? "+" : ""}$${totalPnL.toFixed(2)}`);
    this._log("info", `Trades: ${this.state.trades.length} | Wins: ${wins} | WR: ${this._winRate()}%`);
    this._log("info", `Open positions: ${this.state.openPositions.length}`);
    this._sep();
  }

  _winRate() {
    if (this.state.trades.length === 0) return 0;
    const wins = this.state.trades.filter(t => t.pnl > 0).length;
    return ((wins / this.state.trades.length) * 100).toFixed(1);
  }
}

module.exports = BotEngine;
