# 📚 Dokumentasi Quantara Backend

Indeks dokumentasi operasional & teknis (Priority 5).

| Dokumen | Isi |
|---------|-----|
| [STRATEGIES.md](STRATEGIES.md) | Logika, parameter, & edge case tiap strategi (AF_SMC / TS_TF / MD_MR / BS_BR) |
| [STRATEGIES.html](STRATEGIES.html) | Versi HTML — tabel parameter rapi + navigasi sidebar |
| [PAIR_VOLATILITY.md](PAIR_VOLATILITY.md) | Klasifikasi volatilitas koin (LIQUID / STABLE / VOLATILE) & dampak ke bot |
| [API.md](API.md) | Semua endpoint REST + checklist QA (termasuk regresi IDOR) |
| [MONITORING.md](MONITORING.md) | Threshold risk per-bot & akun, yang dipantau, sinyal alert |
| [EMERGENCY.md](EMERGENCY.md) | Prosedur darurat: naked position, stop-all, key bocor, rollback |

Lihat juga: `RUNBOOK_GO_LIVE.md`, `.env.staging.example`, [`DEPLOY_QUICK_START.md`](../../DEPLOY_QUICK_START.md), [`fe-bot-trading/deploy-staging.sh`](../../fe-bot-trading/deploy-staging.sh).

> ⚠️ **Status validasi:** Backtest strategi masih memakai data **sintetis** (ber-seed,
> reproducible). Validasi dengan OHLCV nyata Bitget **wajib** sebelum live trading.
