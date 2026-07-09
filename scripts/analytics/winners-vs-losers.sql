-- ─────────────────────────────────────────────────────────────────────────────
-- winners-vs-losers.sql — Sprint 2 / PA-2
--
-- Parameterized SQL for regime + strategy win/loss feature analysis.
-- Parameters:
--   $1 = strategyKey (text, NULL = all strategies)
--   $2 = symbol      (text, NULL = all symbols)
--   $3 = regime      (text, NULL = all regimes)
--   $4 = period_days (int,  NULL = all time)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Query 1: Win Rate per Regime + Strategy ──────────────────────────────────
-- Returns aggregated WR, trade count, avg PnL per (strategyKey, regime) bucket.

SELECT
  ec.strategy_key                                   AS "strategyKey",
  ec.regime                                         AS "regime",
  COUNT(*)                                          AS "tradeCount",
  ROUND(
    100.0 * SUM(CASE WHEN t."pnlPercent" > 0 THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0), 2
  )                                                 AS "winRatePct",
  ROUND(AVG(t."pnlPercent")::numeric, 4)            AS "avgPnlPct",
  ROUND(AVG(
    EXTRACT(EPOCH FROM (t."exitedAt" - t."enteredAt")) / 3600
  )::numeric, 2)                                    AS "avgHoldingHours"
FROM "Trade" t
CROSS JOIN LATERAL (
  SELECT
    COALESCE(
      t."entryContext"->>'strategyKey',
      t."firedByStrategy",
      'UNKNOWN'
    )                                              AS strategy_key,
    COALESCE(
      t."entryContext"->'market'->>'regime',
      t."entryContext"->>'htfRegime',
      'unknown'
    )                                              AS regime
) ec
WHERE
  t."status"        = 'CLOSED'
  AND t."entryContext" IS NOT NULL
  AND ($1::text IS NULL OR ec.strategy_key = $1)
  AND ($2::text IS NULL OR t."symbol"      = $2)
  AND ($3::text IS NULL OR ec.regime       = $3)
  AND ($4::int  IS NULL OR t."exitedAt"   >= NOW() - ($4 || ' days')::interval)
GROUP BY ec.strategy_key, ec.regime
ORDER BY "winRatePct" DESC NULLS LAST, "tradeCount" DESC;


-- ── Query 2: Feature Comparison — Winners vs Losers ──────────────────────────
-- Average ATR, ADX, RSI, volumeRatio for winning vs losing trades.

SELECT
  outcome                                                   AS "outcome",
  ROUND(AVG((t."entryContext"->>'atr')::numeric)::numeric,  4) AS "avgAtr",
  ROUND(AVG((t."entryContext"->>'adx')::numeric)::numeric,  4) AS "avgAdx",
  ROUND(AVG((t."entryContext"->>'rsi')::numeric)::numeric,  4) AS "avgRsi",
  ROUND(AVG((t."entryContext"->>'volumeRatio')::numeric)::numeric, 4) AS "avgVolumeRatio",
  ROUND(AVG((t."entryContext"->>'bbWidth')::numeric)::numeric, 4)     AS "avgBbWidth",
  COUNT(*)                                                  AS "tradeCount"
FROM "Trade" t
CROSS JOIN LATERAL (
  SELECT CASE WHEN t."pnlPercent" > 0 THEN 'winner' ELSE 'loser' END AS outcome
) o
WHERE
  t."status"        = 'CLOSED'
  AND t."entryContext" IS NOT NULL
  AND ($1::text IS NULL OR COALESCE(t."entryContext"->>'strategyKey', t."firedByStrategy") = $1)
  AND ($2::text IS NULL OR t."symbol" = $2)
  AND ($3::text IS NULL OR COALESCE(
    t."entryContext"->'market'->>'regime',
    t."entryContext"->>'htfRegime'
  ) = $3)
  AND ($4::int  IS NULL OR t."exitedAt" >= NOW() - ($4 || ' days')::interval)
GROUP BY outcome
ORDER BY outcome;


-- ── Query 3: Top Features Correlated with Wins (by Regime) ───────────────────
-- For each (regime, feature), compute average value for winners vs losers.
-- This is a simplified correlation proxy: delta = avgWin - avgLoss.

SELECT
  regime                                                    AS "regime",
  feature_name                                              AS "featureName",
  ROUND(AVG(CASE WHEN outcome = 'winner' THEN feature_val ELSE NULL END)::numeric, 4) AS "avgWinner",
  ROUND(AVG(CASE WHEN outcome = 'loser'  THEN feature_val ELSE NULL END)::numeric, 4) AS "avgLoser",
  ROUND(
    AVG(CASE WHEN outcome = 'winner' THEN feature_val ELSE NULL END)
    - AVG(CASE WHEN outcome = 'loser' THEN feature_val ELSE NULL END), 4
  )                                                         AS "delta",
  COUNT(*)                                                  AS "sampleSize"
FROM (
  SELECT
    COALESCE(
      t."entryContext"->'market'->>'regime',
      t."entryContext"->>'htfRegime',
      'unknown'
    )                                         AS regime,
    CASE WHEN t."pnlPercent" > 0 THEN 'winner' ELSE 'loser' END AS outcome,
    feat.name                                 AS feature_name,
    CASE feat.name
      WHEN 'atr'         THEN (t."entryContext"->>'atr')::numeric
      WHEN 'adx'         THEN (t."entryContext"->>'adx')::numeric
      WHEN 'rsi'         THEN (t."entryContext"->>'rsi')::numeric
      WHEN 'volumeRatio' THEN (t."entryContext"->>'volumeRatio')::numeric
      WHEN 'bbWidth'     THEN (t."entryContext"->>'bbWidth')::numeric
      WHEN 'confidence'  THEN (t."entryContext"->>'confidenceScore')::numeric
    END                                       AS feature_val
  FROM "Trade" t
  CROSS JOIN (
    VALUES ('atr'), ('adx'), ('rsi'), ('volumeRatio'), ('bbWidth'), ('confidence')
  ) AS feat(name)
  WHERE
    t."status"        = 'CLOSED'
    AND t."entryContext" IS NOT NULL
    AND ($1::text IS NULL OR COALESCE(t."entryContext"->>'strategyKey', t."firedByStrategy") = $1)
    AND ($2::text IS NULL OR t."symbol" = $2)
    AND ($4::int  IS NULL OR t."exitedAt" >= NOW() - ($4 || ' days')::interval)
) sub
WHERE feature_val IS NOT NULL
  AND ($3::text IS NULL OR regime = $3)
GROUP BY regime, feature_name
HAVING COUNT(*) >= 5
ORDER BY ABS(
  AVG(CASE WHEN outcome = 'winner' THEN feature_val ELSE NULL END)
  - AVG(CASE WHEN outcome = 'loser' THEN feature_val ELSE NULL END)
) DESC NULLS LAST;


-- ── Query 4: Strategy Performance in a Specific Regime ───────────────────────

SELECT
  COALESCE(t."entryContext"->>'strategyKey', t."firedByStrategy", 'UNKNOWN') AS "strategyKey",
  t."symbol",
  COUNT(*)                                                    AS "tradeCount",
  ROUND(100.0 * SUM(CASE WHEN t."pnlPercent" > 0 THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0), 2) AS "winRatePct",
  ROUND(SUM(CASE WHEN t."pnlPercent" > 0 THEN t."pnlPercent" ELSE 0 END)::numeric /
    NULLIF(ABS(SUM(CASE WHEN t."pnlPercent" < 0 THEN t."pnlPercent" ELSE 0 END)), 0), 4) AS "profitFactor",
  ROUND(AVG(t."pnlPercent")::numeric, 4)                      AS "avgPnlPct"
FROM "Trade" t
WHERE
  t."status"        = 'CLOSED'
  AND t."entryContext" IS NOT NULL
  AND ($1::text IS NULL OR COALESCE(t."entryContext"->>'strategyKey', t."firedByStrategy") = $1)
  AND ($2::text IS NULL OR t."symbol" = $2)
  AND ($3::text IS NULL OR COALESCE(
    t."entryContext"->'market'->>'regime',
    t."entryContext"->>'htfRegime'
  ) = $3)
  AND ($4::int  IS NULL OR t."exitedAt" >= NOW() - ($4 || ' days')::interval)
GROUP BY "strategyKey", t."symbol"
ORDER BY "winRatePct" DESC NULLS LAST;
