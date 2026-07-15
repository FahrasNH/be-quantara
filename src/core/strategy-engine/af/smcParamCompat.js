"use strict";

/**
 * Migrate legacy `sac*` SMC config keys → canonical `smc*` (Smart Money Concepts).
 * Old bots/backtests saved with `sacMinConfidenceA`, etc. keep working: sac values
 * copy to smc only when smc is undefined (smc wins on conflict).
 */

const SAC_KEY_RE = /^sac([A-Z].*)$/;

const LEG_CONF_CANON = {
  smcMinConfidenceA: "smcMinConfidenceScalping",
  smcMinConfidenceB: "smcMinConfidenceIntraday",
  smcMinConfidenceC: "smcMinConfidenceSwing",
  smcMinConfidenceALong: "smcMinConfidenceScalpingLong",
  smcMinConfidenceAShort: "smcMinConfidenceScalpingShort",
};

const LEG_CONF_LEGACY = Object.fromEntries(
  Object.entries(LEG_CONF_CANON).map(([legacy, canon]) => [canon, legacy]),
);

const TYPE_OVERRIDE_KEYS = new Set([
  "Scalping", "Intraday", "Swing", "A", "B", "C",
]);

function migrateLegConfidenceKeys(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = { ...obj };
  for (const [legacy, canon] of Object.entries(LEG_CONF_CANON)) {
    if (out[legacy] !== undefined && out[canon] === undefined) {
      out[canon] = out[legacy];
    }
    if (out[canon] !== undefined && out[legacy] === undefined) {
      out[legacy] = out[canon];
    }
  }
  return out;
}

function migrateSacKeys(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;

  const out = migrateLegConfidenceKeys({ ...obj });
  for (const [key, val] of Object.entries(obj)) {
    const m = key.match(SAC_KEY_RE);
    if (m) {
      const smcKey = `smc${m[1]}`;
      if (out[smcKey] === undefined) out[smcKey] = val;
    }
  }

  if (out.typeOverrides && typeof out.typeOverrides === "object" && !Array.isArray(out.typeOverrides)) {
    const next = { ...out.typeOverrides };
    for (const [typeName, ov] of Object.entries(out.typeOverrides)) {
      if (ov && typeof ov === "object" && !Array.isArray(ov)) {
        next[typeName] = TYPE_OVERRIDE_KEYS.has(typeName) ? migrateSacKeys(migrateLegConfidenceKeys(ov)) : ov;
      }
    }
    out.typeOverrides = next;
  }

  return out;
}

/** @param {Record<string, unknown>} [config] */
function normalizeSmcParams(config = {}) {
  return migrateSacKeys(config);
}

module.exports = { normalizeSmcParams, migrateSacKeys, migrateLegConfidenceKeys, SAC_KEY_RE, LEG_CONF_CANON, LEG_CONF_LEGACY };
