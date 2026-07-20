"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  initPositionExcursions,
  updatePositionExcursions,
  computeExcursionFields,
} = require("../src/shared/backtest/tradeExcursion");

test("updatePositionExcursions tracks LONG MFE/MAE from intra-bar extremes", () => {
  const pos = { side: "LONG", entry: 100, ...initPositionExcursions() };
  updatePositionExcursions(pos, { high: 103, low: 99 });
  updatePositionExcursions(pos, { high: 105, low: 98.5 });
  const out = computeExcursionFields(pos, 102);
  assert.equal(out.mfe, 5);
  assert.equal(out.mae, 1.5);
  assert.equal(out.mfePercent, 5);
  assert.equal(out.exitEfficiency, 0.4);
});

test("updatePositionExcursions tracks SHORT MFE/MAE", () => {
  const pos = { side: "SHORT", entry: 200, ...initPositionExcursions() };
  updatePositionExcursions(pos, { high: 201, low: 196 });
  const out = computeExcursionFields(pos, 198);
  assert.equal(out.mfe, 4);
  assert.equal(out.mae, 1);
});

test("computeExcursionFields handles zero MFE gracefully", () => {
  const pos = { side: "LONG", entry: 50, mfePrice: 0, maePrice: 0.2 };
  const out = computeExcursionFields(pos, 49.5);
  assert.equal(out.exitEfficiency, null);
});
