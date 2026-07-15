#!/usr/bin/env node
/**
 * Data migration: Gen1 strategyKey → Gen2 canonical per STRATEGY_MIGRATION_MAP.
 * Idempotent — safe to re-run. Asserts zero Gen1 rows after migration.
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const {
  STRATEGY_MIGRATION_MAP,
  GEN1_STRATEGY_KEYS,
} = require("../src/config/strategyKeyNormalizer");

const prisma = new PrismaClient();

const TABLES = [
  { model: "bot", field: "strategyKey" },
  { model: "trade", field: "strategyKey" },
  { model: "backtest", field: "strategyKey" },
  { model: "strategyPerformance", field: "strategyKey" },
  { model: "tradeFeatureContext", field: "strategyKey" },
  { model: "mlShadowLog", field: "strategyKey" },
];

async function migrateTable(model, field) {
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

async function assertZeroGen1(model, field) {
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

async function main() {
  console.log("\n═══ Gen1 → Gen2 strategyKey migration ═══\n");
  let total = 0;
  for (const { model, field } of TABLES) {
    console.log(`Migrating ${model}…`);
    total += await migrateTable(model, field);
  }
  console.log(`\nTotal rows updated: ${total}\nPost-migration assert:`);
  for (const { model, field } of TABLES) {
    await assertZeroGen1(model, field);
    console.log(`  ✓ ${model}.${field}`);
  }
  console.log("\n✓ Migration complete — zero Gen1 strategyKey rows.");
}

main()
  .catch((e) => {
    console.error("Migration failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
