-- Migrate deprecated Gen2 abbrev strategy keys → full-word canonical keys (step 2 of 2)

-- ── Bot (core — must exist) ──────────────────────────────────────────────────
UPDATE "Bot" SET "strategyKey" = 'SMART_MONEY_CONCEPTS' WHERE "strategyKey" IN ('AF_SMC', 'ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
UPDATE "Bot" SET "strategyKey" = 'WYCKOFF' WHERE "strategyKey" IN ('AF_WYCKOFF', 'WYCKOFF');
UPDATE "Bot" SET "strategyKey" = 'VOLUME_SPREAD_ANALYSIS' WHERE "strategyKey" IN ('AF_VSA', 'VOLUME_SPREAD_ANALYSIS');
UPDATE "Bot" SET "strategyKey" = 'TREND_FOLLOWING' WHERE "strategyKey" IN ('TS_TF', 'TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
UPDATE "Bot" SET "strategyKey" = 'MARKET_STRUCTURE' WHERE "strategyKey" IN ('TS_MS', 'MARKET_STRUCTURE');
UPDATE "Bot" SET "strategyKey" = 'AUCTION_MARKET_THEORY' WHERE "strategyKey" IN ('TS_VP', 'AUCTION_MARKET_THEORY');
UPDATE "Bot" SET "strategyKey" = 'MEAN_REVERSION' WHERE "strategyKey" IN ('MD_MR', 'MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
UPDATE "Bot" SET "strategyKey" = 'SUPPLY_AND_DEMAND' WHERE "strategyKey" IN ('MD_SD', 'SUPPLY_AND_DEMAND');
UPDATE "Bot" SET "strategyKey" = 'STATISTICAL_ARBITRAGE' WHERE "strategyKey" IN ('MD_SA', 'STATISTICAL_ARBITRAGE');
UPDATE "Bot" SET "strategyKey" = 'BREAKOUT_RETEST' WHERE "strategyKey" IN ('BS_BR', 'BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
UPDATE "Bot" SET "strategyKey" = 'ICT_STYLE_TRADING' WHERE "strategyKey" IN ('BS_ICT', 'ICT_STYLE_TRADING');
UPDATE "Bot" SET "strategyKey" = 'LIQUIDATION_SQUEEZE' WHERE "strategyKey" IN ('BS_LS', 'LIQUIDATION_SQUEEZE');

UPDATE "Bot" SET "strategyGroup" = (
  SELECT COALESCE(array_agg(CASE elem
    WHEN 'AF_SMC' THEN 'SMART_MONEY_CONCEPTS' WHEN 'ADAPTIVE_FUSION' THEN 'SMART_MONEY_CONCEPTS' WHEN 'SAC' THEN 'SMART_MONEY_CONCEPTS' WHEN 'SMART_MONEY_CONCEPTS' THEN 'SMART_MONEY_CONCEPTS'
    WHEN 'AF_WYCKOFF' THEN 'WYCKOFF' WHEN 'WYCKOFF' THEN 'WYCKOFF'
    WHEN 'AF_VSA' THEN 'VOLUME_SPREAD_ANALYSIS' WHEN 'VOLUME_SPREAD_ANALYSIS' THEN 'VOLUME_SPREAD_ANALYSIS'
    WHEN 'TS_TF' THEN 'TREND_FOLLOWING' WHEN 'TREND_FOLLOWING' THEN 'TREND_FOLLOWING' WHEN 'TREND_SURGE' THEN 'TREND_FOLLOWING' WHEN 'TF' THEN 'TREND_FOLLOWING' WHEN 'TM' THEN 'TREND_FOLLOWING'
    WHEN 'TS_MS' THEN 'MARKET_STRUCTURE' WHEN 'MARKET_STRUCTURE' THEN 'MARKET_STRUCTURE'
    WHEN 'TS_VP' THEN 'AUCTION_MARKET_THEORY' WHEN 'AUCTION_MARKET_THEORY' THEN 'AUCTION_MARKET_THEORY'
    WHEN 'MD_MR' THEN 'MEAN_REVERSION' WHEN 'MEAN_REVERSION' THEN 'MEAN_REVERSION' WHEN 'MEAN_DRIFT' THEN 'MEAN_REVERSION' WHEN 'MR' THEN 'MEAN_REVERSION'
    WHEN 'MD_SD' THEN 'SUPPLY_AND_DEMAND' WHEN 'SUPPLY_AND_DEMAND' THEN 'SUPPLY_AND_DEMAND'
    WHEN 'MD_SA' THEN 'STATISTICAL_ARBITRAGE' WHEN 'STATISTICAL_ARBITRAGE' THEN 'STATISTICAL_ARBITRAGE'
    WHEN 'BS_BR' THEN 'BREAKOUT_RETEST' WHEN 'BREAKOUT_RETEST' THEN 'BREAKOUT_RETEST' WHEN 'BREAKOUT_STORM' THEN 'BREAKOUT_RETEST' WHEN 'BR' THEN 'BREAKOUT_RETEST'
    WHEN 'BS_ICT' THEN 'ICT_STYLE_TRADING' WHEN 'ICT_STYLE_TRADING' THEN 'ICT_STYLE_TRADING'
    WHEN 'BS_LS' THEN 'LIQUIDATION_SQUEEZE' WHEN 'LIQUIDATION_SQUEEZE' THEN 'LIQUIDATION_SQUEEZE'
    ELSE elem END), ARRAY[]::text[])
  FROM unnest("strategyGroup") AS elem
) WHERE "strategyGroup" && ARRAY['AF_SMC','AF_WYCKOFF','AF_VSA','TS_TF','TS_MS','TS_VP','MD_MR','MD_SD','MD_SA','BS_BR','BS_ICT','BS_LS','ADAPTIVE_FUSION','SAC','SMART_MONEY_CONCEPTS','WYCKOFF','VOLUME_SPREAD_ANALYSIS','TREND_FOLLOWING','TREND_SURGE','TF','TM','MARKET_STRUCTURE','AUCTION_MARKET_THEORY','MEAN_REVERSION','MEAN_DRIFT','MR','SUPPLY_AND_DEMAND','STATISTICAL_ARBITRAGE','BREAKOUT_RETEST','BREAKOUT_STORM','BR','ICT_STYLE_TRADING','LIQUIDATION_SQUEEZE']::text[];

-- ── Trade (core — must exist; firedByStrategy + entryContext JSON) ───────────
UPDATE "Trade" SET "firedByStrategy" = 'SMART_MONEY_CONCEPTS' WHERE "firedByStrategy" IN ('AF_SMC', 'ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
UPDATE "Trade" SET "firedByStrategy" = 'WYCKOFF' WHERE "firedByStrategy" IN ('AF_WYCKOFF', 'WYCKOFF');
UPDATE "Trade" SET "firedByStrategy" = 'VOLUME_SPREAD_ANALYSIS' WHERE "firedByStrategy" IN ('AF_VSA', 'VOLUME_SPREAD_ANALYSIS');
UPDATE "Trade" SET "firedByStrategy" = 'TREND_FOLLOWING' WHERE "firedByStrategy" IN ('TS_TF', 'TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
UPDATE "Trade" SET "firedByStrategy" = 'MARKET_STRUCTURE' WHERE "firedByStrategy" IN ('TS_MS', 'MARKET_STRUCTURE');
UPDATE "Trade" SET "firedByStrategy" = 'AUCTION_MARKET_THEORY' WHERE "firedByStrategy" IN ('TS_VP', 'AUCTION_MARKET_THEORY');
UPDATE "Trade" SET "firedByStrategy" = 'MEAN_REVERSION' WHERE "firedByStrategy" IN ('MD_MR', 'MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
UPDATE "Trade" SET "firedByStrategy" = 'SUPPLY_AND_DEMAND' WHERE "firedByStrategy" IN ('MD_SD', 'SUPPLY_AND_DEMAND');
UPDATE "Trade" SET "firedByStrategy" = 'STATISTICAL_ARBITRAGE' WHERE "firedByStrategy" IN ('MD_SA', 'STATISTICAL_ARBITRAGE');
UPDATE "Trade" SET "firedByStrategy" = 'BREAKOUT_RETEST' WHERE "firedByStrategy" IN ('BS_BR', 'BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
UPDATE "Trade" SET "firedByStrategy" = 'ICT_STYLE_TRADING' WHERE "firedByStrategy" IN ('BS_ICT', 'ICT_STYLE_TRADING');
UPDATE "Trade" SET "firedByStrategy" = 'LIQUIDATION_SQUEEZE' WHERE "firedByStrategy" IN ('BS_LS', 'LIQUIDATION_SQUEEZE');

UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"SMART_MONEY_CONCEPTS"', true) WHERE "entryContext"->>'strategyKey' IN ('AF_SMC', 'ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"WYCKOFF"', true) WHERE "entryContext"->>'strategyKey' IN ('AF_WYCKOFF', 'WYCKOFF');
UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"VOLUME_SPREAD_ANALYSIS"', true) WHERE "entryContext"->>'strategyKey' IN ('AF_VSA', 'VOLUME_SPREAD_ANALYSIS');
UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"TREND_FOLLOWING"', true) WHERE "entryContext"->>'strategyKey' IN ('TS_TF', 'TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"MARKET_STRUCTURE"', true) WHERE "entryContext"->>'strategyKey' IN ('TS_MS', 'MARKET_STRUCTURE');
UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"AUCTION_MARKET_THEORY"', true) WHERE "entryContext"->>'strategyKey' IN ('TS_VP', 'AUCTION_MARKET_THEORY');
UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"MEAN_REVERSION"', true) WHERE "entryContext"->>'strategyKey' IN ('MD_MR', 'MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"SUPPLY_AND_DEMAND"', true) WHERE "entryContext"->>'strategyKey' IN ('MD_SD', 'SUPPLY_AND_DEMAND');
UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"STATISTICAL_ARBITRAGE"', true) WHERE "entryContext"->>'strategyKey' IN ('MD_SA', 'STATISTICAL_ARBITRAGE');
UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"BREAKOUT_RETEST"', true) WHERE "entryContext"->>'strategyKey' IN ('BS_BR', 'BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"ICT_STYLE_TRADING"', true) WHERE "entryContext"->>'strategyKey' IN ('BS_ICT', 'ICT_STYLE_TRADING');
UPDATE "Trade" SET "entryContext" = jsonb_set("entryContext", '{strategyKey}', '"LIQUIDATION_SQUEEZE"', true) WHERE "entryContext"->>'strategyKey' IN ('BS_LS', 'LIQUIDATION_SQUEEZE');

-- ── Optional Prisma tables (may not exist on fresh/partial DBs) ──────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'UserStrategy') THEN
    UPDATE "UserStrategy" SET "strategyKey" = 'SMART_MONEY_CONCEPTS' WHERE "strategyKey" IN ('AF_SMC', 'ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE "UserStrategy" SET "strategyKey" = 'WYCKOFF' WHERE "strategyKey" IN ('AF_WYCKOFF', 'WYCKOFF');
    UPDATE "UserStrategy" SET "strategyKey" = 'VOLUME_SPREAD_ANALYSIS' WHERE "strategyKey" IN ('AF_VSA', 'VOLUME_SPREAD_ANALYSIS');
    UPDATE "UserStrategy" SET "strategyKey" = 'TREND_FOLLOWING' WHERE "strategyKey" IN ('TS_TF', 'TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE "UserStrategy" SET "strategyKey" = 'MARKET_STRUCTURE' WHERE "strategyKey" IN ('TS_MS', 'MARKET_STRUCTURE');
    UPDATE "UserStrategy" SET "strategyKey" = 'AUCTION_MARKET_THEORY' WHERE "strategyKey" IN ('TS_VP', 'AUCTION_MARKET_THEORY');
    UPDATE "UserStrategy" SET "strategyKey" = 'MEAN_REVERSION' WHERE "strategyKey" IN ('MD_MR', 'MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE "UserStrategy" SET "strategyKey" = 'SUPPLY_AND_DEMAND' WHERE "strategyKey" IN ('MD_SD', 'SUPPLY_AND_DEMAND');
    UPDATE "UserStrategy" SET "strategyKey" = 'STATISTICAL_ARBITRAGE' WHERE "strategyKey" IN ('MD_SA', 'STATISTICAL_ARBITRAGE');
    UPDATE "UserStrategy" SET "strategyKey" = 'BREAKOUT_RETEST' WHERE "strategyKey" IN ('BS_BR', 'BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
    UPDATE "UserStrategy" SET "strategyKey" = 'ICT_STYLE_TRADING' WHERE "strategyKey" IN ('BS_ICT', 'ICT_STYLE_TRADING');
    UPDATE "UserStrategy" SET "strategyKey" = 'LIQUIDATION_SQUEEZE' WHERE "strategyKey" IN ('BS_LS', 'LIQUIDATION_SQUEEZE');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'StrategyPerformance') THEN
    UPDATE "StrategyPerformance" SET "strategyKey" = 'SMART_MONEY_CONCEPTS' WHERE "strategyKey" IN ('AF_SMC', 'ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE "StrategyPerformance" SET "strategyKey" = 'WYCKOFF' WHERE "strategyKey" IN ('AF_WYCKOFF', 'WYCKOFF');
    UPDATE "StrategyPerformance" SET "strategyKey" = 'VOLUME_SPREAD_ANALYSIS' WHERE "strategyKey" IN ('AF_VSA', 'VOLUME_SPREAD_ANALYSIS');
    UPDATE "StrategyPerformance" SET "strategyKey" = 'TREND_FOLLOWING' WHERE "strategyKey" IN ('TS_TF', 'TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE "StrategyPerformance" SET "strategyKey" = 'MARKET_STRUCTURE' WHERE "strategyKey" IN ('TS_MS', 'MARKET_STRUCTURE');
    UPDATE "StrategyPerformance" SET "strategyKey" = 'AUCTION_MARKET_THEORY' WHERE "strategyKey" IN ('TS_VP', 'AUCTION_MARKET_THEORY');
    UPDATE "StrategyPerformance" SET "strategyKey" = 'MEAN_REVERSION' WHERE "strategyKey" IN ('MD_MR', 'MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE "StrategyPerformance" SET "strategyKey" = 'SUPPLY_AND_DEMAND' WHERE "strategyKey" IN ('MD_SD', 'SUPPLY_AND_DEMAND');
    UPDATE "StrategyPerformance" SET "strategyKey" = 'STATISTICAL_ARBITRAGE' WHERE "strategyKey" IN ('MD_SA', 'STATISTICAL_ARBITRAGE');
    UPDATE "StrategyPerformance" SET "strategyKey" = 'BREAKOUT_RETEST' WHERE "strategyKey" IN ('BS_BR', 'BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
    UPDATE "StrategyPerformance" SET "strategyKey" = 'ICT_STYLE_TRADING' WHERE "strategyKey" IN ('BS_ICT', 'ICT_STYLE_TRADING');
    UPDATE "StrategyPerformance" SET "strategyKey" = 'LIQUIDATION_SQUEEZE' WHERE "strategyKey" IN ('BS_LS', 'LIQUIDATION_SQUEEZE');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'MLShadowLog') THEN
    UPDATE "MLShadowLog" SET "strategyKey" = 'SMART_MONEY_CONCEPTS' WHERE "strategyKey" IN ('AF_SMC', 'ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE "MLShadowLog" SET "strategyKey" = 'WYCKOFF' WHERE "strategyKey" IN ('AF_WYCKOFF', 'WYCKOFF');
    UPDATE "MLShadowLog" SET "strategyKey" = 'VOLUME_SPREAD_ANALYSIS' WHERE "strategyKey" IN ('AF_VSA', 'VOLUME_SPREAD_ANALYSIS');
    UPDATE "MLShadowLog" SET "strategyKey" = 'TREND_FOLLOWING' WHERE "strategyKey" IN ('TS_TF', 'TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE "MLShadowLog" SET "strategyKey" = 'MARKET_STRUCTURE' WHERE "strategyKey" IN ('TS_MS', 'MARKET_STRUCTURE');
    UPDATE "MLShadowLog" SET "strategyKey" = 'AUCTION_MARKET_THEORY' WHERE "strategyKey" IN ('TS_VP', 'AUCTION_MARKET_THEORY');
    UPDATE "MLShadowLog" SET "strategyKey" = 'MEAN_REVERSION' WHERE "strategyKey" IN ('MD_MR', 'MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE "MLShadowLog" SET "strategyKey" = 'SUPPLY_AND_DEMAND' WHERE "strategyKey" IN ('MD_SD', 'SUPPLY_AND_DEMAND');
    UPDATE "MLShadowLog" SET "strategyKey" = 'STATISTICAL_ARBITRAGE' WHERE "strategyKey" IN ('MD_SA', 'STATISTICAL_ARBITRAGE');
    UPDATE "MLShadowLog" SET "strategyKey" = 'BREAKOUT_RETEST' WHERE "strategyKey" IN ('BS_BR', 'BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
    UPDATE "MLShadowLog" SET "strategyKey" = 'ICT_STYLE_TRADING' WHERE "strategyKey" IN ('BS_ICT', 'ICT_STYLE_TRADING');
    UPDATE "MLShadowLog" SET "strategyKey" = 'LIQUIDATION_SQUEEZE' WHERE "strategyKey" IN ('BS_LS', 'LIQUIDATION_SQUEEZE');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ParameterSuggestion') THEN
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'SMART_MONEY_CONCEPTS' WHERE "strategyKey" IN ('AF_SMC', 'ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'WYCKOFF' WHERE "strategyKey" IN ('AF_WYCKOFF', 'WYCKOFF');
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'VOLUME_SPREAD_ANALYSIS' WHERE "strategyKey" IN ('AF_VSA', 'VOLUME_SPREAD_ANALYSIS');
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'TREND_FOLLOWING' WHERE "strategyKey" IN ('TS_TF', 'TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'MARKET_STRUCTURE' WHERE "strategyKey" IN ('TS_MS', 'MARKET_STRUCTURE');
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'AUCTION_MARKET_THEORY' WHERE "strategyKey" IN ('TS_VP', 'AUCTION_MARKET_THEORY');
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'MEAN_REVERSION' WHERE "strategyKey" IN ('MD_MR', 'MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'SUPPLY_AND_DEMAND' WHERE "strategyKey" IN ('MD_SD', 'SUPPLY_AND_DEMAND');
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'STATISTICAL_ARBITRAGE' WHERE "strategyKey" IN ('MD_SA', 'STATISTICAL_ARBITRAGE');
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'BREAKOUT_RETEST' WHERE "strategyKey" IN ('BS_BR', 'BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'ICT_STYLE_TRADING' WHERE "strategyKey" IN ('BS_ICT', 'ICT_STYLE_TRADING');
    UPDATE "ParameterSuggestion" SET "strategyKey" = 'LIQUIDATION_SQUEEZE' WHERE "strategyKey" IN ('BS_LS', 'LIQUIDATION_SQUEEZE');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ParameterVersion') THEN
    UPDATE "ParameterVersion" SET "strategyKey" = 'SMART_MONEY_CONCEPTS' WHERE "strategyKey" IN ('AF_SMC', 'ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE "ParameterVersion" SET "strategyKey" = 'WYCKOFF' WHERE "strategyKey" IN ('AF_WYCKOFF', 'WYCKOFF');
    UPDATE "ParameterVersion" SET "strategyKey" = 'VOLUME_SPREAD_ANALYSIS' WHERE "strategyKey" IN ('AF_VSA', 'VOLUME_SPREAD_ANALYSIS');
    UPDATE "ParameterVersion" SET "strategyKey" = 'TREND_FOLLOWING' WHERE "strategyKey" IN ('TS_TF', 'TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE "ParameterVersion" SET "strategyKey" = 'MARKET_STRUCTURE' WHERE "strategyKey" IN ('TS_MS', 'MARKET_STRUCTURE');
    UPDATE "ParameterVersion" SET "strategyKey" = 'AUCTION_MARKET_THEORY' WHERE "strategyKey" IN ('TS_VP', 'AUCTION_MARKET_THEORY');
    UPDATE "ParameterVersion" SET "strategyKey" = 'MEAN_REVERSION' WHERE "strategyKey" IN ('MD_MR', 'MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE "ParameterVersion" SET "strategyKey" = 'SUPPLY_AND_DEMAND' WHERE "strategyKey" IN ('MD_SD', 'SUPPLY_AND_DEMAND');
    UPDATE "ParameterVersion" SET "strategyKey" = 'STATISTICAL_ARBITRAGE' WHERE "strategyKey" IN ('MD_SA', 'STATISTICAL_ARBITRAGE');
    UPDATE "ParameterVersion" SET "strategyKey" = 'BREAKOUT_RETEST' WHERE "strategyKey" IN ('BS_BR', 'BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
    UPDATE "ParameterVersion" SET "strategyKey" = 'ICT_STYLE_TRADING' WHERE "strategyKey" IN ('BS_ICT', 'ICT_STYLE_TRADING');
    UPDATE "ParameterVersion" SET "strategyKey" = 'LIQUIDATION_SQUEEZE' WHERE "strategyKey" IN ('BS_LS', 'LIQUIDATION_SQUEEZE');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'MetaSelectorRecommendation') THEN
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'SMART_MONEY_CONCEPTS' WHERE "actualStrategy" IN ('AF_SMC', 'ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'WYCKOFF' WHERE "actualStrategy" IN ('AF_WYCKOFF', 'WYCKOFF');
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'VOLUME_SPREAD_ANALYSIS' WHERE "actualStrategy" IN ('AF_VSA', 'VOLUME_SPREAD_ANALYSIS');
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'TREND_FOLLOWING' WHERE "actualStrategy" IN ('TS_TF', 'TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'MARKET_STRUCTURE' WHERE "actualStrategy" IN ('TS_MS', 'MARKET_STRUCTURE');
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'AUCTION_MARKET_THEORY' WHERE "actualStrategy" IN ('TS_VP', 'AUCTION_MARKET_THEORY');
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'MEAN_REVERSION' WHERE "actualStrategy" IN ('MD_MR', 'MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'SUPPLY_AND_DEMAND' WHERE "actualStrategy" IN ('MD_SD', 'SUPPLY_AND_DEMAND');
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'STATISTICAL_ARBITRAGE' WHERE "actualStrategy" IN ('MD_SA', 'STATISTICAL_ARBITRAGE');
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'BREAKOUT_RETEST' WHERE "actualStrategy" IN ('BS_BR', 'BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'ICT_STYLE_TRADING' WHERE "actualStrategy" IN ('BS_ICT', 'ICT_STYLE_TRADING');
    UPDATE "MetaSelectorRecommendation" SET "actualStrategy" = 'LIQUIDATION_SQUEEZE' WHERE "actualStrategy" IN ('BS_LS', 'LIQUIDATION_SQUEEZE');
  END IF;

  -- Runtime engine tables (optional)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'backtest_history') THEN
    UPDATE backtest_history SET strategy_key = 'SMART_MONEY_CONCEPTS' WHERE strategy_key IN ('AF_SMC', 'ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE backtest_history SET strategy_key = 'WYCKOFF' WHERE strategy_key IN ('AF_WYCKOFF', 'WYCKOFF');
    UPDATE backtest_history SET strategy_key = 'VOLUME_SPREAD_ANALYSIS' WHERE strategy_key IN ('AF_VSA', 'VOLUME_SPREAD_ANALYSIS');
    UPDATE backtest_history SET strategy_key = 'TREND_FOLLOWING' WHERE strategy_key IN ('TS_TF', 'TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE backtest_history SET strategy_key = 'MARKET_STRUCTURE' WHERE strategy_key IN ('TS_MS', 'MARKET_STRUCTURE');
    UPDATE backtest_history SET strategy_key = 'AUCTION_MARKET_THEORY' WHERE strategy_key IN ('TS_VP', 'AUCTION_MARKET_THEORY');
    UPDATE backtest_history SET strategy_key = 'MEAN_REVERSION' WHERE strategy_key IN ('MD_MR', 'MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE backtest_history SET strategy_key = 'SUPPLY_AND_DEMAND' WHERE strategy_key IN ('MD_SD', 'SUPPLY_AND_DEMAND');
    UPDATE backtest_history SET strategy_key = 'STATISTICAL_ARBITRAGE' WHERE strategy_key IN ('MD_SA', 'STATISTICAL_ARBITRAGE');
    UPDATE backtest_history SET strategy_key = 'BREAKOUT_RETEST' WHERE strategy_key IN ('BS_BR', 'BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
    UPDATE backtest_history SET strategy_key = 'ICT_STYLE_TRADING' WHERE strategy_key IN ('BS_ICT', 'ICT_STYLE_TRADING');
    UPDATE backtest_history SET strategy_key = 'LIQUIDATION_SQUEEZE' WHERE strategy_key IN ('BS_LS', 'LIQUIDATION_SQUEEZE');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'strategy_presets') THEN
    UPDATE strategy_presets SET strategy_key = 'SMART_MONEY_CONCEPTS' WHERE strategy_key IN ('AF_SMC', 'ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE strategy_presets SET strategy_key = 'WYCKOFF' WHERE strategy_key IN ('AF_WYCKOFF', 'WYCKOFF');
    UPDATE strategy_presets SET strategy_key = 'VOLUME_SPREAD_ANALYSIS' WHERE strategy_key IN ('AF_VSA', 'VOLUME_SPREAD_ANALYSIS');
    UPDATE strategy_presets SET strategy_key = 'TREND_FOLLOWING' WHERE strategy_key IN ('TS_TF', 'TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE strategy_presets SET strategy_key = 'MARKET_STRUCTURE' WHERE strategy_key IN ('TS_MS', 'MARKET_STRUCTURE');
    UPDATE strategy_presets SET strategy_key = 'AUCTION_MARKET_THEORY' WHERE strategy_key IN ('TS_VP', 'AUCTION_MARKET_THEORY');
    UPDATE strategy_presets SET strategy_key = 'MEAN_REVERSION' WHERE strategy_key IN ('MD_MR', 'MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE strategy_presets SET strategy_key = 'SUPPLY_AND_DEMAND' WHERE strategy_key IN ('MD_SD', 'SUPPLY_AND_DEMAND');
    UPDATE strategy_presets SET strategy_key = 'STATISTICAL_ARBITRAGE' WHERE strategy_key IN ('MD_SA', 'STATISTICAL_ARBITRAGE');
    UPDATE strategy_presets SET strategy_key = 'BREAKOUT_RETEST' WHERE strategy_key IN ('BS_BR', 'BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
    UPDATE strategy_presets SET strategy_key = 'ICT_STYLE_TRADING' WHERE strategy_key IN ('BS_ICT', 'ICT_STYLE_TRADING');
    UPDATE strategy_presets SET strategy_key = 'LIQUIDATION_SQUEEZE' WHERE strategy_key IN ('BS_LS', 'LIQUIDATION_SQUEEZE');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'trades') THEN
    UPDATE trades SET strategy_name = 'SMART_MONEY_CONCEPTS' WHERE strategy_name IN ('AF_SMC', 'ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
    UPDATE trades SET strategy_name = 'WYCKOFF' WHERE strategy_name IN ('AF_WYCKOFF', 'WYCKOFF');
    UPDATE trades SET strategy_name = 'VOLUME_SPREAD_ANALYSIS' WHERE strategy_name IN ('AF_VSA', 'VOLUME_SPREAD_ANALYSIS');
    UPDATE trades SET strategy_name = 'TREND_FOLLOWING' WHERE strategy_name IN ('TS_TF', 'TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
    UPDATE trades SET strategy_name = 'MARKET_STRUCTURE' WHERE strategy_name IN ('TS_MS', 'MARKET_STRUCTURE');
    UPDATE trades SET strategy_name = 'AUCTION_MARKET_THEORY' WHERE strategy_name IN ('TS_VP', 'AUCTION_MARKET_THEORY');
    UPDATE trades SET strategy_name = 'MEAN_REVERSION' WHERE strategy_name IN ('MD_MR', 'MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
    UPDATE trades SET strategy_name = 'SUPPLY_AND_DEMAND' WHERE strategy_name IN ('MD_SD', 'SUPPLY_AND_DEMAND');
    UPDATE trades SET strategy_name = 'STATISTICAL_ARBITRAGE' WHERE strategy_name IN ('MD_SA', 'STATISTICAL_ARBITRAGE');
    UPDATE trades SET strategy_name = 'BREAKOUT_RETEST' WHERE strategy_name IN ('BS_BR', 'BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
    UPDATE trades SET strategy_name = 'ICT_STYLE_TRADING' WHERE strategy_name IN ('BS_ICT', 'ICT_STYLE_TRADING');
    UPDATE trades SET strategy_name = 'LIQUIDATION_SQUEEZE' WHERE strategy_name IN ('BS_LS', 'LIQUIDATION_SQUEEZE');
  END IF;
END $$;
