# 📚 Dokumentasi Quantara Backend

Indeks dokumentasi operasional & teknis (Priority 5).

| Dokumen | Isi |
|---------|-----|
| [STRATEGIES.md](STRATEGIES.md) | Logika, parameter, & edge case tiap strategi (TM/MR/BR/AF) |
| [API.md](API.md) | Semua endpoint REST + checklist QA (termasuk regresi IDOR) |
| [MONITORING.md](MONITORING.md) | Threshold risk per-bot & akun, yang dipantau, sinyal alert |
| [EMERGENCY.md](EMERGENCY.md) | Prosedur darurat: naked position, stop-all, key bocor, rollback |

Lihat juga (di root repo): `RUNBOOK_GO_LIVE.md`, `.env.staging.example`, `deploy-staging.sh`.

> ⚠️ **Status validasi:** Backtest strategi masih memakai data **sintetis** (ber-seed,
> reproducible). Validasi dengan OHLCV nyata Bitget **wajib** sebelum live trading.
