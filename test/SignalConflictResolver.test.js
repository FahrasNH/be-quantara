/**
 * SignalConflictResolver unit tests (Multi-Strategy per Coin — TASK 1.3).
 * Standalone runner: exit code != 0 bila ada yang gagal.
 *
 * Mengacu ke acceptance criteria AC-05 dan test case TC-001.
 */
const { resolveConflicts, normalizeDirection } = require("#core/signal-engine/SignalConflictResolver.js");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

const sig = (strategyKey, direction) => ({ strategyKey, direction });

console.log("\n🧭 SignalConflictResolver Unit Tests\n");

// ── normalizeDirection ──────────────────────────────────────────────────────
{
  t("normalize 'long' → LONG", normalizeDirection({ direction: "long" }) === "LONG");
  t("normalize 'SHORT' → SHORT", normalizeDirection({ direction: "SHORT" }) === "SHORT");
  t("normalize null → null", normalizeDirection({ direction: null }) === null);
  t("normalize 'BUY' (invalid) → null", normalizeDirection({ direction: "BUY" }) === null);
  t("normalize undefined sig → null", normalizeDirection(undefined) === null);
}

// ── Rule 1: semua LONG → eksekusi semua ─────────────────────────────────────
{
  const r = resolveConflicts([sig("AF", "LONG"), sig("TM", "LONG"), sig("MR", "LONG")]);
  t("all LONG → execute 3", r.execute.length === 3);
  t("all LONG → no conflict", r.conflict === false);
  t("all LONG → direction LONG", r.direction === "LONG");
}

// ── Rule 2: semua SHORT → eksekusi semua ────────────────────────────────────
{
  const r = resolveConflicts([sig("AF", "SHORT"), sig("TM", "SHORT")]);
  t("all SHORT → execute 2", r.execute.length === 2);
  t("all SHORT → direction SHORT", r.direction === "SHORT");
}

// ── Rule 3 / TC-001 / AC-05: mix LONG+SHORT → SKIP semua (default) ───────────
{
  const r = resolveConflicts([sig("AF", "LONG"), sig("TM", "SHORT")]);
  t("TC-001: mix LONG+SHORT → execute 0 (no entry)", r.execute.length === 0);
  t("TC-001: mix → conflict true", r.conflict === true);
  t("TC-001: mix → direction null", r.direction === null);
  t("TC-001: both signals skipped", r.skipped.length === 2);
}

// ── Rule 4: satu fire, lainnya diam → eksekusi yang fire ─────────────────────
{
  const r = resolveConflicts([sig("AF", null), sig("TM", "LONG"), sig("MR", null)]);
  t("one fires (TM LONG) → execute 1", r.execute.length === 1 && r.execute[0].strategyKey === "TM");
  t("one fires → no conflict", r.conflict === false);
  t("one fires → 2 idle skipped", r.skipped.length === 2);
}

// ── Semua diam → tidak ada entry, bukan konflik ─────────────────────────────
{
  const r = resolveConflicts([sig("AF", null), sig("TM", null)]);
  t("all idle → execute 0", r.execute.length === 0);
  t("all idle → conflict false", r.conflict === false);
}

// ── Edge: input kosong / non-array ──────────────────────────────────────────
{
  t("empty array → execute 0, no crash", resolveConflicts([]).execute.length === 0);
  t("non-array → execute 0, no crash", resolveConflicts(null).execute.length === 0);
}

// ── conflictMode 'majority' (tunable) ───────────────────────────────────────
{
  const r = resolveConflicts(
    [sig("AF", "LONG"), sig("TM", "LONG"), sig("MR", "SHORT")],
    { conflictMode: "majority" }
  );
  t("majority: 2 LONG vs 1 SHORT → execute 2 LONG", r.execute.length === 2 && r.direction === "LONG");
  t("majority: minority SHORT skipped", r.skipped.some((s) => s.strategyKey === "MR"));
  t("majority: still flagged conflict", r.conflict === true);

  const tie = resolveConflicts(
    [sig("AF", "LONG"), sig("TM", "SHORT")],
    { conflictMode: "majority" }
  );
  t("majority tie → skip all (execute 0)", tie.execute.length === 0 && tie.direction === null);
}

// ── Signals passthrough: field lain ikut diteruskan ─────────────────────────
{
  const enriched = { strategyKey: "AF", direction: "LONG", slPrice: 100, tpPrice: 110 };
  const r = resolveConflicts([enriched]);
  t("execute preserves slPrice/tpPrice", r.execute[0].slPrice === 100 && r.execute[0].tpPrice === 110);
}

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
