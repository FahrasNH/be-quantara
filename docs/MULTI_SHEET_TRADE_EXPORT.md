# Multi-sheet trade export (Dynamic ML)

Sprint 15 export format for backtest trades. Avoids the flat CSV problem where every row carried 20–30 unused strategy columns as `N/A`.

## Sheet layout

| Sheet | Contents |
|-------|----------|
| **User Export** | CORE columns only (ID, Symbol, Side, Strategy, Component, prices, PnL, Entry Reasons, …). All trades. |
| **ML\_\<STRATEGY\>** | One sheet per selected strategy that has ≥1 trade. Join keys + that strategy’s ML fields. |

Example workbook:

```
Sheet 1  User Export   → CORE (~23 cols), all trades
Sheet 2  ML_AF_SMC     → SMC-specific fields
Sheet 3  ML_BS_ICT     → kill zone / raid / MSS
Sheet 4  ML_TS_TF      → ADX / Donchian / trend
…
```

Strategies with zero trades in the export set are **skipped** (no empty sheets).

## Join pattern

ML sheets include `id` (and `symbol`, `side`, `openTime`, `closeTime`, `pnlNet`, `result`) so you can VLOOKUP / JOIN back to **User Export**:

```text
User Export[id]  ←→  ML_BS_ICT[id]
```

Each trade appears on exactly one ML sheet (its winning component / strategy key).

## Export formats (UI)

| Format | Output | Notes |
|--------|--------|-------|
| **Core Export** | XLSX with User Export only | Compact; no ML sheets |
| **Strategy-Specific** | XLSX with User Export + selected `ML_*` sheets | Default. Unchecked sheets → auto = all strategies present in the result |
| **Full Export** | Flat CSV | Backward-compatible single sheet |

API (`POST /api/v1/backtest/export-csv`):

```json
{ "ids": [1, 2], "format": "xlsx", "strategies": ["BS_ICT", "TS_TF"], "coreOnly": false }
```

- `format: "csv"` → Full Export  
- `format: "xlsx"` + `coreOnly: true` → Core only  
- `format: "xlsx"` + `strategies: [...]` → Strategy-Specific subset  
- `format: "xlsx"` with no / empty strategies → auto from trades  

## Worked example — ICT trades only

1. Run a backtest that includes `BS_ICT` (or an umbrella that raced ICT).
2. Choose **Strategy-Specific**.
3. Uncheck all ML sheets except **ML_BS_ICT** (keep User Export).
4. Export → workbook has `User Export` + `ML_BS_ICT`.
5. In Excel/Sheets: filter User Export by Component = `BS_ICT`, or join ML_BS_ICT.id → User Export for full CORE + ICT ML columns.

## ML field sets (`ML_FIELD_SETS`)

Source of truth: `src/shared/csv/tradeExportCsv.js`.

| Key | Fields |
|-----|--------|
| AF_SMC | sweepStrength, fvgSizeAtr, obDistanceAtr, displacementPct, htfAdx, hourUtc, confSweepStrength, confFvgSize, confDisplacementPct, confHtfAlignment, confMitigationDepth, confObConfluence |
| AF_WYCKOFF | wyPatternType, wyAccumulationBars, wyFakeBreakDepthAtr, wyReclameBars, wyVolumeRatio, wySosOrSow, wyLpsLevel |
| AF_VSA | vsaPatternType, vsaSpread, vsaVolume, vsaAvgSpread, vsaAvgVolume, vsaSwingProximity, vsaReversal |
| TS_TF | tfAdxStrength, tfDonchianPeriod, tfBarsInTrend, tfVolRatio, tfHtfTrendConfirmed, tfEmaCrossover |
| TS_MS | msSwingHighPrice, msSwingLowPrice, msPullbackDepthAtr, msHhPattern, msLlPattern, msPullbackConfirmed |
| TS_VP | vpVwapLevel, vpVahLevel, vpValLevel, vpPocLevel, vpTriggerType |
| MD_MR | mrRsiValue, mrBbMidLevel, mrBbUpperLevel, mrBbLowerLevel, mrVwapLevel, mrVwapDeviation, mrAdxRegime |
| MD_SD | sdZoneType, sdZoneLevel, sdZoneSizeAtr, sdRetestDepthAtr, sdVolumeConfirmation, sdTimeToRetestBars, sdConfluence |
| MD_SA | saZScore, saMaValue, saStdDev, saUpperBand, saLowerBand, saBandTouch, saMeanRevertBars |
| BS_BR | bbSqueezeWidthAtr, breakoutVolumeRatio, retestDepthAtr, rejectionWickPct, consolidationBars, breakoutCandleAtr, fundingRateAtEntry, fundingForecast24h, holdHours, volumeRatio, bbWidth |
| BS_ICT | ictKillZoneHour, ictKillZoneLevel, ictRaidType, ictRaidDepthAtr, ictVolumeRatio, ictReversal, ictMssPct |
| BS_LS | lsOiValue, lsOiPercentile, lsBbWidth, lsBbWidthPercentile, lsLiquidationLevel, lsWickDepthAtr, lsOiForecast24h |

Legacy labels (`ICT-style trading`, `Supply and Demand`, …) normalize via `ML_STRATEGY_ALIASES` / `normalizeMlStrategyKey()`.

## Dropped stale-ML columns

`DROPPED_ML_CSV_COLUMN_KEYS` in `tradeExportCsv.js` lists forensics / stale ML numerics that are **intentionally excluded** from human-readable CORE CSV exports (they still appear on the matching `ML_*` sheet when that strategy is selected — e.g. AF_SMC / BS_BR fields). Do not re-add them to the User Export sheet.

## Implementation map

| Layer | File |
|-------|------|
| Field sets + XLSX builder | `src/shared/csv/tradeExportCsv.js` |
| Enrichment extractors | `src/shared/csv/strategyMlEnrichment.js` |
| Backtest close passthrough | `RealStrategyBacktestService.withBacktestEntryContext` |
| Archive export service | `BacktestCsvService.exportBacktestsXlsx` |
| HTTP | `POST /api/v1/backtest/export-csv`, `GET /api/v1/backtest/:id/export` |
| FE UI | `ExportFormatPanel.jsx` + `useBacktest.exportCsv` / `exportSessionResults` |
