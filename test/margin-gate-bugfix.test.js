/**
 * margin-gate-bugfix.test.js — regression untuk insiden "utilisasi 536%".
 *
 * Akar masalah: gate START memakai footprint capital/leverage (mengecilkan 5×) +
 * di-skip saat equity belum terbaca + tidak ter-serialisasi saat "Start All".
 * Akibatnya user bisa meng-arm 9 bot @ $50 di akun $105 (committed $450, free
 * margin -$366). Tes ini mengunci ketiga perbaikan:
 *   1. AccountCoordinator.canStartBot()  — footprint MODAL PENUH (BUG-FIX-01)
 *   2. fail-closed saat equity unknown   — (BUG-FIX-02)
 *   3. balanceCache TTL + backoff 50011  — (OPS-FIX-01) yang menjamin (2)
 */
const AC = require("#modules/trading/domain/AccountCoordinator.js");
const { getCachedBalance, invalidate } = require("../src/services/balanceCache");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

console.log("\n🛡️  Margin Gate Bug-Fix (insiden utilisasi 536%)\n");

// ── BUG-FIX-01: gate START menilai MODAL PENUH, bukan capital/leverage ────────
{
  console.log("BUG-FIX-01 — footprint modal penuh:");
  const c = new AC({ userId: "u", maxAccountUtilization: 0.8 });
  c.setAccountEquity(105); // budget = 84

  let v = c.canStartBot({ capital: 50 });
  t("Bot-1 $50 @ equity $105 → boleh ($50 ≤ $84)", v.ok);

  // Gate lama: 50/5=10 ≤ 84 → LOLOS (bug). Gate baru me-reserve penuh $50.
  c.reserveGroup("u", "BTCUSDT", ["A", "B", "C"], 50); // committed = 50
  v = c.canStartBot({ capital: 50, exceptSymbol: "ETHUSDT" });
  t("Bot-2 $50 → DITOLAK (50+50=100 > 84) — over-allocation dicegah", !v.ok);
  t("  reason menyebut sisa anggaran", /anggaran/i.test(v.reason || ""));

  // Skenario insiden: 9 bot @ $50, hanya 1 yang muat di akun $105.
  const c2 = new AC({ userId: "u2", maxAccountUtilization: 0.8 });
  c2.setAccountEquity(105);
  let started = 0;
  for (let i = 0; i < 9; i++) {
    const sym = `C${i}USDT`;
    const verdict = c2.canStartBot({ capital: 50, exceptSymbol: sym });
    if (verdict.ok) { c2.reserveGroup("u2", sym, ["A", "B", "C"], 50); started++; }
  }
  t(`9 bot @ $50 di akun $105 → hanya ${started} ter-start (harus 1)`, started === 1);
  t("committed ≤ budget (tak ada utilisasi >100%)", c2.committedMargin() <= 84 + 1e-9);
}

// ── BUG-FIX-02: fail-closed saat equity belum diketahui ───────────────────────
{
  console.log("BUG-FIX-02 — fail-closed equity unknown:");
  const c = new AC({ userId: "u3", maxAccountUtilization: 0.8 });
  // accountEquity belum di-set (0) → gate WAJIB tolak, bukan loloskan.
  const v = c.canStartBot({ capital: 50 });
  t("equity unknown (0) → DITOLAK (EQUITY_UNKNOWN)", !v.ok && v.reason === "EQUITY_UNKNOWN");
}

// ── exceptSymbol: restart bot yang sama tidak dihitung dobel ───────────────────
{
  console.log("exceptSymbol — restart idempotent:");
  const c = new AC({ userId: "u4", maxAccountUtilization: 0.8 });
  c.setAccountEquity(105);
  c.reserveGroup("u4", "BTCUSDT", ["A"], 80); // committed 80, sisa 4
  // Restart BTCUSDT modal 80: reservasi lamanya dikecualikan → tetap muat.
  const v = c.canStartBot({ capital: 80, exceptSymbol: "BTCUSDT" });
  t("restart simbol sama (exceptSymbol) → tidak dihitung dobel → boleh", v.ok);
  // Bot simbol BARU modal 80 tetap ditolak (committed 80 + 80 > 84).
  const v2 = c.canStartBot({ capital: 80, exceptSymbol: "ETHUSDT" });
  t("simbol baru $80 → DITOLAK (80+80 > 84)", !v2.ok);
}

// ── OPS-FIX-01: balanceCache TTL + backoff ────────────────────────────────────
(async () => {
  console.log("OPS-FIX-01 — balanceCache:");

  // (a) Caching: 2 panggilan dalam TTL → getBalance underlying hanya 1×.
  invalidate();
  let calls = 0;
  const okClient = { getBalance: async () => { calls++; return { equity: 105, available: 100 }; } };
  const b1 = await getCachedBalance("uA", "okx", {}, { client: okClient, ttlMs: 60000 });
  const b2 = await getCachedBalance("uA", "okx", {}, { client: okClient, ttlMs: 60000 });
  t("balance terbaca ($105 equity)", b1.equity === 105 && b2.equity === 105);
  t("2 panggilan dalam TTL → getBalance underlying 1× (redam burst)", calls === 1);

  // (b) Backoff: kena 50011 dua kali lalu sukses → retry, akhirnya sukses.
  invalidate();
  let attempts = 0;
  const flakyClient = {
    getBalance: async () => {
      attempts++;
      if (attempts < 3) { const e = new Error("okx Too many requests"); e.code = 50011; throw e; }
      return { equity: 50, available: 50 };
    },
  };
  const b3 = await getCachedBalance("uB", "okx", {}, { client: flakyClient, baseDelayMs: 1, maxRetries: 4 });
  t("50011 ×2 lalu sukses → retry-backoff berhasil", b3.equity === 50 && attempts === 3);

  // (c) Fail-closed: 50011 terus → getCachedBalance MELEMPAR (caller fail-closes).
  invalidate();
  const deadClient = { getBalance: async () => { const e = new Error("Too many requests"); e.code = 50011; throw e; } };
  let threw = false;
  try {
    await getCachedBalance("uC", "okx", {}, { client: deadClient, baseDelayMs: 1, maxRetries: 2 });
  } catch { threw = true; }
  t("50011 persisten → MELEMPAR (gate fail-closed, bukan equity=0 diam-diam)", threw);

  // ── Ringkasan ──
  console.log(`\n${fail === 0 ? "✅" : "❌"} margin-gate-bugfix: ${pass} pass, ${fail} fail\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
