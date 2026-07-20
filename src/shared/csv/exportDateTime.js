"use strict";

/** Common IANA zones → short labels shown in legacy CSV (parse path only). */
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

/** Minutes east of UTC for legacy CSV suffix labels (parse path). */
const LABEL_UTC_OFFSET_MINUTES = Object.freeze({
  WIB: 7 * 60,
  SGT: 8 * 60,
  ICT: 7 * 60,
  PHT: 8 * 60,
  IST: 5 * 60 + 30,
  UTC: 0,
  GMT: 0,
});

const SHORT_MONTHS = Object.freeze({
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
});

const LONG_MONTHS = Object.freeze({
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
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

function partValue(parts, type) {
  return parts.find((p) => p.type === type)?.value ?? "";
}

/**
 * Human-readable export datetime in a target IANA timezone (TradingView tooltip style).
 * e.g. "Fri 17 Jul '26  23:20" for Asia/Jakarta — no timezone suffix, 24-hour clock.
 */
function formatExportDateTime(isoStr, timeZone = "UTC") {
  if (isoStr == null || isoStr === "" || isoStr === "N/A") {
    return isoStr === "N/A" ? "N/A" : "";
  }
  try {
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return "N/A";
    const tz = timeZone || "UTC";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const dow = partValue(parts, "weekday");
    const day = partValue(parts, "day");
    const month = partValue(parts, "month");
    const year = partValue(parts, "year");
    let hour = partValue(parts, "hour");
    if (hour === "24") hour = "00";
    const minute = partValue(parts, "minute");
    return `${dow} ${day} ${month} '${year}  ${hour}:${minute}`;
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

/** Convert wall-clock components in an IANA zone to a UTC Date. */
function localDateTimeInZoneToUtc(year, monthIndex, day, hour, minute, timeZone) {
  const pad = (n) => String(n).padStart(2, "0");
  const iso = `${year}-${pad(monthIndex + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;
  let ms = new Date(`${iso}Z`).getTime();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const target = Date.UTC(year, monthIndex, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const shownParts = Object.fromEntries(
      formatter.formatToParts(new Date(ms))
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value]),
    );
    const shown = Date.UTC(
      +shownParts.year,
      +shownParts.month - 1,
      +shownParts.day,
      +shownParts.hour,
      +shownParts.minute,
    );
    ms += target - shown;
  }
  return new Date(ms);
}

/** Parse TradingView-style export datetime: "Thu 09 Jul '26  01:30". */
function parseTradingViewExportDateTime(raw, timeZone = "UTC") {
  const s = String(raw || "").trim();
  const m = s.match(
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{2})\s+(\w{3})\s+'(\d{2})\s{2}(\d{2}):(\d{2})$/i,
  );
  if (!m) return null;
  const monthIndex = SHORT_MONTHS[m[2].toLowerCase()];
  if (monthIndex == null) return null;
  const day = parseInt(m[1], 10);
  const year = 2000 + parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  return localDateTimeInZoneToUtc(year, monthIndex, day, hour, minute, timeZone || "UTC");
}

/** Parse legacy "DD Month YYYY, HH:MM AM/PM [LABEL]" where LABEL maps to a fixed UTC offset. */
function parseLegacyLabeledExportDateTime(raw) {
  const s = String(raw || "").trim();
  const m = s.match(
    /^(\d{1,2})\s+(\w+)\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s+(\S+)$/i,
  );
  if (!m) return null;
  const mo = LONG_MONTHS[m[2].toLowerCase()];
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

/**
 * Parse export datetime strings — TradingView style (current) or legacy labeled format.
 * New format has no timezone suffix; `timeZone` defaults to UTC for re-import.
 */
function parseLabeledExportDateTime(raw, timeZone = "UTC") {
  return parseTradingViewExportDateTime(raw, timeZone)
    || parseLegacyLabeledExportDateTime(raw);
}

module.exports = {
  formatExportDateTime,
  resolveTimezoneLabel,
  getUtcOffsetMinutesForLabel,
  parseLabeledExportDateTime,
  parseTradingViewExportDateTime,
  localDateTimeInZoneToUtc,
  TZ_SHORT_LABELS,
  LABEL_UTC_OFFSET_MINUTES,
};
