/**
 * GrokTradingService.js — prompt, parse, validate respons trade Grok (xAI).
 */

const cfg = require("../../../config/env");
const XaiClient = require("../../../infrastructure/xai/XaiClient");
const GrokTradingPromptBuilder = require("./GrokTradingPromptBuilder");
const { getUserTier } = require("../../users/services/entitlement");
const { getTierConfig } = require("../../../core/risk-engine/tierConfig");
const { persistAiTradeInteraction } = require("../../../infrastructure/db/aiTradeInteractionRepository");

const SYSTEM_PROMPT = `You are an expert crypto futures scalper on Bitget USDT-M perpetuals.
Analyze multi-timeframe indicator data and return ONLY valid JSON.
Be conservative: skip trades when timeframes conflict or volatility is too low.
Never invent prices — TP/SL must be realistic relative to current_price and ATR.
Confidence rules: only recommend entry (LONG/SHORT) when confidence >= 8; include take_profit/stop_loss when confidence >= 7.

Required JSON schema:
{
  "trades": [{ "symbol": "BTCUSDT", "side": "LONG|SHORT", "entry": "MARKET", "take_profit": number, "stop_loss": number, "confidence": 1-10, "reasoning": "string" }],
  "position_actions": [{ "symbol": "BTCUSDT", "action": "CLOSE|HOLD", "reasoning": "string" }]
}`;

class GrokTradingService {
  static _client = null;

  static get client() {
    if (!this._client) this._client = new XaiClient();
    return this._client;
  }

  static isEnabled() {
    return cfg.GROK_TRADING_ENABLED === true && Boolean(cfg.XAI_API_KEY);
  }

  static async canUseGrokTrading(userId) {
    if (!this.isEnabled()) return { allowed: false, reason: "Grok trading belum dikonfigurasi" };
    if (cfg.GROK_TRADING_OPEN === true || !cfg.isProduction) {
      return { allowed: true, reason: "dev/open mode" };
    }
    const tier = await getUserTier(userId);
    const tierCfg = getTierConfig(tier);
    if (tierCfg?.aiOptimizer) return { allowed: true, reason: "tier" };
    return {
      allowed: false,
      reason: "Grok Live Trading membutuhkan tier VAULT",
      tier,
    };
  }

  static async requestTradeDecision(ctx) {
    if (!this.isEnabled() || !this.client.isConfigured) {
      throw new Error("Grok trading tidak aktif atau XAI_API_KEY kosong");
    }

    const userPrompt = GrokTradingPromptBuilder.build(ctx);
    const raw = await this._callGrok(userPrompt.text);
    const parsed = this.parseResponse(raw);

    const trade = parsed.trades?.find(t => this._normSymbol(t.symbol) === this._normSymbol(ctx.symbol));
    if (!trade) {
      await this._logInteraction(ctx, userPrompt.text, raw, null, "NEW_TRADE");
      return null;
    }

    const validated = this.validateTrade(trade, ctx);
    await this._logInteraction(ctx, userPrompt.text, raw, validated, "NEW_TRADE");
    return validated;
  }

  static async requestPositionAction(ctx) {
    if (!this.isEnabled() || !this.client.isConfigured) {
      throw new Error("Grok trading tidak aktif atau XAI_API_KEY kosong");
    }

    const userPrompt = GrokTradingPromptBuilder.build({
      ...ctx,
      openPosition: ctx.position,
    });
    const raw = await this._callGrok(userPrompt.text);
    const parsed = this.parseResponse(raw);

    const action = parsed.position_actions?.find(
      a => this._normSymbol(a.symbol) === this._normSymbol(ctx.symbol)
    );
    const result = action ? { action: String(action.action || "").toUpperCase(), reasoning: action.reasoning || "" } : null;
    await this._logInteraction(ctx, userPrompt.text, raw, result, "POSITION_EVAL");
    return result;
  }

  static async _callGrok(userContent, retry = true) {
    try {
      return await this.client.chat(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        {
          jsonMode: true,
          temperature: cfg.GROK_TRADING_TEMPERATURE,
          maxTokens: cfg.GROK_TRADING_MAX_TOKENS,
        }
      );
    } catch (err) {
      if (retry) {
        return this._callGrok(userContent, false);
      }
      throw err;
    }
  }

  static parseResponse(raw) {
    if (!raw || typeof raw !== "string") {
      throw new Error("Respons Grok kosong");
    }
    let data;
    try {
      data = JSON.parse(raw.trim());
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Grok mengembalikan JSON tidak valid");
      data = JSON.parse(match[0]);
    }
    if (!Array.isArray(data.trades)) data.trades = [];
    if (!Array.isArray(data.position_actions)) data.position_actions = [];
    return data;
  }

  static validateTrade(trade, ctx = {}) {
    const minEntry = ctx.minConfidenceEntry ?? cfg.GROK_TRADING_MIN_CONFIDENCE_ENTRY;
    const minTpSl = ctx.minConfidenceTpSl ?? cfg.GROK_TRADING_MIN_CONFIDENCE_TP_SL;
    const entryPrice = ctx.price;
    const atr = ctx.atr;
    const atrMinMult = ctx.atrMinMult ?? 1.0;
    const minRiskReward = ctx.minRiskReward ?? 1.2;

    const reject = (reason) => ({
      valid: false,
      rejected: reason,
      side: trade.side,
      confidence: trade.confidence,
      reasoning: trade.reasoning || "",
      entryAllowed: false,
      tpSlValid: false,
    });

    if (this._normSymbol(trade.symbol) !== this._normSymbol(ctx.symbol)) {
      return reject("symbol_mismatch");
    }

    const confidence = Number(trade.confidence);
    if (!Number.isFinite(confidence) || confidence < 1 || confidence > 10) {
      return reject("invalid_confidence");
    }
    if (confidence < minTpSl) {
      return reject("confidence_below_tp_sl_threshold");
    }

    const side = String(trade.side || "").toUpperCase();
    if (side !== "LONG" && side !== "SHORT") {
      return reject("invalid_side");
    }

    const tp = Number(trade.take_profit);
    const sl = Number(trade.stop_loss);
    if (!Number.isFinite(tp) || !Number.isFinite(sl) || tp <= 0 || sl <= 0) {
      return reject("invalid_tp_sl");
    }
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return reject("invalid_entry_price");
    }

    if (side === "LONG") {
      if (!(sl < entryPrice && entryPrice < tp)) return reject("long_geometry_invalid");
    } else if (!(tp < entryPrice && entryPrice < sl)) {
      return reject("short_geometry_invalid");
    }

    const slDist = Math.abs(entryPrice - sl);
    if (atr > 0 && slDist < atrMinMult * atr) {
      return reject("sl_too_tight");
    }

    const tpDist = Math.abs(tp - entryPrice);
    const rr = slDist > 0 ? tpDist / slDist : 0;
    if (rr < minRiskReward) {
      return reject("risk_reward_too_low");
    }

    if (ctx.hasOpenPosition) {
      return reject("position_already_open");
    }

    const entryAllowed = confidence >= minEntry;
    const tpSlValid = confidence >= minTpSl;

    return {
      valid: tpSlValid,
      entryAllowed,
      tpSlValid,
      side,
      take_profit: tp,
      stop_loss: sl,
      confidence,
      reasoning: trade.reasoning || "",
      riskReward: +rr.toFixed(3),
      rejected: entryAllowed ? null : "confidence_below_entry_threshold",
    };
  }

  static _normSymbol(sym) {
    return String(sym || "").replace("/", "").replace(":USDT", "").toUpperCase();
  }

  static async _logInteraction(ctx, prompt, response, parsed, type = "NEW_TRADE") {
    if (cfg.GROK_TRADING_LOG_INTERACTIONS && ctx.userId) {
      persistAiTradeInteraction({
        userId: ctx.userId,
        botId: ctx.botId,
        symbol: ctx.symbol,
        type,
        prompt,
        response,
        parsed: parsed ?? null,
      }).catch(() => {});
    }

    const summary = parsed?.side
      ? `[GROK] ${parsed.side} ${ctx.symbol} | conf ${parsed.confidence}/10 | TP ${parsed.take_profit} | SL ${parsed.stop_loss}` +
        (parsed.reasoning ? ` | ${parsed.reasoning}` : "")
      : `[GROK] ${type} ${ctx.symbol} — no actionable signal`;
    console.log(summary);
  }
}

module.exports = GrokTradingService;
