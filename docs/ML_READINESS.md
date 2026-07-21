# ML Data Readiness (Sprint 16)

Phase 1 + Phase 2 implementation for live trade enrichment, win-probability gating, and feedback-loop aggregation.

## Phase 1 — Schema + Live Hooks

| Task | Location |
|------|----------|
| Trade fields (`winningComponent`, `signalDelayMs`, `pairTier`) | `prisma/schema.prisma`, engine `trades` table |
| Entry enrichment (session, HOD/LOD, HTF, liquidation snapshot) | `BotEngine.js` → `_buildMlEntryPayload()` |
| Exit enrichment (slippage, funding, regime, exit reason) | `BotEngine.js` close path |
| 30d backfill | `scripts/backfill-ml-readiness.js` |
| ML shadow log backfill | `scripts/ml/backfill-ml-shadow-log.js` |

```bash
node scripts/backfill-ml-readiness.js --days=30          # apply
node scripts/backfill-ml-readiness.js --days=30 --dry-run
node scripts/ml/backfill-ml-shadow-log.js --days=30      # trades → MLShadowLog
node scripts/ml/ml-shadow-report.js --days=30            # promotion readiness
```

### MLShadowLog vs `trades` table

| Store | Populated by | Used by |
|-------|--------------|---------|
| `trades` (engine) | BotEngine live/dry-run with `sessionId` | Admin dashboard, backfill scripts |
| `MLShadowLog` | `BotEngineMlHook` on open + close (live/dry-run only) | `ml-shadow-report.js`, promotion readiness |
| Backtest archives | `RealStrategyBacktestService` (in-memory / JSON) | Backtest UI — **not** MLShadowLog |

Backtest trades never write MLShadowLog. Historical engine trades before the ML hook was deployed also have no shadow rows until you run `backfill-ml-shadow-log.js`.

`ML_GATE_MODE` controls the pre-entry gate only (`shadow` / `active` / `disabled`); it does **not** disable shadow logging. There is no `ML_SHADOW_ENABLED` env var.

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

## Sprint 18 — ML Training Readiness

### Pre-flight validation

Run 1 week before model training:

```bash
export DATABASE_URL="postgresql://user:pass@localhost:5432/bot_trading"
chmod +x scripts/pre_sprint18_ml_validation.sh
./scripts/pre_sprint18_ml_validation.sh
```

Checks: gate mode lock, null-density report, data completeness (>70%), trade field write-through.

### Feature hygiene

`FeatureEngineer.EXCLUDED_FEATURES` strips null-dense fields before training:

- `iv30d`, `skew`, `liquidationBuffer` (100% null — no options feed)
- `liquidationLevels` (60% null)
- `correlationRisk` (heuristic only)

See `docs/ML_MODEL_CARD.md`.

### Backfill gap analysis

```bash
node scripts/ml/backfill_gap_analysis.js
node scripts/ml/backfill_gap_analysis.js --synthetic   # offline when DB unavailable
```

### Gate safety (production)

`ML_GATE_MODE=active` throws at server boot and BotEngine construction when
`NODE_ENV=production`. Default remains `shadow`.

### Category completeness (Phase 1-2 vs Phase 3)

| Category | Status | Notes |
|----------|--------|-------|
| Trade | ✅ Complete | winningComponent, signalDelayMs, pairTier |
| Execution | ✅ Usable | racer metadata, HTF alignment, signal age |
| Outcome | ✅ Complete | PnL, exit reason, slippage, funding |
| Market | ✅ Usable | session, HOD/LOD, regime; iv30d/skew TBD |
| Risk | ⏳ Sprint 20 | VaR/CVaR, real correlation, liquidation buffer |

Risk fields require Binance margin API + portfolio-level tracking — deferred to Phase 3.

**Sprint 20 placeholder**: Phase 3 Risk Category ML Data (VaR/correlation/liquidation) —
see Quantara Plan backlog; fields in `EXCLUDED_FEATURES` until external feeds land.

### SMC walk-forward dataset

See `docs/SMC_SCALPING_WALKFORWARD_EXPORT.md` — 8 windows 2020–2026 post Sprint 16 config.
