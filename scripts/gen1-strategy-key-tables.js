/**
 * SSOT: Prisma + raw SQL targets for Gen1 strategy key audit/migration scripts.
 * Field names must match prisma/schema.prisma and database.js runtime tables.
 */

/** @typedef {{ kind: 'prisma', model: string, field: string, label?: string }} PrismaTarget */
/** @typedef {{ kind: 'raw', label: string, groupBySql: string, updateSql: (gen1: string, gen2: string) => string, countSql: (gen1List: string) => string }} RawTarget */

/** @type {Array<PrismaTarget | RawTarget>} */
const GEN1_STRATEGY_KEY_TARGETS = [
  { kind: "prisma", model: "bot", field: "strategyKey", label: "Bot.strategyKey" },
  { kind: "prisma", model: "userStrategy", field: "strategyKey", label: "UserStrategy.strategyKey" },
  { kind: "prisma", model: "trade", field: "firedByStrategy", label: "Trade.firedByStrategy" },
  { kind: "prisma", model: "strategyPerformance", field: "strategyKey", label: "StrategyPerformance.strategyKey" },
  { kind: "prisma", model: "mLShadowLog", field: "strategyKey", label: "MLShadowLog.strategyKey" },
  { kind: "prisma", model: "parameterSuggestion", field: "strategyKey", label: "ParameterSuggestion.strategyKey" },
  { kind: "prisma", model: "parameterVersion", field: "strategyKey", label: "ParameterVersion.strategyKey" },
  { kind: "prisma", model: "metaSelectorRecommendation", field: "actualStrategy", label: "MetaSelectorRecommendation.actualStrategy" },
  {
    kind: "raw",
    label: "Trade.entryContext.strategyKey (JSON)",
    groupBySql: `
      SELECT "entryContext"->>'strategyKey' AS key, COUNT(*)::int AS count
      FROM "Trade"
      WHERE "entryContext"->>'strategyKey' IS NOT NULL
      GROUP BY 1
    `,
    updateSql: (gen1, gen2) => `
      UPDATE "Trade"
      SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', to_jsonb('${gen2}'::text), true)
      WHERE "entryContext"->>'strategyKey' = '${gen1}'
    `,
    countSql: (gen1List) => `
      SELECT COUNT(*)::int AS count FROM "Trade"
      WHERE "entryContext"->>'strategyKey' IN (${gen1List})
    `,
  },
  {
    kind: "raw",
    label: "Bot.strategyGroup[] (array elements)",
    groupBySql: `
      SELECT unnest("strategyGroup") AS key, COUNT(*)::int AS count
      FROM "Bot"
      WHERE cardinality("strategyGroup") > 0
      GROUP BY 1
    `,
    updateSql: (gen1, gen2) => `
      UPDATE "Bot"
      SET "strategyGroup" = (
        SELECT COALESCE(array_agg(
          CASE elem WHEN '${gen1}' THEN '${gen2}' ELSE elem END
        ), ARRAY[]::text[])
        FROM unnest("strategyGroup") AS elem
      )
      WHERE '${gen1}' = ANY("strategyGroup")
    `,
    countSql: (gen1List) => `
      SELECT COUNT(*)::int AS count FROM "Bot"
      WHERE "strategyGroup" && ARRAY[${gen1List}]::text[]
    `,
  },
  {
    kind: "raw",
    label: "backtest_history.strategy_key",
    groupBySql: `
      SELECT strategy_key AS key, COUNT(*)::int AS count
      FROM backtest_history
      WHERE strategy_key IS NOT NULL
      GROUP BY 1
    `,
    updateSql: (gen1, gen2) => `
      UPDATE backtest_history SET strategy_key = '${gen2}' WHERE strategy_key = '${gen1}'
    `,
    countSql: (gen1List) => `
      SELECT COUNT(*)::int AS count FROM backtest_history WHERE strategy_key IN (${gen1List})
    `,
  },
  {
    kind: "raw",
    label: "strategy_presets.strategy_key",
    groupBySql: `
      SELECT strategy_key AS key, COUNT(*)::int AS count
      FROM strategy_presets
      WHERE strategy_key IS NOT NULL
      GROUP BY 1
    `,
    updateSql: (gen1, gen2) => `
      UPDATE strategy_presets SET strategy_key = '${gen2}' WHERE strategy_key = '${gen1}'
    `,
    countSql: (gen1List) => `
      SELECT COUNT(*)::int AS count FROM strategy_presets WHERE strategy_key IN (${gen1List})
    `,
  },
  {
    kind: "raw",
    label: "trades.strategy_name (engine runtime)",
    groupBySql: `
      SELECT strategy_name AS key, COUNT(*)::int AS count
      FROM trades
      WHERE strategy_name IS NOT NULL
      GROUP BY 1
    `,
    updateSql: (gen1, gen2) => `
      UPDATE trades SET strategy_name = '${gen2}' WHERE strategy_name = '${gen1}'
    `,
    countSql: (gen1List) => `
      SELECT COUNT(*)::int AS count FROM trades WHERE strategy_name IN (${gen1List})
    `,
  },
];

function sqlQuoteList(keys) {
  return keys.map((k) => `'${String(k).replace(/'/g, "''")}'`).join(", ");
}

module.exports = {
  GEN1_STRATEGY_KEY_TARGETS,
  sqlQuoteList,
};
