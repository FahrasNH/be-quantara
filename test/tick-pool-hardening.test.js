/**
 * Live tick / DB pool hardening regressions (Sprint 12 BUG-CRITICAL).
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

console.log("\n═══ Tick / Pool Hardening ═══");

const engine = fs.readFileSync(
  path.join(__dirname, "../src/modules/trading/application/BotEngine.js"),
  "utf8"
);
const db = fs.readFileSync(
  path.join(__dirname, "../src/infrastructure/db/database.js"),
  "utf8"
);
const prisma = fs.readFileSync(
  path.join(__dirname, "../src/infrastructure/db/prismaClient.js"),
  "utf8"
);
const backup = fs.readFileSync(
  path.join(__dirname, "../src/infrastructure/backup/BackupScheduler.js"),
  "utf8"
);

test("tick scheduler uses chained setTimeout (not overlapping setInterval)", () => {
  assert.ok(engine.includes("scheduleNext"), "scheduleNext missing");
  assert.ok(
    !/this\._interval\s*=\s*setInterval\(\s*\(\)\s*=>\s*\{[\s\S]*Tick sebelumnya belum selesai/.test(engine),
    "old overlapping setInterval guard still present"
  );
});

test("reconcile has retry + throttle", () => {
  assert.ok(engine.includes("RECONCILE_MIN_MS"), "reconcile throttle missing");
  assert.ok(engine.includes("MAX_ATTEMPTS"), "reconcile retry missing");
  assert.ok(/timeout exceeded when trying to connect/i.test(engine), "pool-timeout detect missing");
});

test("pg pool default ≥ 30", () => {
  const m = db.match(/PG_POOL_MAX[^\n]*\|\|\s*(\d+)/);
  assert.ok(m, "PG_POOL_MAX default not found");
  assert.ok(Number(m[1]) >= 30, `PG_POOL_MAX default ${m[1]} too low`);
});

test("cacheCandles uses UNNEST batch (no long-held connect loop)", () => {
  assert.ok(db.includes("UNNEST"), "UNNEST batch missing");
  assert.ok(!/const client = await pool\.connect\(\);\s*try \{\s*for \(let i = 0/.test(db),
    "old per-row pool.connect loop still present");
});

test("BackupScheduler reuses shared pool", () => {
  assert.ok(backup.includes('_pool: pool') || backup.includes("_pool: pool"),
    "BackupScheduler should import shared _pool");
  assert.ok(!/new Pool\(\s*\{\s*connectionString/.test(backup),
    "BackupScheduler must not create its own Pool");
});

test("Prisma connection limit default ≤ 20", () => {
  const m = prisma.match(/PRISMA_CONNECTION_LIMIT[^\n]*\|\|\s*(\d+)/);
  assert.ok(m, "PRISMA_CONNECTION_LIMIT default not found");
  assert.ok(Number(m[1]) <= 20, `PRISMA default ${m[1]} unexpected`);
});

console.log("\n══════════════════════════════════════");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("All tick/pool hardening tests passed.\n");
