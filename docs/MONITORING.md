# Monitoring & Scheduled Jobs

In-process schedulers (no OS crontab required for these). Started from `src/server/app.js` after DB init.

| Job | Module | Schedule (UTC) | Purpose |
|-----|--------|----------------|---------|
| Performance daily | `src/infrastructure/cron/performanceAggregationCron.js` | Every day 02:00 | `StrategyPerformanceService.aggregateDaily` |
| Performance weekly | same | Sunday 03:00 | Rolling `7d` + `30d` aggregations |
| Performance monthly | same | 1st of month 04:00 | `all-time` aggregation |
| Walk-forward | same → `WalkForwardJob` | Sunday 23:00 | Parameter walk-forward optimization |
| Backup | `BackupScheduler` | Every 24h | DB backup |
| Exchange key purge | `exchangeKeyPurge.scheduleKeyPurge` | Every 6h | Soft-deleted key cleanup |
| Pair-tier drift | `PairTierDriftMonitor` | Continuous | Observability for stale pair tiers |
| Bot watchdog | `startBotWatchdog` in `app.js` | Interval | Resume zombie bots |

Manual / CLI:

```bash
npm run jobs:walk-forward-dry
npm run jobs:walk-forward-optimize
```

Alerts: cron failures go through `TelegramNotifier`.
