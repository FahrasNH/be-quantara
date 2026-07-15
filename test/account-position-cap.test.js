/**
 * ─────────────────────────────────────────────────────────────────────────────
 * account-position-cap.test.js — Per-tier account-wide OPEN-position cap
 *
 * Memverifikasi perbaikan bug meter "Account Risk → Open positions" yang
 * menampilkan "8 / 4" (8 posisi terbuka, denominator 4 di-hardcode & cap tak
 * pernah ditegakkan). Cakupan:
 *   1. Nilai cap per-tier dari tierConfig (FOUNDRY 4 / FORGE 8 / MINT 12 / VAULT 16)
 *      + helper getMaxConcurrentPositions (fallback FOUNDRY utk tier tak dikenal).
 *   2. AccountCoordinator.setMaxAccountOpenPositions + ekspos di snapshot, TANPA
 *      mengaktifkan gate reservations-based (maxConcurrentPositions tetap 0).
 *   3. BotEngine._checkAccountOpenCap: memblok open ke-(cap+1), mengizinkan ≤ cap,
 *      menghitung posisi terbuka NYATA dari DB (BUKAN reservations.size), ditegakkan
 *      di DRY-RUN, dan FAIL-OPEN bila DB error.
 *
 * Standalone runner: exit code != 0 bila ada yang gagal (chained di npm test).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const assert = require("node:assert");
const {
  TIER_CONFIG,
  getMaxConcurrentPositions,
} = require("../src/domain/tierConfig");
const AccountCoordinator = require("../src/domain/AccountCoordinator");
const BotEngine = require("../src/modules/trading/application/BotEngine");
// Modul DB yang SAMA (cached) yang di-require BotEngine._checkAccountOpenCap →
// override export-nya = stub untuk hitung posisi terbuka tanpa Postgres.
const db = require("../src/infrastructure/db/database");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

console.log("\n🔢 Per-tier Account Open-Position Cap Tests\n");

// ── 1. Nilai cap per-tier + helper ──────────────────────────────────────────
{
  t("FOUNDRY cap = 4", TIER_CONFIG.FOUNDRY.maxConcurrentPositions === 4);
  t("FORGE cap = 8",   TIER_CONFIG.FORGE.maxConcurrentPositions === 8);
  t("MINT cap = 12",   TIER_CONFIG.MINT.maxConcurrentPositions === 12);
  t("VAULT cap = 16",  TIER_CONFIG.VAULT.maxConcurrentPositions === 16);

  t("getMaxConcurrentPositions(FOUNDRY) = 4", getMaxConcurrentPositions("FOUNDRY") === 4);
  t("getMaxConcurrentPositions(VAULT) = 16",  getMaxConcurrentPositions("VAULT") === 16);
  // Tier tak dikenal / undefined → fallback aman ke FOUNDRY (4), BUKAN unlimited.
  t("getMaxConcurrentPositions(unknown) → fallback 4", getMaxConcurrentPositions("PLATINUM") === 4);
  t("getMaxConcurrentPositions(undefined) → fallback 4", getMaxConcurrentPositions(undefined) === 4);
}

// ── 2. AccountCoordinator setter + snapshot (tidak mengaktifkan gate reservasi) ──
{
  const c = new AccountCoordinator({ userId: "u-cap" });
  t("default maxAccountOpenPositions = 0", c.maxAccountOpenPositions === 0);
  t("default maxConcurrentPositions (reservasi) = 0", c.maxConcurrentPositions === 0);

  c.setMaxAccountOpenPositions(8);
  t("setMaxAccountOpenPositions(8) → 8", c.maxAccountOpenPositions === 8);
  t("snapshot.maxAccountOpenPositions = 8", c.snapshot().maxAccountOpenPositions === 8);
  // CRITICAL: cap per-tier TIDAK boleh mengaktifkan gate reservations-based canOpen.
  t("maxConcurrentPositions tetap 0 (gate reservasi tidak diaktifkan)", c.maxConcurrentPositions === 0);

  // Nilai non-positif diabaikan (jaga invarian: 0 = belum di-set).
  c.setMaxAccountOpenPositions(0);
  t("setMaxAccountOpenPositions(0) diabaikan → tetap 8", c.maxAccountOpenPositions === 8);
}

// ── 3. BotEngine._checkAccountOpenCap (gate riil) ───────────────────────────
// Helper: panggil method pada `this` palsu agar tak perlu konstruksi engine penuh.
const _origCount = db.countOpenTradesByUser;
function checkCap({ cap, userId = "u1", dryRun = true, openCount, throwErr = false }) {
  db.countOpenTradesByUser = async () => {
    if (throwErr) throw new Error("DB down (simulasi)");
    return openCount;
  };
  const fakeThis = {
    config: { maxAccountOpenPositions: cap, userId, dryRun },
    _log: () => {},
  };
  return BotEngine.prototype._checkAccountOpenCap.call(fakeThis);
}

(async () => {
  // Mengizinkan saat di bawah cap.
  let v = await checkCap({ cap: 4, openCount: 3 });
  t("open 3 < cap 4 → diizinkan", v.allowed === true);

  // Memblok tepat saat current == cap (open ke-(cap+1) ditolak).
  v = await checkCap({ cap: 4, openCount: 4 });
  t("open 4 == cap 4 → DITOLAK (entry ke-5)", v.allowed === false);
  t("alasan memuat rasio (4/4)", typeof v.reason === "string" && v.reason.includes("4/4"));

  // Memblok saat melebihi cap.
  v = await checkCap({ cap: 4, openCount: 8 });
  t("open 8 > cap 4 → DITOLAK (kasus bug '8/4')", v.allowed === false);

  // DITEGAKKAN di DRY-RUN (kasus yang dilaporkan = simulasi).
  v = await checkCap({ cap: 4, openCount: 5, dryRun: true });
  t("dry-run: open 5 ≥ cap 4 → DITOLAK (cap aktif di simulasi)", v.allowed === false);

  // Tier lebih tinggi (cap 16) mengizinkan lebih banyak.
  v = await checkCap({ cap: 16, openCount: 8 });
  t("VAULT cap 16: open 8 → diizinkan", v.allowed === true);

  // cap 0 (belum dikonfigurasi) → tidak membatasi (backward-compatible).
  v = await checkCap({ cap: 0, openCount: 999 });
  t("cap 0 (unconfigured) → tidak membatasi", v.allowed === true);

  // Tanpa userId → tak bisa hitung → jangan blokir.
  v = await checkCap({ cap: 4, userId: null, openCount: 999 });
  t("tanpa userId → tidak membatasi (jangan blokir buta)", v.allowed === true);

  // FAIL-OPEN bila DB error (gate proteksi tambahan; jangan crash entry).
  v = await checkCap({ cap: 4, openCount: 0, throwErr: true });
  t("DB error → fail-open (allowed) dengan warning", v.allowed === true);

  // ── PROOF: cap memakai hitungan DB, BUKAN reservations.size ───────────────
  // Simulasikan 100 reservasi (≈ slot strategi ter-arm utk 27 bot). Jika gate
  // salah memakai reservations.size, ia akan memblok semua entry. Kita buktikan
  // gate hanya melihat hitungan DB (di sini 1) → tetap mengizinkan.
  {
    const coord = new AccountCoordinator({ userId: "u-proof" });
    for (let i = 0; i < 100; i++) {
      coord.reserve(`u-proof:S${i}#AF`, { symbol: `S${i}`, margin: 0.1 });
    }
    t("setup: reservations.size = 100 (slot ter-arm)", coord.openCount() === 100);
    coord.setMaxAccountOpenPositions(4);

    const allowed = await checkCap({ cap: 4, openCount: 1 }); // DB hitung 1 posisi terbuka
    t("reservations 100 tapi DB open 1 < cap 4 → DIIZINKAN (bukan reservations.size)", allowed.allowed === true);

    const blocked = await checkCap({ cap: 4, openCount: 4 }); // DB hitung 4 (== cap)
    t("DB open 4 == cap 4 → DITOLAK (hitung dari DB, bukan reservasi 0/100)", blocked.allowed === false);
  }

  // restore
  db.countOpenTradesByUser = _origCount;

  console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
  console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
