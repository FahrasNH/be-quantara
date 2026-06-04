# PHASE 1 Integration Guide

Quick guide to integrate all PHASE 1 components into the existing codebase.

---

## 1. Update `src/server/app.js`

Add these imports at the top:

```javascript
const { errorHandler, asyncHandler } = require("../infrastructure/middleware/errorHandler");
const HealthChecker = require("../infrastructure/monitoring/HealthChecker");
const AlertManager = require("../infrastructure/notifications/AlertManager");
const createHealthRouter = require("./routes/health");
```

After initializing all bots (around line 63), add:

```javascript
// Initialize monitoring
const healthChecker = new HealthChecker({
  checkInterval: 60000, // 1 minute
  alertThresholds: {
    errorRatePercent: 0.05,
    memoryUsagePercent: 0.85,
    cpuUsagePercent: 0.80,
    exchangeLatencyMs: 10000,
  },
});

const alertManager = new AlertManager([
  // Add notifiers here
  // notifier.TelegramNotifier, etc
]);
```

After the existing routes (around line 140), add:

```javascript
// Health check routes
app.use("/api/v1/health", createHealthRouter({ 
  bots, 
  getBot, 
  broadcast, 
  sharedClient, 
  SYMBOLS_LIST,
  healthChecker,
  db,
  wss, // Add WebSocket server for client count
}));
```

At the very end (before module.exports), add error handler:

```javascript
// Error handling middleware — MUST be last
app.use((err, req, res, next) => {
  errorHandler(err, req, res, next);
});
```

Update exports:

```javascript
module.exports = { app, server, bots, getBot, healthChecker, alertManager };
```

---

## 2. Integrate Error Handling in Routes

In any route handler that's async, wrap with `asyncHandler`:

**Before:**
```javascript
router.get("/api/trades", async (req, res) => {
  const trades = db.getTrades();
  res.json(trades);
});
```

**After:**
```javascript
const { asyncHandler } = require("../../infrastructure/middleware/errorHandler");

router.get("/api/trades", asyncHandler(async (req, res) => {
  const trades = db.getTrades();
  res.json(trades);
}));
```

---

## 3. Use Proper Error Throwing

Instead of generic errors, use custom error classes:

**Before:**
```javascript
if (!symbol) {
  res.status(400).json({ error: "Symbol required" });
}
```

**After:**
```javascript
const { ValidationError, NotFoundError } = require("../../infrastructure/errors/AppError");

if (!symbol) {
  throw new ValidationError("Symbol is required", [
    { field: "symbol", message: "required" }
  ]);
}

const bot = getBot(symbol);
if (!bot) {
  throw new NotFoundError(`Bot not found for symbol: ${symbol}`);
}
```

---

## 4. Add Health Metrics in BotEngine

In `src/application/BotEngine.js`, after opening a trade, update metrics:

```javascript
// After trade opened
if (healthChecker) {
  healthChecker.updateBotStatus(this.config.symbol, this.getState());
}
```

---

## 5. Send Alerts for Important Events

In `src/application/BotEngine.js` or route handlers:

```javascript
const AlertManager = require("../infrastructure/notifications/AlertManager");

// After trade closed
if (alertManager && pnl > 0) {
  alertManager.notifyTrade(
    side, 
    symbol, 
    entryPrice, 
    exitPrice, 
    pnl, 
    "TP_HIT"
  );
}

// On critical error
if (alertManager && error.severity === "critical") {
  alertManager.critical(`Critical error: ${error.message}`, {
    symbol,
    error: error.code,
  });
}
```

---

## 6. Verify Integration

### Run Tests
```bash
npm test
# Should show: ✅ ALL TESTS PASSED (23/23)
```

### Check Health Endpoint
```bash
curl http://localhost:3000/api/v1/health
```

Expected response:
```json
{
  "ok": true,
  "timestamp": "2026-06-04T12:00:00.000Z",
  "version": "2.0.0",
  "uptime": "3600s",
  "bots": { "total": 3, "running": 2 },
  "dependencies": {
    "database": { "healthy": true, "latency": "5ms" },
    "exchange": { "healthy": true, "latency": "245ms" }
  }
}
```

### Test Error Handling
```javascript
// In any route:
throw new ValidationError("Test error");
// Should return proper JSON response
```

---

## 7. Configure Alerts (Optional - PHASE 1.5)

When ready to add Telegram notifications:

```javascript
const TelegramNotifier = require("../infrastructure/notifications/TelegramNotifier");

const telegramNotifier = new TelegramNotifier({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
});

const alertManager = new AlertManager([telegramNotifier]);
```

---

## 8. Test Full Integration

### Start Server
```bash
npm run dev
```

### Monitor Health in Another Terminal
```bash
watch -n 1 'curl http://localhost:3000/api/v1/health'
```

### Test Error Handling
```bash
curl http://localhost:3000/api/bots/INVALID_SYMBOL/start
```

Should return:
```json
{
  "ok": false,
  "statusCode": 404,
  "error": "NOT_FOUND",
  "message": "Bot not found for symbol: INVALID_SYMBOL",
  "timestamp": "2026-06-04T12:00:00.000Z"
}
```

---

## Migration Checklist

- [ ] Add imports to `src/server/app.js`
- [ ] Initialize HealthChecker and AlertManager
- [ ] Add health check routes
- [ ] Add error handler middleware
- [ ] Wrap async routes with asyncHandler
- [ ] Replace generic errors with custom classes
- [ ] Add health metrics updates in BotEngine
- [ ] Add alert notifications for key events
- [ ] Test all endpoints
- [ ] Verify error responses format
- [ ] Run `npm test` (should pass 23/23)
- [ ] Commit changes with message: "feat: integrate PHASE 1 foundation & safety"

---

## Troubleshooting

### Tests Failing
```bash
# Clear and reinstall
rm -rf node_modules package-lock.json
npm install
npm test
```

### Health Endpoint Returns 404
- Make sure you added the health routes to `app.js`
- Check the URL: `/api/v1/health` (not `/api/health`)

### Errors Not Being Caught
- Verify `errorHandler` middleware is last in the chain
- Ensure async route handlers use `asyncHandler` wrapper

### Alerts Not Sending
- Verify AlertManager is initialized with notifiers
- Check that `process.env.TELEGRAM_BOT_TOKEN` is set
- Test with `alertManager.warning("test message")`

---

## Next Phase

After integration is verified:
1. Run full integration tests
2. Deploy to staging environment
3. Monitor health metrics for 24 hours
4. Proceed to PHASE 2: Frontend Integration

---

**Questions?** Refer to:
- `API_SPECIFICATION.md` — API details
- `PHASE_1_COMPLETION.md` — Deliverables summary
- Test examples in `test/indicators.test.js`
