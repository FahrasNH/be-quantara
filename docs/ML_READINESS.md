# ML Data Readiness (Sprint 16)

Phase 1 + Phase 2 implementation for live trade enrichment, win-probability gating, and feedback-loop aggregation.

## Phase 1 — Schema + Live Hooks

| Task | Location |
|------|----------|
| Trade fields (`winningComponent`, `signalDelayMs`, `pairTier`) | `prisma/schema.prisma`, engine `trades` table |
| Entry enrichment (session, HOD/LOD, HTF, liquidation snapshot) | `BotEngine.js` → `_buildMlEntryPayload()` |
| Exit enrichment (slippage, funding, regime, exit reason) | `BotEngine.js` close path |
| 30d backfill | `scripts/backfill-ml-readiness.js` |

```bash
node scripts/backfill-ml-readiness.js --days=30          # apply
node scripts/backfill-ml-readiness.js --days=30 --dry-run
```

## Phase 2 — Feedback Loop

| Task | Location |
|------|----------|
| ML win gate (shadow/active/disabled) | `src/modules/ml/services/MLGateService.js` → wired in `BotEngine` pre-entry (inherited by `AdaptiveStrategyEngine`) |
| Daily StrategyPerformance aggregation | `StrategyPerformanceAggregation.js` @ 02:00 UTC via `performanceAggregationCron` |
| Feature importance (SHAP approximation) | `FeatureImportanceAnalyzer.js` — runs on server boot, then hourly |

### Environment

See `.env.example`:

- `ML_GATE_MODE` — `shadow` (default) \| `active` \| `disabled`
- `ML_WIN_GATE_THRESHOLD` — default `0.45`
- `ML_COLD_START_TRADES` — default `200` (regime confidence gates below this)

### API

Mounted at `/api/v1/internal/meta-selector` (auth required):

- `GET /feature-importance` — cached top-5 signal ranking
- `POST /feature-importance/analyze` — on-demand analysis (SUPER_ADMIN)

### Cron

Started from `src/server/app.js` on listen:

- Daily aggregation @ 02:00 UTC
- Feature importance on boot + every hour

### Tests

```bash
node test/ml-readiness.test.js
node test/ml-readiness-phase2.test.js
npm test -- --grep ml-readiness
```

## Related

- Research Dataset SSOT: `docs/RESEARCH_DATASET_SSOT.md`
- **Full Export** (backtest CSV `variant=full`) is the primary flat research dataset path (core + geometry + ML union)
- Graded scoring calibration consumes SSOT via `/api/v1/internal/research-dataset`

## Deferred (Sprint 18+)

- Train win-prediction model on enriched dataset
- Regime-aware parameter tuning from StrategyPerformance rollups
