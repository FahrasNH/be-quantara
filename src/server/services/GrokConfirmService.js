/**
 * GrokConfirmService.js — Mode B: konfirmasi entry + adjust TP (AF/TM/MR/BR).
 */

const cfg = require("../../config/env");
const XaiClient = require("../../infrastructure/xai/XaiClient");
const GrokConfirmPromptBuilder = require("./GrokConfirmPromptBuilder");
const { getUserTier } = require("../../services/entitlement");
const { TIER_ORDER } = require("../../domain/tierConfig");
const { persistAiTradeInteraction } = require("../../infrastructure/db/aiTradeInteractionRepository");

const GROK_CONFIRM_SYSTEM_PROMPT = `You are a crypto futures trade confirmer for Bitget USDT-M.
A rule-based strategy has already fired a signal with proposed SL and TP from ATR math.
Your job:
1. Confirm or reject the ENTRY direction (confirm_entry, confidence 1-10).
2. Choose exit style: tp_mode "full" or "partial" (tp_mode_confidence 1-10, min 6 for partial).
   - full = hold until single take-profit (no scale-out milestones).
   - partial = scale out at +1R/+2R milestones, SL trails to BEP/+1R.
3. Review the proposed TP price — approve it, or suggest a better take_profit within reason.
NEVER change or suggest stop_loss — SL is fixed by the system.
Return ONLY valid JSON per schema.
Entry requires confidence >= 8. tp_mode partial requires tp_mode_confidence >= 6. TP review requires tp_confidence >= 7.

Required JSON schema:
{
  "confirm_entry": boolean,
  "confidence": 1-10,
  "side": "LONG|SHORT",
  "reasoning": "string",
  "tp_mode": "full|partial",
  "tp_mode_confidence": 1-10,
  "tp_review": {
    "approved": boolean,
    "tp_confidence": 1-10,
    "suggested_tp": number,
    "tp_reasoning": "string"
  } | null
}`;

class GrokConfirmService {
  static _client = null;

  /** Langganan tier VAULT (bukan flag aiOptimizer / paket backtest UI). */
  static hasVaultSubscription(tier) {
    const idx = TIER_ORDER.indexOf(tier);
    const vaultIdx = TIER_ORDER.indexOf("VAULT");
    return idx >= 0 && vaultIdx >= 0 && idx >= vaultIdx;
  }

  static get client() {
    if (!this._client) this._client = new XaiClient();
    return this._client;
  }

  /** API xAI siap dipanggil (kunci ada + client terkonfigurasi). */
  static isApiReady() {
    return Boolean(cfg.XAI_API_KEY) && this.client.isConfigured;
  }

  /** Live bot gate — butuh flag GROK_CONFIRM_ENABLED + API. */
  static isEnabled() {
    return cfg.GROK_CONFIRM_ENABLED === true && this.isApiReady();
  }

  /**
   * @param {string} userId
   * @param {{ backtest?: boolean }} [opts] — backtest hanya butuh XAI_API_KEY (toggle eksplisit di UI).
   */
  static async canUseGrokConfirm(userId, { backtest = false } = {}) {
    if (!userId) {
      return { allowed: false, reason: "Unauthorized — userId tidak ditemukan" };
    }

    if (backtest) {
      if (!this.isApiReady()) {
        return { allowed: false, reason: "XAI belum dikonfigurasi — set XAI_API_KEY di server" };
      }
      // Backtest: toggle eksplisit di UI + XAI_API_KEY cukup.
      // "Paket Vault" di backtest ≠ langganan akun — jangan gate subscription di sini.
      return { allowed: true, reason: "backtest" };
    }

    if (!this.isEnabled()) {
      if (!this.isApiReady()) {
        return { allowed: false, reason: "Grok Confirm belum dikonfigurasi (XAI_API_KEY kosong)" };
      }
      return { allowed: false, reason: "Grok Confirm belum diaktifkan — set GROK_CONFIRM_ENABLED=true" };
    }

    if (cfg.GROK_CONFIRM_OPEN === true || !cfg.isProduction) {
      return { allowed: true, reason: "dev/open mode" };
    }

    const tier = await getUserTier(userId);
    if (this.hasVaultSubscription(tier)) {
      return { allowed: true, reason: "tier" };
    }

    return {
      allowed: false,
      reason: `Grok Confirm Gate membutuhkan langganan Vault (tier akun kamu: ${tier})`,
      tier,
    };
  }

  static async requestConfirmation(ctx) {
    const backtest = ctx.backtest === true;
    const active = backtest ? this.isApiReady() : this.isEnabled();
    if (!active) {
      if (cfg.GROK_CONFIRM_FAIL_MODE === "open") {
        return { failOpen: true, confirm_entry: true, confidence: 10, tp_approved: true, tp_mode: "full", suggested_tp: null };
      }
      throw new Error(
        backtest
          ? "XAI belum dikonfigurasi — set XAI_API_KEY di server"
          : "Grok Confirm tidak aktif atau XAI_API_KEY kosong"
      );
    }

    const built = GrokConfirmPromptBuilder.build(ctx);
    let raw;
    try {
      raw = await this._callGrok(built.text);
    } catch (err) {
      if (cfg.GROK_CONFIRM_FAIL_MODE === "open") {
        return { failOpen: true, confirm_entry: true, confidence: 10, tp_approved: true, tp_mode: "full", suggested_tp: null, error: err.message };
      }
      throw err;
    }

    let parsed;
    try {
      parsed = this.parseResponse(raw);
    } catch (err) {
      if (cfg.GROK_CONFIRM_FAIL_MODE === "open") {
        return { failOpen: true, confirm_entry: true, confidence: 10, tp_approved: true, tp_mode: "full", suggested_tp: null, error: err.message };
      }
      throw err;
    }

    const validated = this.validateConfirmation(parsed, ctx);
    await this._logInteraction(ctx, built.text, raw, validated, "GROK_CONFIRM");
    return validated;
  }

  static async _callGrok(userContent, retry = true) {
    try {
      return await this.client.chat(
        [
          { role: "system", content: GROK_CONFIRM_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        {
          jsonMode: true,
          temperature: 0.2,
          maxTokens: 1024,
        }
      );
    } catch (err) {
      if (retry) return this._callGrok(userContent, false);
      throw err;
    }
  }

  static parseResponse(raw) {
    if (!raw || typeof raw !== "string") {
      throw new Error("Respons Grok kosong");
    }
    try {
      return JSON.parse(raw.trim());
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Grok mengembalikan JSON tidak valid");
      return JSON.parse(match[0]);
    }
  }

  static resolveTpMode(data, ctx = {}) {
    const minModeConf = ctx.minTpModeConfidence ?? cfg.GROK_CONFIRM_MIN_TP_MODE_CONFIDENCE ?? 6;
    const modeConf = Number(data.tp_mode_confidence ?? 0);
    const raw = String(data.tp_mode ?? "").toLowerCase().trim();
    if (modeConf >= minModeConf && raw === "partial") return "partial";
    return "full";
  }

  static validateConfirmation(data, ctx = {}) {
    const minEntry = ctx.minConfidenceEntry ?? cfg.GROK_CONFIRM_MIN_CONFIDENCE_ENTRY;
    const minTp = ctx.minTpConfidence ?? cfg.GROK_CONFIRM_MIN_TP_CONFIDENCE;

    const confidence = Number(data.confidence);
    const tp = data.tp_review || {};
    const tpConf = Number(tp.tp_confidence ?? 0);
    const tpMode = this.resolveTpMode(data, ctx);
    const tpModeConf = Number(data.tp_mode_confidence ?? 0);

    const entryOk = data.confirm_entry === true && Number.isFinite(confidence) && confidence >= minEntry;
    const tpOk = tp.approved === true && tpConf >= minTp;

    return {
      confirm_entry: entryOk,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      tp_approved: tpOk,
      tp_mode: tpMode,
      tp_mode_confidence: Number.isFinite(tpModeConf) ? tpModeConf : 0,
      suggested_tp: tp.suggested_tp != null ? Number(tp.suggested_tp) : null,
      tp_confidence: tpConf,
      reasoning: data.reasoning || "",
      tp_reasoning: tp.tp_reasoning ?? "",
      side: data.side,
      raw_confirm_entry: data.confirm_entry === true,
      raw_tp_approved: tp.approved === true,
      raw_tp_mode: String(data.tp_mode ?? ""),
    };
  }

  /**
   * Clamp suggested TP dalam band aman (§18.4).
   */
  static resolveTakeProfit({ tpRules, suggestedTp, side, price, atr, bandPct, maxAtrMult }) {
    const baseline = tpRules;
    if (suggestedTp == null || !Number.isFinite(suggestedTp)) return baseline;

    const tpDist = Math.abs(baseline - price);
    const bandAbs = tpDist * (bandPct / 100);
    const atrCap = atr * maxAtrMult;
    const shiftCap = Math.min(bandAbs, atrCap);

    let lo = baseline - shiftCap;
    let hi = baseline + shiftCap;

    if (side === "LONG") {
      lo = Math.max(lo, price + atr * 0.5);
    } else {
      hi = Math.min(hi, price - atr * 0.5);
    }

    return Math.min(hi, Math.max(lo, suggestedTp));
  }

  /**
   * Re-validasi R:R setelah TP adjust.
   */
  static validateRiskReward({ side, price, slPrice, tpPrice, minRiskReward = 1.2 }) {
    const slDist = Math.abs(price - slPrice);
    const tpDist = Math.abs(tpPrice - price);
    if (slDist <= 0) return { valid: false, riskReward: 0 };
    const rr = tpDist / slDist;
    return { valid: rr >= minRiskReward, riskReward: +rr.toFixed(3) };
  }

  /**
   * Terapkan hasil konfirmasi Grok → keputusan entry + TP final (mirror BotEngine).
   */
  static applyGate(confirm, ctx = {}) {
    const {
      side,
      price,
      atr,
      slPrice,
      tpRules,
      tpAdjust = true,
      tpBandPct = cfg.GROK_CONFIRM_TP_ADJUST_BAND_PCT,
      tpRejectAction = cfg.GROK_CONFIRM_TP_REJECT_ACTION,
      minRiskReward = 1.2,
    } = ctx;

    if (confirm?.failOpen) {
      return {
        approved: true,
        tp: tpRules,
        tpDist: Math.abs(tpRules - price),
        tpMode: confirm.tp_mode ?? "full",
        reason: confirm.error || "fail-open",
        confidence: confirm.confidence ?? 10,
        failOpen: true,
      };
    }

    if (!confirm?.confirm_entry) {
      return {
        approved: false,
        tp: null,
        tpDist: null,
        reason: confirm?.reasoning || "entry not confirmed",
        confidence: confirm?.confidence ?? 0,
        failOpen: false,
      };
    }

    if (!confirm.tp_approved && tpRejectAction === "skip") {
      return {
        approved: false,
        tp: null,
        tpDist: null,
        reason: confirm.tp_reasoning || "TP not approved",
        confidence: confirm.confidence ?? 0,
        failOpen: false,
      };
    }

    let finalTp = tpRules;
    const useGrokTp = tpAdjust !== false &&
      confirm.tp_approved &&
      confirm.suggested_tp != null &&
      Number.isFinite(confirm.suggested_tp);

    if (useGrokTp) {
      finalTp = this.resolveTakeProfit({
        tpRules,
        suggestedTp: confirm.suggested_tp,
        side,
        price,
        atr,
        bandPct: tpBandPct,
        maxAtrMult: cfg.GROK_CONFIRM_TP_MAX_ATR_MULT,
      });
    }

    const rrCheck = this.validateRiskReward({
      side,
      price,
      slPrice,
      tpPrice: finalTp,
      minRiskReward,
    });
    if (!rrCheck.valid) {
      return {
        approved: false,
        tp: null,
        tpDist: null,
        reason: `R:R ${rrCheck.riskReward} < min ${minRiskReward}`,
        confidence: confirm.confidence ?? 0,
        failOpen: false,
      };
    }

    return {
      approved: true,
      tp: finalTp,
      tpDist: Math.abs(finalTp - price),
      tpMode: confirm.tp_mode ?? "full",
      reason: confirm.reasoning || "",
      tpReasoning: confirm.tp_reasoning || "",
      confidence: confirm.confidence ?? 0,
      tpConfidence: confirm.tp_confidence ?? 0,
      tpMode: confirm.tp_mode ?? "full",
      tpModeConfidence: confirm.tp_mode_confidence ?? 0,
      failOpen: false,
    };
  }

  static async _logInteraction(ctx, prompt, response, parsed, type = "GROK_CONFIRM") {
    // Backtest mem-fire puluhan interaksi sekaligus — skip persist DB (hemat latency).
    if (cfg.GROK_TRADING_LOG_INTERACTIONS && ctx.userId && !ctx.backtest) {
      persistAiTradeInteraction({
        userId: ctx.userId,
        botId: ctx.botId,
        symbol: ctx.symbol,
        type,
        prompt,
        response,
        parsed,
      }).catch(() => {});
    }

    if (!parsed) return;
    const strat = ctx.strategyKey ?? "";
    if (parsed.confirm_entry) {
      console.log(
        `[GROK CONFIRM] ${strat} → ${ctx.side} approved ${parsed.confidence}/10 | ` +
        `TP conf ${parsed.tp_confidence}/10`
      );
    } else {
      console.log(
        `[GROK CONFIRM] ${strat} → ${ctx.side} rejected ${parsed.confidence}/10 | ` +
        `reason: ${parsed.reasoning || "entry not confirmed"}`
      );
    }
  }
}

module.exports = GrokConfirmService;
