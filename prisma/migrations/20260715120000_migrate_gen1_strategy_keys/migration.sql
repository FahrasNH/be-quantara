-- Gen1 strategyKey → Gen2 canonical (SSOT: strategyKeyNormalizer.js STRATEGY_MIGRATION_MAP)
-- Idempotent: only updates rows still holding Gen1 keys.

UPDATE "Bot" SET "strategyKey" = 'AF_SMC' WHERE "strategyKey" IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
UPDATE "Bot" SET "strategyKey" = 'TS_TF' WHERE "strategyKey" IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
UPDATE "Bot" SET "strategyKey" = 'MD_MR' WHERE "strategyKey" IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
UPDATE "Bot" SET "strategyKey" = 'BS_BR' WHERE "strategyKey" IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');

UPDATE "Trade" SET "strategyKey" = 'AF_SMC' WHERE "strategyKey" IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
UPDATE "Trade" SET "strategyKey" = 'TS_TF' WHERE "strategyKey" IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
UPDATE "Trade" SET "strategyKey" = 'MD_MR' WHERE "strategyKey" IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
UPDATE "Trade" SET "strategyKey" = 'BS_BR' WHERE "strategyKey" IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');

UPDATE "Backtest" SET "strategyKey" = 'AF_SMC' WHERE "strategyKey" IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
UPDATE "Backtest" SET "strategyKey" = 'TS_TF' WHERE "strategyKey" IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
UPDATE "Backtest" SET "strategyKey" = 'MD_MR' WHERE "strategyKey" IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
UPDATE "Backtest" SET "strategyKey" = 'BS_BR' WHERE "strategyKey" IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');

-- Analytics / ML tables (if present)
UPDATE "StrategyPerformance" SET "strategyKey" = 'AF_SMC' WHERE "strategyKey" IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
UPDATE "StrategyPerformance" SET "strategyKey" = 'TS_TF' WHERE "strategyKey" IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
UPDATE "StrategyPerformance" SET "strategyKey" = 'MD_MR' WHERE "strategyKey" IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
UPDATE "StrategyPerformance" SET "strategyKey" = 'BS_BR' WHERE "strategyKey" IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');

UPDATE "TradeFeatureContext" SET "strategyKey" = 'AF_SMC' WHERE "strategyKey" IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
UPDATE "TradeFeatureContext" SET "strategyKey" = 'TS_TF' WHERE "strategyKey" IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
UPDATE "TradeFeatureContext" SET "strategyKey" = 'MD_MR' WHERE "strategyKey" IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
UPDATE "TradeFeatureContext" SET "strategyKey" = 'BS_BR' WHERE "strategyKey" IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');

UPDATE "MlShadowLog" SET "strategyKey" = 'AF_SMC' WHERE "strategyKey" IN ('ADAPTIVE_FUSION', 'SAC', 'SMART_MONEY_CONCEPTS');
UPDATE "MlShadowLog" SET "strategyKey" = 'TS_TF' WHERE "strategyKey" IN ('TREND_FOLLOWING', 'TREND_SURGE', 'TF', 'TM');
UPDATE "MlShadowLog" SET "strategyKey" = 'MD_MR' WHERE "strategyKey" IN ('MEAN_REVERSION', 'MEAN_DRIFT', 'MR');
UPDATE "MlShadowLog" SET "strategyKey" = 'BS_BR' WHERE "strategyKey" IN ('BREAKOUT_RETEST', 'BREAKOUT_STORM', 'BR');
