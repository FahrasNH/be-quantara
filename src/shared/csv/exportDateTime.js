"use strict";

/** Common IANA zones → short labels shown in CSV (match TradingView presets). */
const TZ_SHORT_LABELS = Object.freeze({
  "Asia/Jakarta": "WIB",
  "Asia/Singapore": "SGT",
  "Asia/Bangkok": "ICT",
  "Asia/Manila": "PHT",
  "Asia/Kolkata": "IST",
  "Europe/London": "GMT",
  "America/New_York": "ET",
  "America/Chicago": "CT",
  "America/Los_Angeles": "PT",
});

/** Minutes east of UTC for CSV suffix labels (parse path). */
const LABEL_UTC_OFFSET_MINUTES = Object.freeze({
  WIB: 7 * 60,
  SGT: 8 * 60,
  ICT: 7 * 60,
  PHT: 8 * 60,
  IST: 5 * 60 + 30,
  UTC: 0,
  GMT: 0,
});

function resolveTimezoneLabel(ianaTz) {
  if (!ianaTz || ianaTz === "UTC") return "UTC";
  if (TZ_SHORT_LABELS[ianaTz]) return TZ_SHORT_LABELS[ianaTz];
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ianaTz,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    if (tzPart?.value) {
      return tzPart.value.replace(/^GMT([+-]\d+)/, "UTC$1").replace(/^GMT$/, "UTC");
    }
  } catch { /* invalid tz */ }
  return "UTC";
}

/**
 * Human-readable export datetime in a target IANA timezone.
 * e.g. "17 July 2026, 11:20 PM WIB" for Asia/Jakarta.
 */
function formatExportDateTime(isoStr, timeZone = "UTC") {
  if (isoStr == null || isoStr === "" || isoStr === "N/A") {
    return isoStr === "N/A" ? "N/A" : "";
  }
  try {
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return "N/A";
    const tz = timeZone || "UTC";
    const label = resolveTimezoneLabel(tz);
    const day = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: tz }).format(d);
    const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: tz }).format(d);
    const year = new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: tz }).format(d);
    const time = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: tz,
    }).format(d);
    return `${day} ${month} ${year}, ${time} ${label}`;
  } catch {
    return "N/A";
  }
}

function getUtcOffsetMinutesForLabel(label) {
  const key = String(label || "").toUpperCase();
  if (LABEL_UTC_OFFSET_MINUTES[key] != null) return LABEL_UTC_OFFSET_MINUTES[key];
  const m = key.match(/^UTC([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    const hrs = parseInt(m[2], 10);
    const mins = m[3] ? parseInt(m[3], 10) : 0;
    return sign * (hrs * 60 + mins);
  }
  return null;
}

/** Parse "DD Month YYYY, HH:MM AM/PM [LABEL]" where LABEL maps to a fixed UTC offset. */
function parseLabeledExportDateTime(raw) {
  const s = String(raw || "").trim();
  const m = s.match(
    /^(\d{1,2})\s+(\w+)\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s+(\S+)$/i,
  );
  if (!m) return null;
  const months = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const mo = months[m[2].toLowerCase()];
  if (mo == null) return null;
  let hour = parseInt(m[4], 10);
  const min = parseInt(m[5], 10);
  const ampm = m[6].toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  const offsetMin = getUtcOffsetMinutesForLabel(m[7]);
  if (offsetMin == null) return null;
  const localUtcMs = Date.UTC(parseInt(m[3], 10), mo, parseInt(m[1], 10), hour, min);
  return new Date(localUtcMs - offsetMin * 60 * 1000);
}

module.exports = {
  formatExportDateTime,
  resolveTimezoneLabel,
  getUtcOffsetMinutesForLabel,
  parseLabeledExportDateTime,
  TZ_SHORT_LABELS,
  LABEL_UTC_OFFSET_MINUTES,
};
