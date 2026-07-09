-- shadow-analysis.sql — Sprint 3 / MS-2
-- Analytical SQL queries for MetaSelector shadow mode evaluation.
-- Run against Postgres DB (DATABASE_URL). Substitute :start_date / :end_date
-- with ISO date strings when running via psql or node pg.

-- ─────────────────────────────────────────────────────────────────────────────
-- Q1: Hypothetical vs Actual Win Rate per Regime
-- ─────────────────────────────────────────────────────────────────────────────
-- Shows how often the bot "matched" the top MetaSelector recommendation,
-- and whether those matches had better win rates than non-matches.

SELECT
  msr.regime,
  COUNT(*)                                                            AS total_signals,
  COUNT(*) FILTER (WHERE msr."actualOutcome" IS NOT NULL
                     AND msr."actualOutcome" <> 'pending')           AS closed_trades,
  ROUND(
    100.0 * COUNT(*) FILTER (
      WHERE msr."actualOutcome" IS NOT NULL
        AND msr."actualOutcome" <> 'pending'
        AND msr."actualStrategy" = (
          SELECT elem->>'strategyKey'
          FROM jsonb_array_elements(msr.recommendations) AS elem
          WHERE (elem->>'rank')::int = 1
          LIMIT 1
        )
    ) / NULLIF(COUNT(*) FILTER (
      WHERE msr."actualOutcome" IS NOT NULL
        AND msr."actualOutcome" <> 'pending'), 0),
    2
  )                                                                   AS match_rate_pct,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE msr."actualOutcome" = 'win') /
    NULLIF(COUNT(*) FILTER (
      WHERE msr."actualOutcome" IN ('win', 'loss')), 0),
    2
  )                                                                   AS actual_win_rate_pct
FROM "MetaSelectorRecommendation" msr
WHERE msr.mode = 'shadow'
GROUP BY msr.regime
ORDER BY total_signals DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- Q2: Recommendation Accuracy
-- % of trades where actual strategy = MetaSelector rank-1 recommendation
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  COUNT(*)                                                            AS total_closed,
  COUNT(*) FILTER (
    WHERE "actualStrategy" = (
      SELECT elem->>'strategyKey'
      FROM jsonb_array_elements(recommendations) AS elem
      WHERE (elem->>'rank')::int = 1
      LIMIT 1
    )
  )                                                                   AS top1_matches,
  ROUND(
    100.0 * COUNT(*) FILTER (
      WHERE "actualStrategy" = (
        SELECT elem->>'strategyKey'
        FROM jsonb_array_elements(recommendations) AS elem
        WHERE (elem->>'rank')::int = 1
        LIMIT 1
      )
    ) / NULLIF(COUNT(*), 0),
    2
  )                                                                   AS accuracy_pct
FROM "MetaSelectorRecommendation"
WHERE mode = 'shadow'
  AND "actualOutcome" IN ('win', 'loss');


-- ─────────────────────────────────────────────────────────────────────────────
-- Q3: Sharpe Differential Over Time (Rolling 7-day windows)
-- ─────────────────────────────────────────────────────────────────────────────
-- Shows rolling 7-day win rate for matched vs non-matched recommendations
-- as a proxy for Sharpe differential.

WITH daily AS (
  SELECT
    DATE_TRUNC('day', "createdAt")                                   AS day,
    COUNT(*) FILTER (WHERE "actualOutcome" = 'win')                  AS wins,
    COUNT(*) FILTER (WHERE "actualOutcome" IN ('win', 'loss'))        AS closed,
    COUNT(*) FILTER (
      WHERE "actualOutcome" IN ('win', 'loss')
        AND "actualStrategy" = (
          SELECT elem->>'strategyKey'
          FROM jsonb_array_elements(recommendations) AS elem
          WHERE (elem->>'rank')::int = 1
          LIMIT 1
        )
    )                                                                 AS matched
  FROM "MetaSelectorRecommendation"
  WHERE mode = 'shadow'
  GROUP BY 1
)
SELECT
  day,
  closed,
  ROUND(100.0 * wins   / NULLIF(closed, 0), 2)                      AS win_rate_pct,
  ROUND(100.0 * matched / NULLIF(closed, 0), 2)                     AS match_rate_pct,
  SUM(closed) OVER (
    ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
  )                                                                   AS rolling_7d_trades
FROM daily
ORDER BY day DESC
LIMIT 90;


-- ─────────────────────────────────────────────────────────────────────────────
-- Q4: Strategy Recommendation Distribution per Regime
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  regime,
  elem->>'strategyKey'                                               AS recommended_strategy,
  COUNT(*)                                                            AS times_recommended,
  ROUND(AVG((elem->>'score')::numeric), 2)                          AS avg_score,
  ROUND(AVG((elem->>'winRate')::numeric) * 100, 2)                  AS avg_win_rate_pct,
  ROUND(AVG((elem->>'profitFactor')::numeric), 4)                   AS avg_profit_factor
FROM "MetaSelectorRecommendation",
  jsonb_array_elements(recommendations) AS elem
WHERE mode = 'shadow'
GROUP BY regime, elem->>'strategyKey'
ORDER BY regime, times_recommended DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- Q5: Miss Rate — Bot chose differently from top recommendation
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  regime,
  COUNT(*)                                                            AS total_closed,
  COUNT(*) FILTER (
    WHERE "actualStrategy" <> (
      SELECT elem->>'strategyKey'
      FROM jsonb_array_elements(recommendations) AS elem
      WHERE (elem->>'rank')::int = 1
      LIMIT 1
    )
  )                                                                   AS miss_count,
  ROUND(
    100.0 * COUNT(*) FILTER (
      WHERE "actualStrategy" <> (
        SELECT elem->>'strategyKey'
        FROM jsonb_array_elements(recommendations) AS elem
        WHERE (elem->>'rank')::int = 1
        LIMIT 1
      )
    ) / NULLIF(COUNT(*), 0),
    2
  )                                                                   AS miss_rate_pct,
  -- Win rate on misses (did the bot still win when ignoring recommendation?)
  ROUND(
    100.0 * COUNT(*) FILTER (
      WHERE "actualOutcome" = 'win'
        AND "actualStrategy" <> (
          SELECT elem->>'strategyKey'
          FROM jsonb_array_elements(recommendations) AS elem
          WHERE (elem->>'rank')::int = 1
          LIMIT 1
        )
    ) / NULLIF(COUNT(*) FILTER (
      WHERE "actualStrategy" <> (
        SELECT elem->>'strategyKey'
        FROM jsonb_array_elements(recommendations) AS elem
        WHERE (elem->>'rank')::int = 1
        LIMIT 1
      )
      AND "actualOutcome" IN ('win', 'loss')
    ), 0),
    2
  )                                                                   AS miss_win_rate_pct
FROM "MetaSelectorRecommendation"
WHERE mode = 'shadow'
  AND "actualOutcome" IN ('win', 'loss')
GROUP BY regime
ORDER BY total_closed DESC;
