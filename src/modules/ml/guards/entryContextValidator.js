"use strict";

/**
 * Sprint 18 — entryContext schema validation for MLGateService.
 * Fail-open: malformed data returns { error, value } without throwing.
 */

const VALID_SESSIONS = new Set(["Sydney", "Tokyo", "London", "New York", "Asia", "NY"]);
const VALID_PAIR_TIERS = new Set(["LIQUID", "MICRO", "VOLATILE", "STABLE"]);

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isOptionalNumber(v) {
  return v == null || isFiniteNumber(v);
}

function isOptionalString(v) {
  return v == null || typeof v === "string";
}

/**
 * Lightweight schema validation (no external deps).
 * Required fields are relaxed for backtest/cold-start paths — only validate
 * types when fields are present; winningComponent + pairTier required when set.
 *
 * @param {object} entryContext
 * @returns {{ error: { message: string }|null, value: object }}
 */
function validateEntryContext(entryContext) {
  const ctx = entryContext && typeof entryContext === "object" ? entryContext : {};
  const errors = [];

  if (ctx.winningComponent != null && typeof ctx.winningComponent !== "string") {
    errors.push("winningComponent must be a string");
  }
  if (ctx.signalDelayMs != null && (!isFiniteNumber(ctx.signalDelayMs) || ctx.signalDelayMs < 0)) {
    errors.push("signalDelayMs must be a number >= 0");
  }
  if (ctx.session != null && !VALID_SESSIONS.has(ctx.session)) {
    errors.push(`session must be one of ${[...VALID_SESSIONS].join(", ")}`);
  }
  if (!isOptionalNumber(ctx.hodPrice) || (ctx.hodPrice != null && ctx.hodPrice < 0)) {
    errors.push("hodPrice must be a number >= 0 or null");
  }
  if (!isOptionalNumber(ctx.lodPrice) || (ctx.lodPrice != null && ctx.lodPrice < 0)) {
    errors.push("lodPrice must be a number >= 0 or null");
  }
  if (!isOptionalString(ctx.htfTrend) && !isOptionalString(ctx.htfAlignment)) {
    errors.push("htfTrend must be a string or null");
  }
  const conf = ctx.confidence ?? ctx.confidenceScore;
  if (conf != null && (!isFiniteNumber(conf) || conf < 0 || conf > 100)) {
    errors.push("confidence must be a number between 0 and 100");
  }
  if (ctx.atr != null && (!isFiniteNumber(ctx.atr) || ctx.atr < 0)) {
    errors.push("atr must be a number >= 0");
  }
  if (ctx.pairTier != null && !VALID_PAIR_TIERS.has(String(ctx.pairTier).toUpperCase())) {
    errors.push(`pairTier must be one of ${[...VALID_PAIR_TIERS].join(", ")}`);
  }
  if (ctx.liquidationLevels != null && !Array.isArray(ctx.liquidationLevels)) {
    errors.push("liquidationLevels must be an array or null");
  }

  if (errors.length) {
    return { error: { message: errors.join("; ") }, value: ctx };
  }
  return { error: null, value: ctx };
}

module.exports = {
  validateEntryContext,
  VALID_SESSIONS,
  VALID_PAIR_TIERS,
};
