#!/usr/bin/env node
/**
 * Read-only DB audit: inventory legacy/Gen1 strategyKey values across Prisma + runtime tables.
 * Run: node scripts/audit-gen1-strategy-keys.js
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { GEN1_STRATEGY_KEYS, STRATEGY_MIGRATION_MAP } = require("../src/config/strategyKeyNormalizer");
const { GEN1_STRATEGY_KEY_TARGETS } = require("./gen1-strategy-key-tables");

const prisma = new PrismaClient();

const GEN1_LIST = [...GEN1_STRATEGY_KEYS];

async function groupByPrismaField(model, field) {
  try {
    const rows = await prisma[model].groupBy({
      by: [field],
      _count: { _all: true },
    });
    return rows
      .map((r) => ({ strategyKey: r[field], count: r._count._all }))
      .sort((a, b) => b.count - a.count);
  } catch (e) {
    if (e.code === "P2021" || /does not exist/i.test(String(e.message))) {
      return null;
    }
    throw e;
  }
}

async function groupByRawSql(sql) {
  try {
    const rows = await prisma.$queryRawUnsafe(sql);
    return rows
      .map((r) => ({ strategyKey: r.key, count: Number(r.count) }))
      .sort((a, b) => b.count - a.count);
  } catch (e) {
    if (/does not exist|relation .* does not exist/i.test(String(e.message))) {
      return null;
    }
    throw e;
  }
}

function filterGen1(rows) {
  return rows.filter((r) => {
    const k = String(r.strategyKey || "").toUpperCase();
    return GEN1_LIST.includes(k);
  });
}

async function main() {
  console.log("\n═══ Gen1 strategyKey DB audit ═══\n");
  console.log("Gen1 keys checked:", GEN1_LIST.join(", "));
  console.log("Migration map:", JSON.stringify(STRATEGY_MIGRATION_MAP, null, 2));
  console.log("");

  let totalGen1 = 0;

  for (const target of GEN1_STRATEGY_KEY_TARGETS) {
    const label = target.label || `${target.model}.${target.field}`;
    let all;

    if (target.kind === "prisma") {
      all = await groupByPrismaField(target.model, target.field);
      if (all === null) {
        console.log(`── ${label} ──`);
        console.log("  (table/model not present — skipped)\n");
        continue;
      }
    } else {
      all = await groupByRawSql(target.groupBySql);
      if (all === null) {
        console.log(`── ${label} ──`);
        console.log("  (table not present — skipped)\n");
        continue;
      }
    }

    const gen1 = filterGen1(all);
    console.log(`── ${label} (${all.length} distinct keys) ──`);
    if (gen1.length === 0) {
      console.log("  ✓ No Gen1 strategyKey rows\n");
    } else {
      for (const row of gen1) {
        console.log(`  ${row.strategyKey}: ${row.count}`);
        totalGen1 += row.count;
      }
      console.log("");
    }
  }

  console.log(`Total Gen1 rows across audited tables: ${totalGen1}`);
  if (totalGen1 > 0) {
    console.log("→ Run: npx prisma migrate deploy && node scripts/migrate-gen1-strategy-keys.js");
    process.exitCode = 1;
  } else {
    console.log("✓ DB clean — zero Gen1 strategyKey rows.");
  }
}

main()
  .catch((e) => {
    console.error("Audit failed:", e.message);
    if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL not set — audit skipped (migration file still available).");
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
