"use strict";

/**
 * Sprint 18 — ML gate production safety guard.
 * Prevents ML_GATE_MODE=active in production until model training is validated.
 */

const ACTIVE_FORBIDDEN_MSG =
  "ML_GATE_MODE=active forbidden until model trained (Sprint 18-19). "
  + "Flip to active only after walk-forward validation + holdout test.";

function isProductionEnv() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function getMlGateMode() {
  return String(process.env.ML_GATE_MODE || "shadow").toLowerCase();
}

/**
 * Throws when production env has ML_GATE_MODE=active (untrained model risk).
 * Safe to call at server boot and BotEngine construction.
 */
function assertMlGateProductionSafety() {
  if (isProductionEnv() && getMlGateMode() === "active") {
    throw new Error(ACTIVE_FORBIDDEN_MSG);
  }
}

/**
 * Log shadow-mode confirmation at ML gate startup (non-blocking).
 */
function logMlGateStartupMode(mode = getMlGateMode()) {
  if (mode === "shadow") {
    console.log("[MLGateService] ML gate running in shadow mode (logging only)");
  } else if (mode === "disabled") {
    console.log("[MLGateService] ML gate disabled — bypassing win-probability gate");
  }
}

module.exports = {
  assertMlGateProductionSafety,
  logMlGateStartupMode,
  ACTIVE_FORBIDDEN_MSG,
  isProductionEnv,
  getMlGateMode,
};
