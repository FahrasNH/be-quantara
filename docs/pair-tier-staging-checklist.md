# PAIR-TIER Staging Validation Checklist
## PAIR-TIER-12 — 10 live trades WLD + 10 HYPE criteria

**Date started:** ___________  
**Tester:** ___________  
**Environment:** staging.quantara.software  
**Branch:** staging  

---

## Prerequisites (complete before starting)

- [ ] PAIR-TIER-01..10 merged to `staging`
- [ ] BE + FE deployed on VPS staging
- [ ] Dry-run mode enabled (no real funds at risk)
- [ ] At least one exchange API key connected (Bitget / OKX)
- [ ] `ALLOWED_TIERS=FOUNDRY,FORGE,MINT,VAULT` in staging `.env`

---

## Part 1 — WLD (WLDUSDT) Validation  
Target: 10 dry-run trades completed, ≥ 45% win rate

| # | Entry Direction | Entry Price | SL | TP | Result | W/L | Notes |
|---|-----------------|-------------|----|----|--------|-----|-------|
| 1 |  |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |  |
| 4 |  |  |  |  |  |  |  |
| 5 |  |  |  |  |  |  |  |
| 6 |  |  |  |  |  |  |  |
| 7 |  |  |  |  |  |  |  |
| 8 |  |  |  |  |  |  |  |
| 9 |  |  |  |  |  |  |  |
| 10 |  |  |  |  |  |  |  |

**WLD Win Rate:** ___ / 10 = ____%  
**Target:** ≥ 45%  
**Pass/Fail:** ___

### WLD Tier Param Verification
- [ ] Bot start response includes `appliedTierAdjustments.pairTier = "VOLATILE"`
- [ ] `slMultiplier = 1.5` shown in bot start response
- [ ] `positionSizeAdjustment = 0.6` shown
- [ ] `dailyLossLimit = 0.03` shown
- [ ] `regimeFilterRequired = true` shown
- [ ] `strategyWarning` present in response (mentions VOLATILE)
- [ ] Non-MR strategies (AF/TM/BR) are blocked (API returns 400 if attempted)
- [ ] PAIR-TIER-08 badges visible in Add Bot panel: MR = ✓ green, AF/TM/BR = ✕ red
- [ ] PAIR-TIER-09 adjustment strip visible in Add Bot panel showing VOLATILE params

---

## Part 2 — HYPE (HYPEUSDT) Validation  
Target: 10 dry-run trades completed, ≥ 35% win rate  
(Lower target: HYPE has thinner order book and higher slippage)

| # | Entry Direction | Entry Price | SL | TP | Result | W/L | Notes |
|---|-----------------|-------------|----|----|--------|-----|-------|
| 1 |  |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |  |
| 4 |  |  |  |  |  |  |  |
| 5 |  |  |  |  |  |  |  |
| 6 |  |  |  |  |  |  |  |
| 7 |  |  |  |  |  |  |  |
| 8 |  |  |  |  |  |  |  |
| 9 |  |  |  |  |  |  |  |
| 10 |  |  |  |  |  |  |  |

**HYPE Win Rate:** ___ / 10 = ____%  
**Target:** ≥ 35%  
**Pass/Fail:** ___

### HYPE Tier Param Verification (same as WLD checklist above)
- [ ] `pairTier = "VOLATILE"` in bot start response
- [ ] All tier params applied (SL 1.5×, position 60%, dailyLoss 3%, regime required)

---

## Part 3 — SOL (SOLUSDT) Baseline Regression  
Verify SOL performance is NOT degraded by pair-tier changes

| # | Win Rate Before | Win Rate After | Delta | Notes |
|---|-----------------|----------------|-------|-------|
| Dry-run 10 trades |  |  |  |  |

**SOL Baseline:**  
- [ ] SOL classified as LIQUID (pairTier = "LIQUID")
- [ ] `slMultiplier = 1.0` (unchanged from pre-pair-tier)
- [ ] `positionSizeAdjustment = 1.0` (no reduction)
- [ ] Win rate ≥ 80% maintained (or within ±5% of pre-pair-tier baseline)

---

## Part 4 — Strategy Selector UI (PAIR-TIER-08)

| Check | Pass/Fail |
|-------|-----------|
| Select WLDUSDT → tier badge shows "VOLATILE · High Risk" | |
| Select WLDUSDT → MR badge is ✓ green | |
| Select WLDUSDT → AF badge is ✕ red | |
| Select WLDUSDT → TM badge is ✕ red | |
| Select BTCUSDT → tier badge shows "LIQUID · Low Risk" | |
| Select BTCUSDT → AF/TM/MR all ✓ green | |
| Select AVAXUSDT → tier badge shows "STABLE · Medium Risk" | |
| Select AVAXUSDT → AF/MR ✓ green, TM/BR ⚠ yellow | |

---

## Part 5 — Bot Start Dialog Adjustment Preview (PAIR-TIER-09)

| Check | Pass/Fail |
|-------|-----------|
| Select WLDUSDT → adjustment strip appears | |
| Strip shows "VOLATILE Pair Adjustments" header | |
| SL Multiplier = 1.5× | |
| Position Size = 60% | |
| Max Trades/Day = 5 | |
| Daily Loss Cap = 3% | |
| Regime Filter = Required | |
| Select BTCUSDT → NO adjustment strip (LIQUID = no override strip) | |

---

## Part 6 — Settings Pair Routing (PAIR-TIER-10)

| Check | Pass/Fail |
|-------|-----------|
| "Pair Routing" nav item visible in Settings | |
| Section loads showing LIQUID/STABLE/VOLATILE distribution | |
| After classifying WLDUSDT and BTCUSDT: counts increment correctly | |
| "Clear classification cache" button clears cache | |
| After clear: counts show 0/0/0 | |
| After re-selecting symbol: cache repopulates | |
| Classification rules table shows correct strategy info per tier | |

---

## Part 7 — Slippage vs Backtest  
Compare live dry-run slippage to backtest assumptions

| Pair | Backtest Avg SL Distance | Live Avg SL Distance | Slippage Delta | Accept? |
|------|-------------------------|----------------------|----------------|---------|
| WLDUSDT |  |  |  | |
| HYPEUSDT |  |  |  | |

Acceptance criterion: slippage delta < 15% of backtest SL distance.

---

## Part 8 — Regression Check (existing pairs unaffected)

| Check | Pass/Fail |
|-------|-----------|
| BTCUSDT bot starts normally, no blocking | |
| ETHUSDT bot starts normally | |
| Existing running bots (pre-pair-tier) continue without disruption | |
| Admin dashboard shows no new errors | |
| `npm test` passes all 29+ tests | |

---

## Sign-off

| Role | Name | Signed | Date |
|------|------|--------|------|
| QA   |      |        |      |
| Dev  |      |        |      |

**Overall Result:** PASS / FAIL  
**Notes:**
