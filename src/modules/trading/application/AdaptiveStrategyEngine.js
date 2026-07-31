/**
 * ─────────────────────────────────────────────
 * AdaptiveStrategyEngine.js — BotEngine Wrapper with AFS Support
 *
 * Extends BotEngine with Adaptive Fusion Strategy capabilities:
 * - Multi-strategy signal detection
 * - Position conflict detection
 * - Market-aware ranking
 * ─────────────────────────────────────────────
 */

const BotEngine = require("./BotEngine");
const PositionManager = require("../../../core/position-engine/PositionManager");
const { strategyRegistry } = require("../../../core/strategy-engine/index");
const { calcIndicators, detectHTFTrend, calcEMA, calcATR, calcADX } = require("../../../core/analytics-engine/indicators");
const { isMeanReversionKey } = require("../../../core/execution-engine");
const { isDuplicate } = require("../../../core/signal-engine/signalIdempotency");
const {
  buildAtrBaseline,
  resolveAtrLegOverride,
} = require("../../../core/risk-engine/entryRiskGates");
const log = require("#shared/logger").child({ component: "AdaptiveStrategyEngine" });
const {
  requiresHtfFailClosed,
  shouldBlockHtfDirectional,
} = require("../../../config/htfMode");

class AdaptiveStrategyEngine extends BotEngine {
  constructor(config = {}) {
    const strategyKey = config.strategyKey || "ADAPTIVE_FUSION";

    // Validate and load strategy
    const validation = strategyRegistry.validate(strategyKey);
    if (!validation.valid) {
      throw new Error(
        `Invalid strategy "${strategyKey}": ${validation.error}`
      );
    }

    // Initialize parent BotEngine
    super(config);

    // BotEngine hanya menyimpan this.config.symbol, tidak this.symbol.
    // Kita set eksplisit agar semua method di class ini bisa pakai this.symbol.
    this.symbol = this.config.symbol;

    // Pindahkan groupCoordinator KELUAR dari this.config → simpan sebagai properti
    // engine. Alasan: config di-JSON.stringify saat openSession; coordinator berisi
    // Timeout (setInterval) + referensi sirkular → "Converting circular structure
    // to JSON". Sebagai properti engine, tidak ikut diserialisasi.
    this.groupCoordinator = this.config.groupCoordinator || null;
    if (this.config.groupCoordinator) delete this.config.groupCoordinator;

    // Load strategy
    this.strategy = validation.strategy;
    this.strategyKey = strategyKey;

    // Position manager for conflict detection — race-to-confirm: max 1/symbol
    this.positionManager = new PositionManager(1);

    // MultiStrategyCoordinator conflict hooks (evaluate → applyConflictDecision)
    this._conflictAllowed = true;
    this._pendingSignal = null;

    // Restore positions from state
    if (this.state && this.state.openPositions) {
      for (const pos of this.state.openPositions) {
        this.positionManager.addPosition({
          id: pos.id,
          symbol: this.config.symbol,
          side: pos.side,
          entry: pos.entry,
          strategyKey: this.strategyKey,
        });
      }
    }

    log.info(
      `[AdaptiveStrategyEngine] Initialized with strategy: ${this.strategyKey}`
    );
  }

  /**
   * MultiStrategyCoordinator contract: expose the signal about to enter so
   * evaluate() can resolve LONG+SHORT conflicts across engines.
   */
  getPendingSignal() {
    return this._pendingSignal;
  }

  /**
   * MultiStrategyCoordinator contract: allow/block entry for this tick after
   * batch conflict resolution.
   */
  applyConflictDecision(allowed) {
    this._conflictAllowed = !!allowed;
  }

  /**
   * Get strategy rankings for current market conditions
   * Returns: [{ key, label, score, canActivate }, ...]
   */
  getStrategyRankings() {
    try {
      // Only works for Adaptive Fusion Strategy
      if (!this.strategy.rankByMarketConditions) {
        return null;
      }

      const marketConditions = {
        volatility: this.lastVolatility || 1.0,
        trend_strength: this.lastTrendStrength || 0.1,
      };

      const rankings = this.strategy.rankByMarketConditions(marketConditions);

      // Guard: rankByMarketConditions pada beberapa strategi bisa return null/object bukan array
      if (!Array.isArray(rankings)) return null;

      // Add activation check
      return rankings.map((r) => {
        const canActivate = this.strategy.canActivate(
          this.capital || this.config.capital,
          "NEUTRAL",
          marketConditions.volatility
        );
        return {
          ...r,
          canActivate: canActivate.allowed,
        };
      });
    } catch (err) {
      log.error("[AdaptiveStrategyEngine] Error getting rankings:", err);
      return null;
    }
  }

  /**
   * Get position conflicts
   */
  getPositionConflicts() {
    return this.positionManager.checkEntryConflict(this.symbol);
  }

  /**
   * Override _tick() for AFS multi-strategy scanning.
   *
   * Bug fixes (v2.2):
   *  1. _fetchLatestKlines() tidak ada di BotEngine → pakai this._fetchCandles()
   *  2. _calculateIndicators() tidak ada → pakai calcIndicators() (imported)
   *  3. lastIdx = klines.length-1 salah → pakai candles.length-2 (candle terkonfirmasi)
   *  4. this.symbol undefined → this.config.symbol (BotEngine tidak set this.symbol)
   *  5. _handleSignal dipanggil dengan (signal,candle,indicators) → (signal,price,atr,snap,opts)
   */
  async _tick() {
    // Guard stop: engine sudah dihentikan / diminta stop → jangan proses tick.
    // _tick di-override di sini, jadi guard parent BotEngine._tick tidak berlaku;
    // tanpa ini, tick zombie yang ter-antri sebelum clearInterval tetap bisa membuka
    // posisi setelah bot di-stop (langgar aturan: stop harus benar-benar berhenti).
    if (this._stopRequested || !this.state.running) {
      return;
    }
    try {
      // 1. Ambil data candle — method BotEngine yang benar
      const candles = await this._fetchCandles();
      if (!candles || candles.length < this.config.emaSlow + 20) {
        if (this.state.openPositions.length > 0) {
          await this._monitorOpenPositions(null, null, 0);
          this._syncPositionManager();
        }
        return;
      }

      // 2. Hitung indikator — fungsi domain (bukan method instance)
      const indicators = calcIndicators(candles, {
        emaFast:   this.config.emaFast,
        emaSlow:   this.config.emaSlow,
        emaTrend:  this.config.emaTrend,
        rsiPeriod: this.config.rsiPeriod,
        atrPeriod: this.config.atrPeriod,
      });

      // 3. Gunakan candle terkonfirmasi (n-2), sama seperti BotEngine parent
      const lastIdx = candles.length - 2;
      const price   = candles[lastIdx].close;
      const atr     = indicators.atr[lastIdx];

      // 4. Hitung volatility & trend_strength dari data nyata
      {
        const emaF = indicators.emaFast?.[lastIdx];
        const emaS = indicators.emaSlow?.[lastIdx];
        this.lastVolatility    = atr && price ? (atr / price) * 100 : 1.0;
        const emaDelta         = emaS > 0 ? Math.abs(emaF - emaS) / emaS : 0;
        this.lastTrendStrength = Math.min(emaDelta * 50, 1.0);
      }

      // 4b–5. Monitor SL/TP — pakai helper parent (_resolveSlTpMonitor) agar
      //      barHigh/barLow forming candle + ticker sama seperti BotEngine._tick().
      //      Sebelumnya hanya monitorPrice → intrabar wick bisa terlewat.
      await this._monitorOpenPositions(candles, price, atr);
      this._syncPositionManager();

      // 6. Jika posisi sudah penuh, skip deteksi sinyal baru
      if (this.state.openPositions.length >= this.config.maxPositions) return;
      if (this.config.legacyMonitorOnly) return;

      // Reset per-tick conflict state (MultiStrategyCoordinator.evaluate may set these)
      this._conflictAllowed = true;
      this._pendingSignal = null;

      // 6b. HTF trend filter — cerminkan logika BotEngine._tick() agar
      //     TrendMomentum (butuh htfTrend LONG/SHORT) dan MeanReversion
      //     (gate: htfTrend !== UNKNOWN) bekerja dengan benar.
      //     Override _tick() sebelumnya melewati blok ini → htfTrend selalu UNKNOWN.
      let htfCandlesCache = null;
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
            this._log("warn", `[HTF] Candles kosong untuk ${this.config.higherTf} — trend=UNKNOWN`);
          }
        } catch (err) {
          // FAIL-CLOSED: tanpa data regime HTF, jangan buka posisi baru (diblok
          // di 6c). Sebelumnya fail-open → 10/18 trade loss dry-run 11–12 Jun
          // masuk saat htfTrend=UNKNOWN. Posisi terbuka tetap dikelola normal.
          this.state.htfTrend = "UNKNOWN";
          this._log("warn", `[HTF] Fetch ${this.config.higherTf} gagal — trend=UNKNOWN: ${err.message}`);
        }
      }

      await this._refreshDailyRegime(candles[lastIdx]?.timestamp ?? Date.now());

      // 6c. FAIL-CLOSED — HTF dikonfigurasi tapi trend tak bisa ditentukan →
      //     blok entry baru (all HTF_Mode except OFF; mirror BotEngine STEP 3).
      if (
        this.config.higherTf
        && this.state.htfTrend === "UNKNOWN"
        && requiresHtfFailClosed(this.strategyKey)
      ) {
        if (this.state.checkCount % 10 === 1) {
          this._log("info", `🚫 [BLOK] HTF ${this.config.higherTf} tidak tersedia (fail-closed) — ${this.strategyKey}`);
        }
        return;
      }

      // 6d. PARITY BotEngine._tick(): lampirkan data HTF mentah ke indicators +
      //     htfTrendStrength. Tanpa ini TS structure gate (highsHTF/lowsHTF/htfIdx)
      //     dan filter kekuatan tren HTF tidak pernah aktif di mode multi-strategi →
      //     TF/MS membentuk sinyal tanpa konteks HTF lalu ditolak step 7a
      //     (REQUIRED_ALIGN) karena bentrok dengan htfTrend versi engine.
      let htfTrendStrength = null;
      if (htfCandlesCache?.length >= 30) {
        const hLast   = htfCandlesCache.length - 1;
        const hCloses = htfCandlesCache.map(c => c.close);
        const hHighs  = htfCandlesCache.map(c => c.high);
        const hLows   = htfCandlesCache.map(c => c.low);
        const hEmaF = calcEMA(hCloses, this.config.htfEmaFast)[hLast];
        const hEmaS = calcEMA(hCloses, this.config.htfEmaSlow)[hLast];
        const hAtr  = calcATR(hHighs, hLows, hCloses, this.config.atrPeriod || 14)[hLast];
        if (hAtr > 0) htfTrendStrength = Math.min(Math.abs(hEmaF - hEmaS) / hAtr, 1.0);
        indicators.highsHTF  = hHighs;
        indicators.lowsHTF   = hLows;
        indicators.closesHTF = hCloses;
      }

      // 6e. PARITY BotEngine._tick(): MEAN_REVERSION ADX regime gate (MD-SUB-01)
      //     membaca indicators.adx pada entry TF — tanpa ini gate regime MR mati.
      if (isMeanReversionKey(this.strategyKey) || isMeanReversionKey(this.config.signalType)) {
        indicators.adx = calcADX(indicators.highs, indicators.lows, indicators.closes, 14).adx;
      }

      // 7. Deteksi sinyal — kirim htfTrend dari state (bukan hardcoded "NEUTRAL")
      const signal = this.strategy.detectSignal(indicators, lastIdx, {
        ...this.config,
        balance:        this.capital || this.config.capital,
        volatility:     this.lastVolatility,
        trend_strength: this.lastTrendStrength,
        htfTrend:       this.state.htfTrend,
        htfTrendStrength,
        htfIdx:         htfCandlesCache?.length >= 30 ? htfCandlesCache.length - 1 : undefined,
        dailyRegime:    this.state.dailyRegime,
        // FEE-01/01b: knob entry-quality AF — diteruskan dari config bot/strategi
        // agar anti-chase & conviction-veto bisa di-tune live tanpa ubah kode.
        maxEntryExtensionATR: this.config.maxEntryExtensionATR,
        afRejectOnDissent:    this.config.afRejectOnDissent,
        afMinVotes:           this.config.afMinVotes,

        // single-position voting path used by this engine.
        afMinComponentConfidence: this.config.afMinComponentConfidence,
        afMinAggregateConfidence: this.config.afMinAggregateConfidence,

        // SL komponen-C (VOLATILE/SEMI_VOLATILE) aktif di multi-strategy engine.
        pairTier:             this.config.pairTier,
        tierOverrides:        this.config.tierOverrides,
      });

      if (!signal) return;

      // Expose for MultiStrategyCoordinator.evaluate() / getPendingSignal()
      this._pendingSignal = { direction: signal };

      // 7a. HTF directional block — REQUIRED_ALIGN only (TF, MS). SOFT_BIAS /
      //     CONTEXT_ONLY / REGIME_GATE pass htfTrend to strategy for scoring/gates.
      if (shouldBlockHtfDirectional(this.strategyKey, signal, this.state.htfTrend)) {
        // this._log → persist ke BotLog agar rejection terlihat di FE/DB (bukan console-only)
        this._log(
          "info",
          `[HTF] ${signal} diblok — ${this.config.higherTf} `
          + `${this.state.htfTrend} (${this.strategyKey}, REQUIRED_ALIGN)`,
        );
        this._pendingSignal = null;
        return;
      }

      // 7b. RISK GATES — cooldown setelah loss, consec-loss, max trades/hari, daily
      //     loss, ATR range. Scalping uses atrGateRelative + rolling ATR baseline
      //     (parity with RealStrategyBacktestService) instead of absolute 0.8%.
      const sigMetaEarly = typeof this.strategy.getLastSignalMeta === "function"
        ? this.strategy.getLastSignalMeta()
        : null;
      const atrLegOv = resolveAtrLegOverride(
        this.config,
        sigMetaEarly?.component || sigMetaEarly?.winningComponent || null,
      );
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
      const riskGate = this._checkRiskGates(atr, price, atrGateCfg);
      if (!riskGate.ok) {
        // this._log → persist ke BotLog; throttle tiap 2 tick agar tidak membanjiri DB
        if (this.state.checkCount % 2 === 1) {
          this._log("info", `[RISK-GATE] ${this.strategyKey}: ${riskGate.reason}`);
        }
        return;
      }


      //     _fetchCandles cache hingga 15 menit → confirmed candle bisa identik antar
      //     tick → entry/SL/TP identik berulang. Key = symbol+strategy+candleTime+arah.
      const candleOpenTime = candles[lastIdx].timestamp ?? candles[lastIdx].openTime ?? candles[lastIdx].time;
      if (isDuplicate({
        symbol:         this.config.symbol,
        strategy:       this.strategyKey,
        candleOpenTime,
        direction:      signal,
      })) {
        // this._log → persist ke BotLog; throttle tiap 2 tick agar tidak membanjiri DB
        if (this.state.checkCount % 2 === 1) {
          this._log("info", `[DUPLICATE] ${this.strategyKey}: ${signal} @candle ${candleOpenTime}`);
        }
        return;
      }

      // 8. Cek konflik posisi — gunakan this.config.symbol
      const conflict = this.positionManager.checkEntryConflict(this.config.symbol);
      if (!conflict.allowed) {
        this._log("info", `[CONFLICT] ${this.strategyKey}: ${conflict.reason}`);
        return;
      }

      // 9. Validasi entry — degrade mulus bila strategi tidak mengimplementasikan
      //    validateEntry (jangan crash tick; anggap valid agar detectSignal yang memutuskan).
      let validation = { valid: true, reason: "no validateEntry" };
      if (typeof this.strategy.validateEntry === "function") {
        try {
          const sigMeta = typeof this.strategy.getLastSignalMeta === "function"
            ? this.strategy.getLastSignalMeta()
            : null;
          const legName = sigMeta?.component || sigMeta?.winningComponent;
          const legOverride = legName
            ? (this.config.typeOverrides?.[legName] || {})
            : atrLegOv;
          validation = this.strategy.validateEntry(
            price,
            atr,
            candles[lastIdx].volume,
            indicators.volSMA?.[lastIdx] || 0,
            { ...this.config, ...legOverride, _atrBaseline: atrBaselineNow, atrBaseline: atrBaselineNow }
          );
        } catch (e) {
          // Strategi belum implement → jangan blokir, log sekali per beberapa tick
          validation = { valid: true, reason: `validateEntry skip: ${e.message}` };
        }
      }

      if (!validation.valid) {
        this._log("info", `[VALIDATE] ${this.strategyKey}: entry ditolak — ${validation.reason}`);
        return;
      }

      // 10. GATE lintas-strategi (cap per-koin + proteksi hedge). Dipanggil hanya
      //     bila engine bagian dari grup multi-strategi (punya groupCoordinator).
      const groupCoord = this.groupCoordinator;
      if (groupCoord && typeof groupCoord.canEnter === "function") {
        const gate = await groupCoord.canEnter(this.strategyKey, signal);
        if (!gate.allowed) {
          if (this.state.checkCount % 5 === 1) {
            this._log("info", `[GROUP-GATE] ${this.strategyKey}: ${gate.reason}`);
          }
          return;
        }
      }

      // 11. Bangun indicatorSnapshot SCALAR (bukan array mentah) dengan atribusi
      //     strategi. Sebelumnya AFS engine mengirim `indicators` mentah (berisi
      //     array rsi[]/atr[]/emaFast[]/emaSlow[]) tanpa field `strategy` →
      //     insight CSV men-dump array & strategy kosong. Mirror BotEngine snapshot.
      const emaTrendVal = indicators.emaTrend?.[lastIdx] ?? null;
      const volNow      = candles[lastIdx].volume ?? 0;
      const volSMANow   = indicators.volSMA?.[lastIdx] ?? 0;
      const indicatorSnapshot = {
        rsi:          indicators.rsi?.[lastIdx]     != null ? parseFloat(indicators.rsi[lastIdx].toFixed(2))   : null,
        atr:          atr != null ? parseFloat(atr.toFixed(4)) : null,
        atrPct:       atr && price ? parseFloat(((atr / price) * 100).toFixed(3)) : null,
        emaFast:      indicators.emaFast?.[lastIdx] != null ? parseFloat(indicators.emaFast[lastIdx].toFixed(4)) : null,
        emaSlow:      indicators.emaSlow?.[lastIdx] != null ? parseFloat(indicators.emaSlow[lastIdx].toFixed(4)) : null,
        emaTrendVal:  emaTrendVal != null ? parseFloat(emaTrendVal.toFixed(4)) : null,
        emaTrendBias: emaTrendVal != null ? (price > emaTrendVal ? "bullish" : "bearish") : null,
        volumeRatio:  volSMANow > 0 ? parseFloat((volNow / volSMANow).toFixed(2)) : null,
        htfTrend:     this.state.htfTrend ?? "NEUTRAL",
        strategy:     this.strategyKey ?? null,
        entryMode:    "multi_strategy",
      };

      // 11b. HARGA ENTRY = ticker live, BUKAN close candle confirmed (basi s/d
      //      15 menit). Fail-closed: jika exchange punya getTicker tapi fetch
      //      gagal, skip entry tick ini — jangan buka posisi di harga fiktif.
      //      Reuse lastPrice dari pass SL/TP di atas bila sudah di-set.
      let entryPrice = price;
      if (this.client?.getTicker) {
        let livePrice = this.state.lastPrice;
        if (livePrice == null || livePrice <= 0) {
          try {
            const ticker = await this.client.getTicker(this.config.symbol);
            if (ticker?.last > 0) livePrice = ticker.last;
          } catch { /* livePrice tetap null */ }
        }
        if (livePrice == null) {
          log.info(`[${this.config.symbol}] 🚫 Skip entry (${this.strategyKey}): ticker tidak tersedia — hindari entry di harga basi`);
          return;
        }
        entryPrice = livePrice;
      }

      // 11c. GUARD SINYAL BASI — jika harga riil sudah bergerak > 1×ATR dari
      //      close candle yang memicu sinyal, setup sudah tidak relevan
      //      (penyebab pola "SL dalam 1 menit" pada data 11–12 Jun).
      if (atr > 0 && Math.abs(entryPrice - price) > atr) {
        log.info(
          `[${this.config.symbol}] 🚫 Skip entry (${this.strategyKey}): harga live $${entryPrice} ` +
          `sudah ${(Math.abs(entryPrice - price) / atr).toFixed(1)}×ATR dari candle sinyal $${price} — sinyal basi`
        );
        return;
      }

      // 11d. SL/TP PER-KOMPONEN (P1) — sebelumnya _handleSignal dipanggil TANPA
      //      options → SL selalu 1.5×ATR & TP 2×SL dari config default, fix P1
      //      (calculateRiskConfig) jadi dead code di jalur multi_strategy.
      //      Data 11–12 Jun: 18/18 trade pakai 1.5×ATR walau komponen C menang.
      const signalOptions = {};
      const meta = typeof this.strategy.getLastSignalMeta === "function"
        ? this.strategy.getLastSignalMeta()
        : null;
      if (meta && typeof this.strategy.calculateRiskConfig === "function") {
        const riskCfg = this.strategy.calculateRiskConfig(entryPrice, atr, signal, meta.component, {
          marketCond: meta.marketCond,
          strongTrendTPMult: this.config.strongTrendTPMult ?? 1,
        });
        signalOptions.slDist = riskCfg.slDistance;
        signalOptions.tpDist = riskCfg.tpDistance;
        indicatorSnapshot.afComponent  = meta.component;
        indicatorSnapshot.afVotes      = meta.votes;
        indicatorSnapshot.afMarketCond = meta.marketCond;
        indicatorSnapshot.afConfidence = meta.componentConfidence ?? null;
        indicatorSnapshot.afAggregateConfidence = meta.aggregateConfidence ?? null;
        const tpMultNote = riskCfg.strongTrendTPApplied
          ? ` | TP×${this.config.strongTrendTPMult} (STRONG_TREND)`
          : "";
        const confNote = meta.aggregateConfidence != null ? ` | Conf ${meta.aggregateConfidence}%` : "";
        log.info(
          `[${this.config.symbol}] [AF] Component: ${meta.component} | Votes: ${JSON.stringify(meta.votes)} | ` +
          `RR 1:${riskCfg.riskReward} | SL×${riskCfg.slMultiplier} TP×${riskCfg.tpMultiplier}${tpMultNote}${confNote}`
        );
      }

      // 11e. Batch conflict decision from MultiStrategyCoordinator.evaluate()
      if (this._conflictAllowed === false) {
        log.info(`[${this.config.symbol}] Entry ditolak conflict resolver (${this.strategyKey})`);
        this._pendingSignal = null;
        return;
      }

      // 12. Eksekusi — signature BotEngine: (signal, price, atr, indicatorSnapshot, options)
      await this._handleSignal(signal, entryPrice, atr, indicatorSnapshot, signalOptions);
      this._pendingSignal = null;
    } catch (err) {
      log.error(`[${this.config.symbol}] Tick error:`, err.message);
    }
  }

  /**
   * Override _handleSignal() to track positions.
   * Signature harus sama dengan BotEngine: (signal, price, atr, indicatorSnapshot, options)
   */
  async _handleSignal(signal, price, atr, indicatorSnapshot = null, options = {}) {
    try {
      // Panggil parent dengan signature yang benar
      const result = await super._handleSignal(signal, price, atr, indicatorSnapshot, options);

      // Track position di manager
      if (result && result.positionId) {
        this.positionManager.addPosition({
          id: result.positionId,
          symbol: this.config.symbol,
          side: signal,
          entry: price,
          strategyKey: this.strategyKey,
          timestamp: new Date().getTime(),
        });

        log.info(`[${this.config.symbol}] Position tracked: ${result.positionId}`);
      }

      return result;
    } catch (err) {
      log.error(`[${this.config.symbol}] Signal handling error:`, err.message);
      throw err;
    }
  }

  /**
   * Sync positions from state to position manager.
   *
   * PENTING: method ini SENGAJA TIDAK bernama _checkOpenPositions agar tidak
   * menutupi (shadow) BotEngine._checkOpenPositions(price, atr) yang melakukan
   * pengecekan SL/TP + penutupan posisi. Sebelumnya method ini bernama
   * _checkOpenPositions() tanpa argumen → memblokir logika SL/TP parent →
   * posisi tidak pernah close meski harga sudah lewat TP.
   */
  _syncPositionManager() {
    if (!this.state || !this.state.openPositions) return;

    // Get positions tracked in state
    const statePositions = new Set(
      this.state.openPositions.map((p) => p.id)
    );

    // Get positions in manager
    const managerPositions = new Set(
      this.positionManager.getAll().map((p) => p.id)
    );

    // Remove positions closed in state
    for (const id of managerPositions) {
      if (!statePositions.has(id)) {
        this.positionManager.removePosition(id);
        log.info(`[${this.config.symbol}] Position removed from manager: ${id}`);
      }
    }

    // Add positions from state not in manager
    for (const pos of this.state.openPositions) {
      if (!managerPositions.has(pos.id)) {
        this.positionManager.addPosition({
          id: pos.id,
          symbol: this.config.symbol,
          side: pos.side,
          entry: pos.entry,
          strategyKey: this.strategyKey,
        });
        log.info(`[${this.config.symbol}] Position added to manager: ${pos.id}`);
      }
    }
  }

  /**
   * Override getState() to include AFS data
   */
  getState() {
    const baseState = super.getState();

    return {
      ...baseState,
      strategy: this.strategyKey,
      afsEnabled: true,
      rankings: this.getStrategyRankings(),
      positionConflicts: this.positionManager.checkEntryConflict(
        this.config.symbol
      ),
      positionManager: this.positionManager.getSummary(),
    };
  }

  /**
   * Get metrics for monitoring
   */
  getMetrics() {
    const baseMetrics = super.getMetrics();

    return {
      ...baseMetrics,
      strategy: this.strategyKey,
      positionsOpen: this.positionManager.positions.size,
      positionsMax: this.positionManager.maxTotalPositions,
      rankings: this.getStrategyRankings(),
    };
  }
}

module.exports = AdaptiveStrategyEngine;
