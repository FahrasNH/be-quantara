-- ============================================================
-- Migration: 20260630100000_rename_af_to_af_sac
-- Purpose:   Rename ADAPTIVE_FUSION / SMART_MONEY_CONCEPTS bot
--            strategyKey values to "AF_SAC" (v2.0 component key).
--
-- TS_TM / MD_MR / BS_BR do NOT need a DB update because
-- StrategyRegistry registers TREND_MOMENTUM / MEAN_REVERSION /
-- BREAKOUT_RETEST as backward-compat aliases pointing to the
-- same strategy instances. The DB records are valid as-is.
-- ============================================================

-- Rename ADAPTIVE_FUSION → AF_SAC
UPDATE "Bot"
SET "strategyKey" = 'AF_SAC'
WHERE "strategyKey" = 'ADAPTIVE_FUSION';

-- Rename SMART_MONEY_CONCEPTS → AF_SAC (interim key used since SAC sprint)
UPDATE "Bot"
SET "strategyKey" = 'AF_SAC'
WHERE "strategyKey" = 'SMART_MONEY_CONCEPTS';

-- Rename legacy shorthand SAC → AF_SAC (if any bots used it directly)
UPDATE "Bot"
SET "strategyKey" = 'AF_SAC'
WHERE "strategyKey" = 'SAC';
