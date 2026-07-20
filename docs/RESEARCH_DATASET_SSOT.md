# Research Dataset SSOT (Sprint 16)

Single Source of Truth for trade-level research/training data — foundation for graded scoring calibration and root-cause analysis.

## Schema

**Prisma model:** `TradeResearchDataset` (`prisma/schema.prisma`)  
**Field SSOT:** `src/models/researchDatasetSchema.js`

### Core identity

| Field | Description |
|-------|-------------|
| `tradeId` | Unique key (`{migrationBatch}:{rawId}`) |
| `backtestId` | Session / window identifier |
| `symbol`, `side`, `strategyKey`, `component`, `tradeType` | Trade attribution |

### Execution

| Field | Description |
|-------|-------------|
| `entryPrice`, `exitPrice`, `entryTime`, `exitTime` | Fill geometry |
| `pnlGross`, `pnlNet`, `fee`, `result`, `exitReason` | Outcome |
| `holdDurationMinutes`, `holdDays` | Duration |

### Market context

| Field | Description |
|-------|-------------|
| `sessionName`, `dailyRegime`, `htfTrend` | Regime/session |
| `atr`, `atrPercent`, `volatilityBucket` | Volatility |

### Feature scores (0–100)

Stored in `featureScores` JSON. SMC keys:

- `sweepScore`, `chochScore`, `fvgScore`, `obScore`, `htfAlignScore`, `mitigationScore`, `totalSmcScore`

Graded total in `gradedScore` with explainable `gradedScoreBreakdown` (ComponentScoringEngine rubric keys).

### Outcome analytics

| Field | Description |
|-------|-------------|
| `mfe`, `mae`, `mfePercent`, `maePercent` | Excursion — **measured** from backtest intra-bar tracking (Sprint 19); estimated only when CSV lacks MFE/MAE columns |
| `realizedRr` | Realized risk/reward |
| `entryReasons`, `exitReasons` | JSON arrays |

### Metadata

| Field | Description |
|-------|-------------|
| `dataQualityFlags` | `null_features`, `partial_data`, `estimated_mfe_mae`, `inferred_scores` |
| `sourceFile`, `migrationBatch` | Provenance |

## Architecture

```
XLSX/CSV exports ──► ResearchDatasetMapper ──► TradeResearchDataset (Postgres)
                              │
                              ▼
                   ComponentScoringEngine (gradedScore)
                              │
                              ▼
              ResearchDatasetValidator (IC + monotonicity)
                              │
                              ▼
         GET /api/v1/internal/research-dataset/* (Graded Scoring EPIC)
```

## Migration (5yr SMC — 1418 trades)

Six Desktop XLSX windows (Oct 2021 → Jul 2026):

```bash
node scripts/migrate-research-dataset.js          # migrate + validate
node scripts/migrate-research-dataset.js --dry-run
node scripts/migrate-research-dataset.js --files=/path/a.xlsx,/path/b.csv
node scripts/migrate-research-dataset.js --validate   # report only
```

Default paths (macOS Desktop):

1. `22-10-2021 - 30-08-2022.xlsx` (450)
2. `29-08-2022 - 06-07-2023.xlsx` (207)
3. `06-07-2023 - 11-05-2024.xlsx` (185)
4. `11-05-2024 - 17-03-2025.xlsx` (274)
5. `17-03-2025 - 21-01-2026.xlsx` (147)
6. `21-01-2026 - 17-07-2026.xlsx` (155)

**Total: 1418 trades**

When ML numerics are absent (XLSX review export), scores are inferred from entry-reason text + `Confidence` via ComponentScoringEngine heuristics — flagged `inferred_scores`.

## API

Mounted at `/api/v1/internal/research-dataset` (auth required):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/summary` | Counts + avg graded score |
| GET | `/quality` | Completeness report (≥95% target) |
| GET | `/validation` | IC + tier monotonicity report |
| GET | `/trades` | Filtered query |
| GET | `/trades/by-tier/:tier` | `low` / `mid` / `high` tier slice |
| POST | `/migrate` | SUPER_ADMIN seed from files |

## Predictive validation

Groups trades by score tier (0–33, 33–66, 66–100) and reports:

- Win rate, expectancy, avg MFE/MAE per tier
- Monotonicity check (high tier → better outcomes)
- Pearson IC (information coefficient) score → outcome
- Per SMC sub-score IC when available

## Tests

```bash
node test/research-dataset.test.js
```

## Related

- Graded scoring: `src/core/strategy-engine/scoring/ComponentScoringEngine.js`
- CSV enrichment: `src/shared/csv/strategyMlEnrichment.js`
- ML readiness: `docs/ML_READINESS.md`
