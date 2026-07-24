# SMC Scalping Walk-Forward Export

Fresh SMC 5m Scalping backtest exports with current config:

- Asia session block (Sydney/Tokyo)
- ATR% floor 0.287 (dual-gate atop relative)
- Planned RR 2.0 (SL 1.5×ATR / TP 3.0×ATR)
- `maxHoldHours = 2` (120m TIME_STOP)

## Walk-forward windows (8)

| # | Window | Format |
|---|--------|--------|
| 1 | 2020-01-04 → 2020-04-04 | CSV |
| 2 | 2020-04-03 → 2021-02-08 | CSV |
| 3 | 2021-02-06 → 2021-12-14 | CSV |
| 4 | 2022-10-13 → 2023-08-18 | CSV |
| 5 | 2023-08-18 → 2024-05-22 | CSV |
| 6 | 2024-05-20 → 2025-03-26 | CSV |
| 7 | 2025-03-26 → 2026-01-28 | CSV |
| 8 | 2026-01-28 → 2026-07-06 | XLSX |

**Coverage gap**: 2021-12 → 2022-10 (bear crash) intentionally excluded.

## Automation

```bash
# Prerequisites in be-bot-trading/.env:
# DATASET_EXPAND_API_URL=https://dev.quantara.software
# DATASET_EXPAND_EMAIL=...
# DATASET_EXPAND_PASSWORD=...

# Dry-run (manifests only, no API calls)
node scripts/walkforward/smart-money-concepts/scalping.js --dry-run

# Run all 8 windows (requires dev server + credentials)
node scripts/walkforward/smart-money-concepts/scalping.js

# Single window
node scripts/walkforward/smart-money-concepts/scalping.js --window 3
```

Output: `tmp/sprint18-smc-walkforward/window-NN/` (trades.csv, stats.json, manifest.json)

Each window uses `scripts/dataset-expand/smart-money-concepts/scalping.js --via-api`
(1:1 with UI Advance backtest engine on dev server).

## Full ML column export

After each backtest completes and is saved to archive (`explicit_save=true`):

```http
POST /api/v1/backtest/export-csv
{
  "ids": [<backtest_id>],
  "variant": "full",
  "format": "csv"
}
```

Window 8 uses `"format": "xlsx"` for multi-sheet Full Export.

Full variant = 31 base columns + ML union (SL/TP/Size/Funding/PnL%/Planned R:R/Actual R:R
+ Sweep/FVG/OB/Displacement/Conf features + gradedScore).

See `docs/MULTI_SHEET_TRADE_EXPORT.md` and `docs/RESEARCH_DATASET_SSOT.md`.

## Uses

1. Time Stop adequacy analysis (is 2h too fast?)
2. Re-derive dollar Net / PF under risk-ladder v4.0
3. Graded-score calibration input (feature → outcome regression)

## Operational note

Backtests run on **dev server** (`dev.quantara.software`), not locally. Local laptop
typically cannot reach exchange APIs or Postgres — use `--via-api` path documented in
`scripts/dataset-expand/README.md`.
