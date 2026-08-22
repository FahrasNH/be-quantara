/**
 * Regression: dry-run close MUST release the AccountCoordinator reservation.
 *
 * Bug: the LIVE close path called _releaseMarginIfFlat() in three places
 * (exchange reconcile / manual close / time stop) but the DRY-RUN close path
 * only filtered openPositions and synced stats. The reservation — which carries
 * `direction` — stayed in the in-memory Map forever, so hasGroupOpenPosition()
 * kept returning true and every engine in the group was rejected with
 * "Sudah ada posisi terbuka <SYMBOL> — race-to-confirm: max 1 per simbol"
 * while no position was actually open. Restarting the bot cleared the Map,
 * which is why stop/start appeared to "fix" it.
 *
 * Standalone runner: exit code != 0 bila ada yang gagal.
 */
const AC = require("#modules/trading/domain/AccountCoordinator.js");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

console.log("\n🧪 Dry-run margin release (regression)\n");

// ── Reproduksi skenario grup multi-strategi pada satu koin ──────────────────
{
  const c = new AC({ userId: "u1", maxAccountUtilization: 0.8 });
  c.setAccountEquity(1000);

  const groupKey = c.groupKeyFor("u1", "BNBUSDT");
  const engineAF = `${groupKey}#SMART_MONEY_CONCEPTS`;
  const engineTS = `${groupKey}#TREND_FOLLOWING`;

  // Engine AF membuka posisi (reservasi ber-direction = posisi nyata).
  c.reserve(engineAF, {
    symbol: "BNBUSDT", margin: 50, groupKey,
    strategyKey: "SMART_MONEY_CONCEPTS", direction: "LONG",
  });

  const blockedWhileOpen = c.canOpen({
    botKey: engineTS, symbol: "BNBUSDT", requiredMargin: 50, groupKey, direction: "LONG",
  });
  t("saat posisi AF terbuka → engine TS diblok (perilaku benar)", !blockedWhileOpen.ok);

  // Posisi AF ditutup di DRY-RUN. Sebelum fix: tidak ada release sama sekali.
  c.release(engineAF);

  const afterClose = c.canOpen({
    botKey: engineTS, symbol: "BNBUSDT", requiredMargin: 50, groupKey, direction: "LONG",
  });
  t("setelah posisi AF tutup → engine TS BOLEH entry lagi", afterClose.ok);

  const afSelfAgain = c.canOpen({
    botKey: engineAF, symbol: "BNBUSDT", requiredMargin: 50, groupKey, direction: "SHORT",
  });
  t("engine AF sendiri juga boleh entry lagi (arah berbeda)", afSelfAgain.ok);

  t("tidak ada reservasi tersisa untuk grup", !c.hasGroupOpenPosition(groupKey, "BNBUSDT", null));
}

// ── _releaseMarginIfFlat idempotent + hanya saat FLAT ───────────────────────
{
  const c = new AC({ userId: "u2", maxAccountUtilization: 0.8 });
  c.setAccountEquity(1000);
  const groupKey = c.groupKeyFor("u2", "SOLUSDT");
  const engine = `${groupKey}#MEAN_REVERSION`;

  c.reserve(engine, {
    symbol: "SOLUSDT", margin: 30, groupKey,
    strategyKey: "MEAN_REVERSION", direction: "SHORT",
  });

  // Dipanggil dua kali (idempotent) — meniru beberapa jalur close pada satu tick.
  c.release(engine);
  c.release(engine);

  t("release dua kali tidak melempar error / tetap bersih",
    !c.hasGroupOpenPosition(groupKey, "SOLUSDT", null));
  t("committedMargin kembali 0 setelah flat", c.committedMargin() === 0);
}

// ── Posisi lain masih terbuka → JANGAN lepas (guard openPositions.length) ───
{
  const c = new AC({ userId: "u3", maxAccountUtilization: 0.8 });
  c.setAccountEquity(1000);
  const gBnb = c.groupKeyFor("u3", "BNBUSDT");
  const gSol = c.groupKeyFor("u3", "SOLUSDT");

  c.reserve(`${gBnb}#SMART_MONEY_CONCEPTS`, {
    symbol: "BNBUSDT", margin: 40, groupKey: gBnb,
    strategyKey: "SMART_MONEY_CONCEPTS", direction: "LONG",
  });
  c.reserve(`${gSol}#TREND_FOLLOWING`, {
    symbol: "SOLUSDT", margin: 40, groupKey: gSol,
    strategyKey: "TREND_FOLLOWING", direction: "LONG",
  });

  // BNB tutup, SOL masih jalan.
  c.release(`${gBnb}#SMART_MONEY_CONCEPTS`);

  t("BNB bebas setelah tutup", !c.hasGroupOpenPosition(gBnb, "BNBUSDT", null));
  t("SOL TETAP terkunci (posisi lain masih terbuka)", c.hasGroupOpenPosition(gSol, "SOLUSDT", null));
  t("committedMargin sisa 40 (hanya SOL)", c.committedMargin() === 40);
}

console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
process.exit(fail === 0 ? 0 : 1);
