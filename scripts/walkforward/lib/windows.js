"use strict";

/**
 * Walk-forward window sets — gap 2021-12 → 2022-10 (bear crash) excluded in all sets.
 */

/** 5-window set (2020–2024) — promotion gate for multi-coin grids. */
const GAP_POLICY_5 = [
  { id: 1, start: "2020-01-04", end: "2020-04-04" },
  { id: 2, start: "2020-04-03", end: "2021-02-08" },
  { id: 3, start: "2021-02-06", end: "2021-12-14" },
  { id: 4, start: "2022-10-13", end: "2023-08-18" },
  { id: 5, start: "2023-08-18", end: "2024-05-22" },
];

/** 8-window set (2020–2026) — SMC Scalping ML export. */
const GAP_POLICY_8 = [
  { id: 1, start: "2020-01-04", end: "2020-04-04" },
  { id: 2, start: "2020-04-03", end: "2021-02-08" },
  { id: 3, start: "2021-02-06", end: "2021-12-14" },
  { id: 4, start: "2022-10-13", end: "2023-08-18" },
  { id: 5, start: "2023-08-18", end: "2024-05-22" },
  { id: 6, start: "2024-05-20", end: "2025-03-26" },
  { id: 7, start: "2025-03-26", end: "2026-01-28" },
  { id: 8, start: "2026-01-28", end: "2026-07-06" },
];

/** Window 8 uses xlsx Full ML export via UI/API. */
const GAP_POLICY_8_WITH_FORMAT = GAP_POLICY_8.map((w) => ({
  ...w,
  format: w.id === 8 ? "xlsx" : "csv",
}));

/**
 * Sprint 23 VSA Intraday GO/NO-GO — same 3 windows as 819-trade root-cause
 * (2023 / 2024-25 / 2025-26). Dates from GAP_POLICY_8 W4/W6/W7, renumbered 1–3.
 */
const VSA_INTRADAY_3 = [
  { id: 1, start: "2022-10-13", end: "2023-08-18", label: "2023" },
  { id: 2, start: "2024-05-20", end: "2025-03-26", label: "2024-25" },
  { id: 3, start: "2025-03-26", end: "2026-01-28", label: "2025-26" },
];

function filterWindows(windows, windowFilter) {
  if (windowFilter == null) return windows;
  return windows.filter((w) => w.id === windowFilter);
}

module.exports = {
  GAP_POLICY_5,
  GAP_POLICY_8,
  GAP_POLICY_8_WITH_FORMAT,
  VSA_INTRADAY_3,
  filterWindows,
};
