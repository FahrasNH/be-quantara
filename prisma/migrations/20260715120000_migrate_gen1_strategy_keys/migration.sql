-- Gen1 strategyKey → Gen2 abbrev canonical (step 1 of 2; step 2 = 20260715200000)
-- SSOT field names: Bot/UserStrategy.strategyKey, Trade.firedByStrategy,
-- Trade.entryContext JSON, backtest_history.strategy_key, trades.strategy_name
-- Idempotent: only updates rows still holding Gen1 keys.

-- ── Bot (core — must exist) ──────────────────────────────────────────────────
UPDATE "Bot" SET "strategyKey" = 'AF_SMC' WHERE "strategyKey" IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
UPDATE "Bot" SET "strategyKey" = 'TS_TF' WHERE "strategyKey" IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
UPDATE "Bot" SET "strategyKey" = 'MD_MR' WHERE "strategyKey" IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
UPDATE "Bot" SET "strategyKey" = 'BS_BR' WHERE "strategyKey" IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');

UPDATE "Bot" SET "strategyGroup" = (
  SELECT COALESCE(array_agg(CASE elem
    WHEN 'ADAPTIVE_FUSION' THEN 'AF_SMC' WHEN 'SAC' THEN 'AF_SMC' WHEN 'SMART_MONEY_CONCEPTS' THEN 'AF_SMC'
    WHEN 'TREND_FOLLOWING' THEN 'TS_TF' WHEN 'TREND_SURGE' THEN 'TS_TF' WHEN 'TF' THEN 'TS_TF' WHEN 'TM' THEN 'TS_TF'
    WHEN 'MEAN_REVERSION' THEN 'MD_MR' WHEN 'MEAN_DRIFT' THEN 'MD_MR' WHEN 'MR' THEN 'MD_MR'
    WHEN 'BREAKOUT_RETEST' THEN 'BS_BR' WHEN 'BREAKOUT_STORM' THEN 'BS_BR' WHEN 'BR' THEN 'BS_BR'
    ELSE elem END), ARRAY[]::text[])
  FROM unnest("strategyGroup") AS elem
) WHERE "strategyGroup" && ARRAY['ADAPTIVE_FUSION','SAC','SMART_MONEY_CONCEPTS','TREND_FOLLOWING','TREND_SURGE','TF','TM','MEAN_REVERSION','MEAN_DRIFT','MR','BREAKOUT_RETEST','BREAKOUT_STORM','BR']::text[];

-- ── Trade (core — must exist; firedByStrategy + entryContext JSON) ───────────
UPDATE "Trade" SET "firedByStrategy" = 'AF_SMC' WHERE "firedByStrategy" IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
UPDATE "Trade" SET "firedByStrategy" = 'TS_TF' WHERE "firedByStrategy" IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
UPDATE "Trade" SET "firedByStrategy" = 'MD_MR' WHERE "firedByStrategy" IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
UPDATE "Trade" SET "firedByStrategy" = 'BS_BR' WHERE "firedByStrategy" IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');

UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"AF_SMC"', true)
  WHERE "entryContext"->>'strategyKey' IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"TS_TF"', true)
  WHERE "entryContext"->>'strategyKey' IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"MD_MR"', true)
  WHERE "entryContext"->>'strategyKey' IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"BS_BR"', true)
  WHERE "entryContext"->>'strategyKey' IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');

-- ── Optional Prisma tables (may not exist on fresh/partial DBs) ──────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'UserStrategy') THEN
    UPDATE "UserStrategy" SET "strategyKey" = 'AF_SMC' WHERE "strategyKey" IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE "UserStrategy" SET "strategyKey" = 'TS_TF' WHERE "strategyKey" IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE "UserStrategy" SET "strategyKey" = 'MD_MR' WHERE "strategyKey" IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE "UserStrategy" SET "strategyKey" = 'BS_BR' WHERE "strategyKey" IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'StrategyPerformance') THEN
    UPDATE "StrategyPerformance" SET "strategyKey" = 'AF_SMC' WHERE "strategyKey" IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE "StrategyPerformance" SET "strategyKey" = 'TS_TF' WHERE "strategyKey" IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE "StrategyPerformance" SET "strategyKey" = 'MD_MR' WHERE "strategyKey" IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE "StrategyPerformance" SET "strategyKey" = 'BS_BR' WHERE "strategyKey" IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'MLShadowLog') THEN
    UPDATE "MLShadowLog" SET "strategyKey" = 'AF_SMC' WHERE "strategyKey" IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE "MLShadowLog" SET "strategyKey" = 'TS_TF' WHERE "strategyKey" IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE "MLShadowLog" SET "strategyKey" = 'MD_MR' WHERE "strategyKey" IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE "MLShadowLog" SET "strategyKey" = 'BS_BR' WHERE "strategyKey" IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ParameterSuggestion') THEN
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'AF_SMC' WHERE "strategyKey" IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'TS_TF' WHERE "strategyKey" IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'MD_MR' WHERE "strategyKey" IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'BS_BR' WHERE "strategyKey" IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ParameterVersion') THEN
    UPDATE "ParameterVersion" SET "strategyKey" = 'AF_SMC' WHERE "strategyKey" IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE "ParameterVersion" SET "strategyKey" = 'TS_TF' WHERE "strategyKey" IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE "ParameterVersion" SET "strategyKey" = 'MD_MR' WHERE "strategyKey" IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE "ParameterVersion" SET "strategyKey" = 'BS_BR' WHERE "strategyKey" IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'MetaSelectorRecommendation') THEN
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'AF_SMC' WHERE "actualStrategy" IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'TS_TF' WHERE "actualStrategy" IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'MD_MR' WHERE "actualStrategy" IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'BS_BR' WHERE "actualStrategy" IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
  END IF;

  -- Runtime engine tables (may not exist on fresh Prisma-only DBs)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'backtest_history') THEN
    UPDATE backtest_history SET strategy_key = 'AF_SMC' WHERE strategy_key IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE backtest_history SET strategy_key = 'TS_TF' WHERE strategy_key IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE backtest_history SET strategy_key = 'MD_MR' WHERE strategy_key IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE backtest_history SET strategy_key = 'BS_BR' WHERE strategy_key IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'strategy_presets') THEN
    UPDATE strategy_presets SET strategy_key = 'AF_SMC' WHERE strategy_key IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE strategy_presets SET strategy_key = 'TS_TF' WHERE strategy_key IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE strategy_presets SET strategy_key = 'MD_MR' WHERE strategy_key IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE strategy_presets SET strategy_key = 'BS_BR' WHERE strategy_key IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'trades') THEN
    UPDATE trades SET strategy_name = 'AF_SMC' WHERE strategy_name IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE trades SET strategy_name = 'TS_TF' WHERE strategy_name IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE trades SET strategy_name = 'MD_MR' WHERE strategy_name IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE trades SET strategy_name = 'BS_BR' WHERE strategy_name IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
  END IF;
END $$;
