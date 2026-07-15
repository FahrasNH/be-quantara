#!/usr/bin/env node
/**
 * Read-only DB audit: inventory Gen1 strategyKey values in Bot / Trade / Backtest tables.
 * Run: node scripts/audit-gen1-strategy-keys.js
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { GEN1_STRATEGY_KEYS, STRATEGY_MIGRATION_MAP } = require("../src/config/strategyKeyNormalizer");

const prisma = new PrismaClient();

const GEN1_LIST = [...GEN1_STRATEGY_KEYS];

async function groupByStrategyKey(model, field = "strategyKey") {
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
      return [];
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

  const tables = [
    { name: "Bot", model: "bot" },
    { name: "Trade", model: "trade" },
    { name: "Backtest", model: "backtest" },
    { name: "StrategyPerformance", model: "strategyPerformance" },
    { name: "TradeFeatureContext", model: "tradeFeatureContext" },
    { name: "MlShadowLog", model: "mlShadowLog" },
  ];

  let totalGen1 = 0;
  for (const { name, model } of tables) {
    const all = await groupByStrategyKey(model);
    const gen1 = filterGen1(all);
    console.log(`── ${name} (${all.length} distinct keys) ──`);
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
