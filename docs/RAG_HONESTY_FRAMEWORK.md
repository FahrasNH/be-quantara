# RAG Honesty Framework — Quantara Internal Document

**Classification: INTERNAL USE ONLY**
**Version: Sprint 6**
**Last Updated: July 2026**

---

## 1. Overview

This document explains why RAG-augmented backtests show approximately **+3% win-rate improvement** over baseline, while live/advisory deployment realistically yields only **+1–2%**. Understanding this gap is critical for responsible deployment of ML and RAG components.

---

## 2. Why Backtest Shows +3% But Live Delivers +1–2%

### 2.1 The Gap Is Expected, Not a Bug

The 20–30% optimism bias between backtest and live performance is a well-known phenomenon in quantitative trading. It does **not** indicate that the RAG system is broken; it reflects the inherent limitations of simulated environments.

| Metric | Backtest (Simulated) | Live (Advisory) |
|--------|---------------------|-----------------|
| Win Rate improvement | ~+3% | ~+1–2% |
| Optimism bias | — | 20–30% of backtest gain |

### 2.2 Conservative Discount Factor

All positive RAG-based signals are discounted by **-10%** in backtest simulations:

```
adjustedScore = positiveScore * 0.9   (for positiveScore > 0)
adjustedScore = positiveScore          (for negativeScore ≤ 0, no change)
```

This discount already compensates for part of the gap, but further conservatism is expected in live conditions due to the factors described below.

---

## 3. Data Leakage: Types and Mitigations

### 3.1 Look-Ahead Bias

**Definition**: Using future information at a point in time when that information would not have been available.

**How it can occur in RAG**:
- Querying the vector store for "similar trades" without filtering by date
- Using embeddings that include the *outcome* of trades that happen after the query timestamp
- Feature normalization computed on the full dataset (including future data)

**Mitigation in ConservativeBacktestEngine**:
- pgvector queries are filtered: `WHERE trade_date < current_simulation_date`
- Only trades strictly before the simulation timestamp are used as context
- This is enforced at the DB query level, not application logic

### 3.2 Survivor Bias

**Definition**: Analyzing only trades that "survived" (e.g., assets still trading, strategies that happened to work).

**How it can occur**:
- Historical trade data may over-represent successful strategies
- Symbols that got delisted or experienced extreme volatility may be absent
- Strategies that were manually stopped due to poor performance don't appear in the dataset

**Mitigation**:
- Walk-forward testing over 4 time windows forces the model to face different market conditions
- Out-of-sample testing windows ensure the model sees genuinely unseen data

### 3.3 Overfitting / In-Sample Bias

**Definition**: The model learns patterns specific to the training period that don't generalize.

**How it can occur**:
- WinPredictor trained on same data used for backtest evaluation
- RAG embeddings tuned toward historical winning setups
- Parameter optimization on the full dataset before splitting train/test

**Mitigation**:
- Walk-Forward Backtest enforces temporal train/test splits (90d train → 30d test)
- Ablation testing validates that RAG adds genuine synergy (not noise fitting)
- Shadow mode (1000+ trades) provides true out-of-sample validation before advisory use

### 3.4 Execution Bias

**Definition**: Backtests assume perfect execution (fill at signal price), while live trading has slippage, latency, and partial fills.

**Mitigation**: Conservative discount (-10%) partially compensates, but users should expect 5–15 bps of execution friction in live conditions.

---

## 4. Validation Hierarchy

```
Phase 1: Conservative Backtest (Staging)
    └─ ConservativeBacktestEngine — time-aware RAG, -10% discount
    └─ Walk-Forward (4 windows: 90d train → 30d test)
    └─ Ablation (Baseline / LGB / RAG / LGB+RAG)
    └─ BiasQuantification report

Phase 2: Shadow Mode (3–4 months, 1000+ trades)
    └─ MLShadowService — logs predictions alongside real trades
    └─ No execution — fire-and-forget logging
    └─ Success criteria: AUC ≥ 0.65, Accuracy ≥ 50%, Precision ≥ 55%

Phase 3: Advisory Mode (human-in-the-loop)
    └─ Shows recommendations to operator, requires manual approval
    └─ REVERT immediately if performance drops

Phase 4: Active Mode (future — not deployed)
    └─ Direct influence on trade selection
    └─ Requires 6+ months of advisory validation
```

Each phase gate is **mandatory** — skipping phases is not allowed.

---

## 5. Conservative Discount: Rationale

The **-10% discount** applied to positive RAG signals is derived from:

1. **Historical overfitting premium**: ~5% of backtest gains typically don't survive out-of-sample
2. **Execution friction**: ~3% for slippage and partial fill assumptions
3. **Model drift buffer**: ~2% reserve for model degradation between retraining cycles

Formula:
```
conservative_adjusted = backtest_improvement * 0.9
expected_live = conservative_adjusted * (1 - further_friction_factor)
```

In practice: if RAG shows +3.0% backtest improvement → conservative backtest shows ~+2.7% → live expected ~+1–2%.

---

## 6. Bias Quantification

The optimism bias is calculated as:

```
optimismBias = (backtestWR - liveWR) / liveWR * 100%
```

Example:
- Backtest WR: 55%
- Live WR: 52%
- Optimism bias: (55 - 52) / 52 = ~5.8%

**Target tolerance**: Optimism bias ≤ 30% is acceptable for advisory deployment.
Bias > 30% triggers a review and potential model retraining.

---

## 7. Disclosure Statement Template

The following template is automatically generated by `BiasQuantificationReport.generateDisclosure()`:

```
QUANTARA RAG ADVISORY DISCLOSURE
==================================
This recommendation is generated by a machine learning model (LGB + RAG)
trained on historical trade data.

IMPORTANT LIMITATIONS:
• Backtest win-rate improvement: ~+X.X% (conservative estimate)
• Expected live improvement: ~+Y.Y% (after execution friction)
• Model optimism bias: ~Z.Z%
• Training period: [START] to [END] (N trades)
• Validation: Walk-forward tested over 4 time windows

THIS IS AN ADVISORY SIGNAL ONLY.
• The model may be wrong — no prediction is guaranteed
• Past performance does not guarantee future results
• All trades require human approval before execution
• The model operates in advisory mode: it suggests, humans decide

For questions about this model, contact the Quantara development team.
Internal use only — do not share with end users without prior review.
```

---

## 8. Staging-Only Enforcement

All RAG backtest engines (`ConservativeBacktestEngine`, `WalkForwardBacktest`, `AblationTest`) enforce:

```javascript
if (process.env.NODE_ENV === 'production') {
  throw new Error('[STAGING_ONLY] This engine must not run in production');
}
```

This prevents accidental execution of backtest simulations in the production environment, which could:
1. Consume significant DB resources on pgvector queries
2. Generate misleading signals if production data is used for simulation
3. Interfere with live trading infrastructure

---

## 9. Promotion Readiness Criteria

Before promoting from shadow to advisory mode:

| Criterion | Minimum Threshold |
|-----------|------------------|
| Trade count | ≥ 1000 (3–4 months) |
| AUC (ROC) | ≥ 0.65 |
| Accuracy | ≥ 50% |
| Precision (on "win" predictions) | ≥ 55% |

If any criterion fails: **do not promote**. If performance degrades after promotion: **revert immediately**.

---

*Document maintained by Quantara Engineering. Classified INTERNAL USE ONLY.*
*Do not distribute without explicit approval from the system owner.*
