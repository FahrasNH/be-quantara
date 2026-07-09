# Feature Store v1 — RFC & Schema Design

> Sprint 1 · FS-1 · Quantara Bot Trading  
> Status: **Approved**

---

## Overview

The Feature Store captures the full market state at the moment of every trade entry and exit. This enables:

- Regime-aware analytics (which strategies win in trending vs ranging markets)
- ML feature engineering for future signal optimisation
- Post-trade attribution (why did this trade win/lose?)
- Comparative performance by `pairTier`, `strategyKey`, `htfRegime`

Data is stored as JSONB in two new columns on the `Trade` model:
- `entryContext` — market state captured **before** position opens
- `exitContext` — market state captured **at** position close

---

## Feature Schema v1 — entryContext (20 fields)

### JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "EntryContext",
  "type": "object",
  "required": [
    "capturedAt", "htfRegime", "atr", "atrPct",
    "ema9", "ema21", "ema50", "adx", "rsi",
    "bbWidth", "volume24h", "volumeRatio", "spread",
    "strategyKey", "tradeType", "confidenceScore",
    "signalComponents", "pairTier", "leverage", "capitalAllocated"
  ],
  "properties": {
    "capturedAt":        { "type": "string", "format": "date-time", "description": "ISO timestamp when feature was captured" },
    "htfRegime":         { "type": "string", "enum": ["trending_up","trending_down","ranging","volatile"], "description": "HTF market regime at entry" },
    "atr":               { "type": "number", "description": "ATR value at entry candle" },
    "atrPct":            { "type": "number", "description": "ATR as % of current price" },
    "ema9":              { "type": "number", "description": "EMA-9 on HTF at entry" },
    "ema21":             { "type": "number", "description": "EMA-21 on HTF at entry" },
    "ema50":             { "type": "number", "description": "EMA-50 on HTF at entry" },
    "adx":               { "type": ["number","null"], "description": "ADX value — null if not available" },
    "rsi":               { "type": "number", "description": "RSI on entry timeframe at entry" },
    "bbWidth":           { "type": "number", "description": "Bollinger Band Width % = (upper-lower)/middle*100" },
    "volume24h":         { "type": "number", "description": "24h rolling volume in quote currency" },
    "volumeRatio":       { "type": "number", "description": "Current bar volume / rolling average volume" },
    "spread":            { "type": "number", "description": "Bid-ask spread as % of mid-price" },
    "fundingRate":       { "type": ["number","null"], "description": "Perpetual funding rate (null for spot)" },
    "strategyKey":       { "type": "string", "description": "Strategy identifier e.g. AF_SAC, TREND_FOLLOWING" },
    "tradeType":         { "type": "string", "description": "Logical trade type: Scalping | Intraday | Swing" },
    "confidenceScore":   { "type": "number", "minimum": 0, "maximum": 100, "description": "Composite confidence 0-100" },
    "signalComponents":  { "type": "object", "description": "Raw per-component signal details" },
    "pairTier":          { "type": "string", "enum": ["LIQUID","STABLE","VOLATILE"], "description": "Pair liquidity tier" },
    "leverage":          { "type": "number", "description": "Leverage applied at entry" },
    "capitalAllocated":  { "type": "number", "description": "Capital allocated to this trade in USDT" }
  }
}
```

### Example Payload

```json
{
  "capturedAt": "2026-07-09T08:30:00.000Z",
  "htfRegime": "trending_up",
  "atr": 142.5,
  "atrPct": 0.22,
  "ema9": 64850.3,
  "ema21": 64200.1,
  "ema50": 63100.7,
  "adx": 28.4,
  "rsi": 58.3,
  "bbWidth": 3.1,
  "volume24h": 1850000000,
  "volumeRatio": 1.45,
  "spread": 0.003,
  "fundingRate": 0.0001,
  "strategyKey": "AF_SAC",
  "tradeType": "Intraday",
  "confidenceScore": 72,
  "signalComponents": {
    "trendScore": 0.8,
    "momentumScore": 0.65,
    "volumeConfirm": true,
    "htfAligned": true,
    "structureBreak": false
  },
  "pairTier": "LIQUID",
  "leverage": 10,
  "capitalAllocated": 50.0
}
```

---

## Feature Schema v1 — exitContext (10 fields)

### JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ExitContext",
  "type": "object",
  "required": [
    "capturedAt", "exitReason", "exitPrice", "holdingDurationMs",
    "pnlPct", "pnlUsd", "htfRegimeAtExit", "atrAtExit",
    "maxAdverseExcursion", "maxFavorableExcursion"
  ],
  "properties": {
    "capturedAt":            { "type": "string", "format": "date-time" },
    "exitReason":            { "type": "string", "enum": ["tp_hit","sl_hit","emergency","manual","timeout"] },
    "exitPrice":             { "type": "number" },
    "holdingDurationMs":     { "type": "number", "description": "Duration in milliseconds" },
    "pnlPct":                { "type": "number", "description": "P&L as % of entry notional" },
    "pnlUsd":                { "type": "number", "description": "Net P&L in USDT" },
    "htfRegimeAtExit":       { "type": "string", "enum": ["trending_up","trending_down","ranging","volatile","unknown"] },
    "atrAtExit":             { "type": "number" },
    "maxAdverseExcursion":   { "type": "number", "description": "Max price move against position (MAE) as % from entry" },
    "maxFavorableExcursion": { "type": "number", "description": "Max price move in favor of position (MFE) as % from entry" }
  }
}
```

### Example Payload

```json
{
  "capturedAt": "2026-07-09T10:45:00.000Z",
  "exitReason": "tp_hit",
  "exitPrice": 65420.0,
  "holdingDurationMs": 8100000,
  "pnlPct": 0.87,
  "pnlUsd": 43.5,
  "htfRegimeAtExit": "trending_up",
  "atrAtExit": 155.0,
  "maxAdverseExcursion": -0.12,
  "maxFavorableExcursion": 1.02
}
```

---

## Prisma Field Mapping Notes

The two new columns are added to the **Prisma `Trade` model** (PostgreSQL, managed via `prisma/schema.prisma`).

| Field | Prisma Type | DB Column | DB Type |
|-------|-------------|-----------|---------|
| `entryContext` | `Json?` | `entryContext` | `JSONB` |
| `exitContext`  | `Json?` | `exitContext`  | `JSONB` |

### Why JSONB?

- JSONB supports GIN indexing for fast queries on nested keys (e.g., `WHERE "entryContext"->>'htfRegime' = 'trending_up'`)
- Schema-flexible: new features can be added without migrations
- Prisma `Json` type maps directly to PostgreSQL `JSONB`

### Query Examples

```sql
-- All LONG trades in trending_up regime
SELECT id, entry, "entryContext"->>'confidenceScore' AS confidence
FROM "Trade"
WHERE "entryContext"->>'htfRegime' = 'trending_up'
  AND side = 'LONG';

-- Aggregate win rate by regime
SELECT "entryContext"->>'htfRegime' AS regime,
       COUNT(*) FILTER (WHERE pnl > 0) * 100.0 / COUNT(*) AS win_rate
FROM "Trade"
WHERE "entryContext" IS NOT NULL
GROUP BY regime;
```

### GIN Index (recommended — add separately)

```sql
CREATE INDEX IF NOT EXISTS "Trade_entryContext_gin"
  ON "Trade" USING GIN ("entryContext" jsonb_path_ops);
```

---

## Backfill Strategy

Trades created before Sprint 1 will have `entryContext = NULL`. The backfill script (`scripts/backfill-trade-features.js`) reconstructs a partial entryContext from historical candle data (ATR, EMA, volume). Backfilled records are tagged with `"backfilled": true` so they can be filtered in analytics.

Target coverage: **≥80%** of historical trades.

---

## StrategyPerformance Aggregation

Daily aggregations of trade outcomes grouped by `(strategyKey, symbol, regime, tradeType, pairTier)` are stored in the `StrategyPerformance` table. This enables:

- Regime fitness scoring per strategy
- Daily performance dashboards
- Top-performer ranking for multi-strategy portfolio rebalancing

See `src/server/services/StrategyPerformanceService.js` for the aggregation logic.
