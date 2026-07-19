# ML Model Card: Win Prediction v1 (Sprint 18)

Placeholder model card for Sprint 18 training. Metrics below are updated by
`scripts/ml/backfill_gap_analysis.js` and `scripts/ml/train-win-predictor.js`.

## Training Data

- **Date range**: Post-2026-07-18 enrichment rollout (HOD/session backfill cutoff)
- **Sample size**: TBD at training time (`npm run ml:train-win-predictor`)
- **Holdout**: 20% chronological split
- **Features used**: 60-dim normalized vector (excluding 5 null-dense raw fields)
- **Excluded raw fields** (`FeatureEngineer.EXCLUDED_FEATURES`):
  - `iv30d`, `skew` — no Binance options feed
  - `liquidationBuffer` — never computed live
  - `liquidationLevels` — 60% null (LiqSqz-only)
  - `correlationRisk` — static heuristic, not portfolio correlation

## Performance (TBD — run training scripts)

| Metric | Target | Actual |
|--------|--------|--------|
| Holdout accuracy | ≥ 60% | TBD |
| Precision (win) | — | TBD |
| Recall (win) | — | TBD |
| AUC-ROC | ≥ 0.60 | TBD |

Run `node scripts/ml/backfill_gap_analysis.js` before finalizing features.

## Known Limitations

### Backfill gap (HOD enrichment)

Live enrichment (HOD/session detection) started **2026-07-18**. Trades before that
date may have `hodPrice = NULL`. Expected accuracy gap ~2–3% on pre-backfill samples.

- **Action if gap < 2%**: proceed with mixed training
- **Action if gap 2–5%**: document limitation; prefer post-2026-07-18 data
- **Action if gap > 5%**: delay training (`backfill_gap_analysis.js` exits 1)

Report path: `data/models/backfill-gap-report.json`

### Null-dense features

`iv30d`, `skew`, `liquidationBuffer` excluded from training (100% null).
Deferred to **Sprint 20** (requires options/liquidation data feeds).

### Risk category (Phase 3)

VaR/CVaR, real portfolio correlation, and liquidation buffer are **not** in scope
for Sprint 18. See `docs/ML_READINESS.md` phase breakdown.

## Gate Safety

- **Production**: `ML_GATE_MODE=active` is blocked at startup until model validated
- **Default**: `ML_GATE_MODE=shadow` (log only, never block)
- **Pre-flight**: run `./scripts/pre_sprint18_ml_validation.sh` 1 week before training

## Recommendation

Do not flip gate to `active` before holdout test on data after 2026-07-25.
