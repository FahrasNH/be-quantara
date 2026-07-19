# Multi-sheet trade export (Dynamic ML)

Sprint 15+ export format for backtest trades. The UI exposes **two CSV variants**; legacy XLSX API remains for backward compatibility.

## Export variants (UI)

| Variant | Format | Columns |
|---------|--------|---------|
| **Core Export** | CSV | 24 essential columns (`ADMIN_TRADE_EXPORT_COLUMNS`) |
| **Full Export** | CSV | 24 core + 7 geometry + **union `ML_FIELD_SETS`** for strategies in the batch |

**Geometry (7):** `sl`, `tp`, `size`, `funding`, `pnlPct`, `plannedRR`, `actualRR`

Full export **does not** include deprecated flat-CSV fields removed from the research path: `sessionId`, `status`, `mode`, `dryRun`, `isPartial`, `entryRsi`, `marketCond`, `reason`.

There is **no SMC downgrade** — SMC Full / XLSX sheets include `sweepStrength`, `gradedScore`, and other ML fields when present in trade data.

## Legacy XLSX API

`POST /api/v1/backtest/export-csv` with `format=xlsx` still builds per-strategy `<SHORT>_specific` sheets using `buildFullExportColumns` (core + geometry + that strategy's ML columns). The UI no longer exposes a separate “Strategy-Specific” option.

```json
{ "ids": [1, 2], "format": "xlsx", "strategies": ["ICT_STYLE_TRADING"], "coreOnly": false }
```

- `format: "csv"` + `variant: "core"` → Core Export (24 cols)
- `format: "csv"` + `variant: "full"` → Full Export (31 base + ML union)
- `variant: "specific"` → alias of `full` (API back-compat)
- `format: "xlsx"` + `coreOnly: true` → single “User Export” sheet (24 cols)
- `format: "xlsx"` + `strategies: [...]` → subset of strategy sheets
- empty / omitted `strategies` → auto from trades

## Sheet layout (XLSX)

| Sheet | Contents |
|-------|----------|
| **User Export** | CORE only (`coreOnly: true`) |
| **\<SHORT\>_specific** | Full columns for one strategy: 24 core + 7 geometry + that strategy's ML fields |

Example: `SMC_specific`, `TF_specific`, `Wyckoff_specific`.

Strategies with zero trades in the export set are **skipped** (no empty sheets).

## ML field sets (`ML_FIELD_SETS`)

Source of truth: `src/shared/csv/tradeExportCsv.js`.

| Key | Fields (includes gradedScore* where applicable) |
|-----|--------|
| SMART_MONEY_CONCEPTS | sweepStrength, fvgSizeAtr, obDistanceAtr, displacementPct, htfAdx, confSweepStrength, … |
| WYCKOFF | wyPatternType, wyAccumulationBars, … |
| … | See `ML_FIELD_SETS` in code for all 12 strategies |

Legacy labels (`ICT-style trading`, `Supply and Demand`, `ADAPTIVE FUSION` → SMC, …) normalize via `ML_STRATEGY_ALIASES` / `normalizeMlStrategyKey()`.

## Dropped stale-ML columns (Core only)

`DROPPED_ML_CSV_COLUMN_KEYS` lists forensics numerics **excluded from Core CSV** and Trade History exports. They appear in **Full Export** and per-strategy XLSX sheets when the strategy is present in the batch.

## Implementation map

| Layer | File |
|-------|------|
| Column sets + `buildFullExportColumns` + XLSX builder | `src/shared/csv/tradeExportCsv.js` |
| Enrichment extractors | `src/shared/csv/strategyMlEnrichment.js` |
| Archive export service | `BacktestCsvService.js` |
| HTTP | `POST /api/v1/backtest/export-csv` |
| FE UI | `ExportFormatPanel.jsx` (Core / Full only) + `useBacktest.exportCsv` |

## Changelog (Sprint 16–18)

**Sprint 16+** added graded scoring fields to Full Export:

- `gradedScore` (0–100 bounded total)
- `gradedScoreBreakdown` (JSON rubric keys)
- `scoringStrategyKey`

**Backward compatibility**: Core Export (24 cols) unchanged. Full Export column count
increased — downstream consumers parsing fixed column indices must switch to header
names or use `variant: "core"` for stable 24-col output.

**Sprint 18**: null-dense ML raw fields (`iv30d`, `skew`, `liquidationBuffer`) remain
in entryContext JSON but are excluded from model training via `EXCLUDED_FEATURES`.
