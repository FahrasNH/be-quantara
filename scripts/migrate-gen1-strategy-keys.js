#!/usr/bin/env node
/**
 * Data migration: legacy strategy keys → Gen2 canonical per STRATEGY_MIGRATION_MAP.
 * Idempotent — safe to re-run. Asserts zero Gen1 rows after migration.
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const {
  STRATEGY_MIGRATION_MAP,
  GEN1_STRATEGY_KEYS,
} = require("../src/config/strategyKeyNormalizer");
const { GEN1_STRATEGY_KEY_TARGETS, sqlQuoteList } = require("./gen1-strategy-key-tables");

const prisma = new PrismaClient();

async function migratePrismaTable(model, field) {
  let updated = 0;
  for (const [gen1, gen2] of Object.entries(STRATEGY_MIGRATION_MAP)) {
    try {
      const result = await prisma[model].updateMany({
        where: { [field]: gen1 },
        data: { [field]: gen2 },
      });
      updated += result.count;
      if (result.count > 0) {
        console.log(`  ${model}.${field}: ${gen1} → ${gen2} (${result.count} rows)`);
      }
    } catch (e) {
      if (e.code === "P2021" || /does not exist/i.test(String(e.message))) {
        return 0;
      }
      throw e;
    }
  }
  return updated;
}

async function migrateRawTarget(target) {
  let updated = 0;
  for (const [gen1, gen2] of Object.entries(STRATEGY_MIGRATION_MAP)) {
    try {
      const sql = target.updateSql(gen1, gen2);
      const count = await prisma.$executeRawUnsafe(sql);
      const n = Number(count) || 0;
      updated += n;
      if (n > 0) {
        console.log(`  ${target.label}: ${gen1} → ${gen2} (${n} rows)`);
      }
    } catch (e) {
      if (/does not exist|relation .* does not exist/i.test(String(e.message))) {
        return 0;
      }
      throw e;
    }
  }
  return updated;
}

async function assertZeroGen1Prisma(model, field) {
  const gen1List = [...GEN1_STRATEGY_KEYS];
  try {
    const count = await prisma[model].count({
      where: { [field]: { in: gen1List } },
    });
    if (count > 0) {
      throw new Error(`${model}.${field} still has ${count} Gen1 rows`);
    }
  } catch (e) {
    if (e.code === "P2021" || /does not exist/i.test(String(e.message))) {
      return;
    }
    throw e;
  }
}

async function assertZeroGen1Raw(target) {
  const gen1List = sqlQuoteList([...GEN1_STRATEGY_KEYS]);
  try {
    const rows = await prisma.$queryRawUnsafe(target.countSql(gen1List));
    const count = Number(rows[0]?.count ?? 0);
    if (count > 0) {
      throw new Error(`${target.label} still has ${count} Gen1 rows`);
    }
  } catch (e) {
    if (/does not exist|relation .* does not exist/i.test(String(e.message))) {
      return;
    }
    throw e;
  }
}

async function main() {
  console.log("\n═══ Gen1 → Gen2 strategyKey migration ═══\n");
  let total = 0;

  for (const target of GEN1_STRATEGY_KEY_TARGETS) {
    const label = target.label || `${target.model}.${target.field}`;
    console.log(`Migrating ${label}…`);
    if (target.kind === "prisma") {
      total += await migratePrismaTable(target.model, target.field);
    } else {
      total += await migrateRawTarget(target);
    }
  }

  console.log(`\nTotal rows updated: ${total}\nPost-migration assert:`);
  for (const target of GEN1_STRATEGY_KEY_TARGETS) {
    const label = target.label || `${target.model}.${target.field}`;
    if (target.kind === "prisma") {
      await assertZeroGen1Prisma(target.model, target.field);
    } else {
      await assertZeroGen1Raw(target);
    }
    console.log(`  ✓ ${label}`);
  }
  console.log("\n✓ Migration complete — zero Gen1 strategyKey rows.");
}

main()
  .catch((e) => {
    console.error("Migration failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
