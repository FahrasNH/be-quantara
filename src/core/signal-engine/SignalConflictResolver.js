/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SignalConflictResolver.js — Resolusi konflik arah antar strategi (Multi-Strategy)
 *
 * Pada fitur "Auto Multi-Strategy Execution per Coin", beberapa strategi berjalan
 * serentak pada SATU koin. Tiap strategi bisa memfire LONG, SHORT, atau diam (null).
 * Modul ini memutuskan signal mana yang BOLEH dieksekusi agar tidak membuka posisi
 * berlawanan arah pada simbol yang sama (LONG + SHORT serentak = hedge tak disengaja).
 *
 * PURE FUNCTION — tanpa side-effect, tanpa I/O, mudah di-unit-test.
 *
 * Aturan (default conflictMode = "skip"):
 *   Rule 1: Semua LONG            → eksekusi semua (entry terdiversifikasi)
 *   Rule 2: Semua SHORT           → eksekusi semua
 *   Rule 3: Campur LONG + SHORT   → SKIP semua (konflik, tidak ada entry)
 *   Rule 4: Satu fire, lain diam  → eksekusi yang fire
 *
 * conflictMode = "majority" (tunable, mitigasi risiko "terlalu konservatif"):
 *   Campur LONG + SHORT → ikuti arah mayoritas, drop minoritas. Seri → SKIP semua.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

/**
 * @typedef {Object} StrategySignal
 * @property {string}  strategyKey  — mis. "ADAPTIVE_FUSION"
 * @property {("LONG"|"SHORT"|null)} direction — arah signal (null = tidak fire)
 *   Field lain (slPrice, tpPrice, dst.) dibiarkan apa adanya dan ikut diteruskan.
 */

/**
 * @typedef {Object} ConflictResolution
 * @property {StrategySignal[]} execute   — signal yang boleh dieksekusi
 * @property {StrategySignal[]} skipped   — signal yang di-drop (tidak fire / kalah konflik)
 * @property {boolean} conflict           — true bila ada arah berlawanan terdeteksi
 * @property {("LONG"|"SHORT"|null)} direction — arah net yang dieksekusi (null = tidak ada)
 * @property {string}  reason             — penjelasan singkat untuk logging
 */

const VALID_DIRECTIONS = new Set(["LONG", "SHORT"]);

/** Normalisasi arah signal → "LONG" | "SHORT" | null. */
function normalizeDirection(sig) {
  const d = sig && typeof sig.direction === "string" ? sig.direction.toUpperCase() : null;
  return VALID_DIRECTIONS.has(d) ? d : null;
}

/**
 * Resolve konflik arah antar signal strategi pada satu simbol.
 *
 * @param {StrategySignal[]} signals
 * @param {Object} [opts]
 * @param {("skip"|"majority")} [opts.conflictMode="skip"]
 * @returns {ConflictResolution}
 */
function resolveConflicts(signals, opts = {}) {
  const conflictMode = opts.conflictMode === "majority" ? "majority" : "skip";

  const list = Array.isArray(signals) ? signals : [];

  // Pisahkan signal yang fire (punya arah valid) dari yang diam.
  const firing = [];
  const idle = [];
  for (const sig of list) {
    if (normalizeDirection(sig)) firing.push(sig);
    else idle.push(sig);
  }

  // Tidak ada yang fire → tidak ada entry (bukan konflik).
  if (firing.length === 0) {
    return {
      execute: [],
      skipped: idle,
      conflict: false,
      direction: null,
      reason: "Tidak ada strategi yang memfire signal",
    };
  }

  const longs = firing.filter((s) => normalizeDirection(s) === "LONG");
  const shorts = firing.filter((s) => normalizeDirection(s) === "SHORT");

  // Rule 1, 2, 4: semua searah (atau hanya satu yang fire) → eksekusi semua yang fire.
  if (longs.length === 0 || shorts.length === 0) {
    const direction = longs.length > 0 ? "LONG" : "SHORT";
    return {
      execute: firing,
      skipped: idle,
      conflict: false,
      direction,
      reason: `${firing.length} strategi searah ${direction} → eksekusi semua`,
    };
  }

  // Rule 3: campur LONG + SHORT → konflik arah.
  if (conflictMode === "majority") {
    if (longs.length === shorts.length) {
      // Seri → tidak ada mayoritas → skip semua (aman).
      return {
        execute: [],
        skipped: firing.concat(idle),
        conflict: true,
        direction: null,
        reason:
          `Konflik arah seri (LONG ${longs.length} vs SHORT ${shorts.length}) ` +
          `— tidak ada mayoritas, skip semua`,
      };
    }
    const winners = longs.length > shorts.length ? longs : shorts;
    const losers = longs.length > shorts.length ? shorts : longs;
    const direction = winners === longs ? "LONG" : "SHORT";
    return {
      execute: winners,
      skipped: losers.concat(idle),
      conflict: true,
      direction,
      reason:
        `Konflik arah → mayoritas ${direction} ` +
        `(${winners.length} vs ${losers.length}) dieksekusi, minoritas di-drop`,
    };
  }

  // conflictMode = "skip" (default) → tidak ada entry sama sekali.
  return {
    execute: [],
    skipped: firing.concat(idle),
    conflict: true,
    direction: null,
    reason:
      `Konflik arah terdeteksi (LONG: ${longs
        .map((s) => s.strategyKey)
        .join(",")} vs SHORT: ${shorts
        .map((s) => s.strategyKey)
        .join(",")}) — skip semua entry`,
  };
}

module.exports = { resolveConflicts, normalizeDirection };
