/**
 * tradingCosts unit tests — model biaya fee+slippage untuk backtest realistis.
 */
const { tradingCostPerUnit, applyTradingCosts } = require("../scripts/lib/simulator");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log("\n💰 tradingCosts Unit Tests\n");

// fee 0.0006/sisi + slippage 0.0005/fill, entry 100, exit 110
// cost = (0.0006+0.0005) * (100+110) = 0.0011 * 210 = 0.231
{
  const c = tradingCostPerUnit(100, 110, { feeRate: 0.0006, slippageRate: 0.0005 });
  t("cost per unit = 0.231", near(c, 0.231));
}

t("cost selalu ≥ 0 (default 0)", tradingCostPerUnit(100, 110) === 0);
t("cost naik dengan harga", tradingCostPerUnit(200, 200, { feeRate: 0.001 }) > tradingCostPerUnit(100, 100, { feeRate: 0.001 }));

// applyTradingCosts: pnl net = gross − cost
{
  const trade = { entry: 100, exit: 110, pnl: 10, reason: "TP" };
  const out = applyTradingCosts(trade, { feeRate: 0.0006, slippageRate: 0.0005 });
  t("grossPnl dipertahankan", out.grossPnl === 10);
  t("cost terisi (0.231)", near(out.cost, 0.231));
  t("pnl net = 10 - 0.231 = 9.769", near(out.pnl, 9.769));
  t("field lain (reason) dipertahankan", out.reason === "TP");
}

// Loss tetap diperburuk oleh biaya
{
  const out = applyTradingCosts({ entry: 100, exit: 95, pnl: -5 }, { feeRate: 0.0006, slippageRate: 0.0005 });
  t("loss diperburuk biaya (lebih negatif dari -5)", out.pnl < -5);
}

console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
process.exit(fail === 0 ? 0 : 1);
