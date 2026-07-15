/**
 * Log/display formatters used by the live execution loop.
 * Pure helpers — no exchange, DB, or EventEmitter coupling.
 */

/** ADAPTIVE_FUSION → "Adaptive Fusion" (UI log panel). */
function stratLabel(key) {
  if (!key) return "—";
  return String(key).toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Holding duration → "22H 6M" (or "6M" under an hour). */
function fmtHoldingMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}H ${m}M` : `${m}M`;
}

/**
 * Price for logs only — order prices are tick-sized by exchange clients.
 * Cheap coins (e.g. XPL @ $0.094) need more decimals than "$0.09".
 */
function fmtPx(price) {
  const n = Number(price);
  if (!Number.isFinite(n)) return String(price);
  const abs = Math.abs(n);
  let max;
  if (abs >= 1) max = 2;
  else if (abs >= 0.1) max = 4;
  else if (abs >= 0.01) max = 5;
  else if (abs >= 0.001) max = 6;
  else if (abs > 0) max = 8;
  else max = 2;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: max });
}

module.exports = { stratLabel, fmtHoldingMs, fmtPx };
