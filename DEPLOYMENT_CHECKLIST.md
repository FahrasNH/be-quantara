# 🚀 Quantara Bot Trading — Deployment & Verification Checklist

## Phase 1: Environment Setup ✅

### Backend Configuration

#### 1. **PostgreSQL Database** ✅
- [x] Database created: `bot_trading`
- [x] Connection string in `.env`: `DATABASE_URL="postgresql://..."`
- [x] Migrations applied: `npx prisma migrate deploy`

#### 2. **JWT Secrets** ✅
- [x] JWT_SECRET configured (15m access tokens)
- [x] JWT_REFRESH_SECRET configured (7d refresh tokens)
- [x] Both secrets are unique and at least 48 bytes

#### 3. **Encryption Key** ✅
- [x] ENCRYPTION_KEY generated: `openssl rand -hex 32`
- [x] Used for encrypting user API keys at rest

#### 4. **Trust Proxy for Rate Limiting** ✅
- [x] TRUST_PROXY_HOPS=1 in backend (for nginx reverse proxy)
- [x] Rate limits:
  - Auth endpoints: 10 req/15min per IP (production)
  - API endpoints: 1000 req/15min per IP (for polling)

---

## Phase 2: Frontend State Persistence ✅

### Logs Persistence
- [x] Bot logs now persist to `localStorage` as they arrive
- [x] Logs survive page reload/re-login
- [x] Maximum 800 logs stored (automatic trimming)
- [x] Clear logs button removes from memory AND localStorage

### Trading Mode Preference
- [x] User preference stored in localStorage (`tradingMode`)
- [x] Used for default bot creation mode (Live/Dry Run)
- [x] Running bots show mode mismatch badge with restart instructions

---

## Phase 3: Telegram Notifications Setup ⚠️ **REQUIRED**

### ⚠️ Currently Disabled — Follow These Steps:

#### Step 1: Create Telegram Bot
```bash
1. Open Telegram
2. Search for @BotFather
3. Send: /newbot
4. Follow prompts to create bot
5. Copy TOKEN: 123456789:AABBccdd...
```

#### Step 2: Get Chat ID
```bash
1. Send message to your new bot in Telegram
2. Visit: https://api.telegram.org/bot{TOKEN}/getUpdates
3. Find in response: "chat":{"id":123456789}
4. That's your CHAT_ID
```

#### Step 3: Set Environment Variables

**Development (.env)**:
```bash
TELEGRAM_BOT_TOKEN="123456789:AABBccdd..."
TELEGRAM_CHAT_ID="123456789"
```

**Production (.env.production)**:
```bash
TELEGRAM_BOT_TOKEN="your-prod-token"
TELEGRAM_CHAT_ID="your-prod-chat-id"
```

#### Step 4: Verify
- [ ] Start backend: `npm run dev`
- [ ] Check logs: `[Notifier] ✅ Notifikasi Telegram AKTIF → Chat ID: ...`
- [ ] No logs? Check token/chat ID

### Telegram Notifications Sent On:
- ✅ **Open Posisi**: LONG/SHORT dengan entry, SL, TP, leverage
- ✅ **Close Posisi**: Exit price, PnL, ROI%, reason (TP/SL/Reversal)
- ✅ **Mode Tag**: [DRY RUN] atau [LIVE]

---

## Phase 4: Trade Data Verification ✅

### Trade Schema (Prisma)
All fields being saved correctly for backtesting:

```javascript
Trade {
  id              String          // Unique ID
  botId           String          // Bot reference
  symbol          String          // BTCUSDT, ETHUSDT, etc.
  side            String          // LONG / SHORT
  entry           Float           // Entry price
  exit            Float?          // Exit price (nullable if still open)
  quantity        Float           // Trade size
  pnl             Float?          // Profit/Loss in USDT
  pnlPercent      Float?          // ROI percentage
  status          String          // OPEN / CLOSED
  enteredAt       DateTime        // Entry timestamp
  exitedAt        DateTime?       // Exit timestamp
}
```

### Indicators Being Saved (from old system):
- ATR (Average True Range) — for volatility-based TP/SL
- Entry/Exit signals from strategy engine
- Leverage & position size

### Verification Queries:
```bash
# Check trades in database
psql -U bottrading -d bot_trading -c "SELECT COUNT(*) FROM \"Trade\" WHERE status='OPEN';"

# Recent closed trades
psql -U bottrading -d bot_trading -c "SELECT symbol, side, entry, exit, pnl FROM \"Trade\" WHERE status='CLOSED' ORDER BY \"exitedAt\" DESC LIMIT 10;"

# PnL distribution
psql -U bottrading -d bot_trading -c "SELECT symbol, SUM(pnl) as total_pnl, COUNT(*) as trades FROM \"Trade\" WHERE status='CLOSED' GROUP BY symbol;"
```

---

## Phase 5: Rate Limiting Verification ✅

### Check Headers in Network Tab:
```
RateLimit-Limit: 1000
RateLimit-Remaining: 999
RateLimit-Reset: <timestamp>
```

### If Still Getting 429 Errors:
1. Check `TRUST_PROXY_HOPS=1` in backend .env
2. Verify nginx is sending `X-Forwarded-For` header
3. Increase `API_RATE_LIMIT` if needed (default 1000 is safe)

---

## Phase 6: Production Deployment Checklist

### Backend Deployment
```bash
# 1. Pull latest code
git pull origin main

# 2. Apply database migrations
npx prisma migrate deploy

# 3. Set production env vars
cp .env.production.example .env.production
# Edit .env.production with real values

# 4. Restart with PM2
pm2 restart all
# or: pm2 start ecosystem.config.js --env production

# 5. Verify
curl http://localhost:3000/health
```

### Frontend Deployment
```bash
# 1. Build for production
npm run build

# 2. Deploy to static host (Vercel, Netlify, etc)
# or serve with nginx

# 3. Verify CORS origin matches backend
# Check: fe-bot-trading/.env.production VITE_API_URL
```

### Nginx Reverse Proxy Configuration
```nginx
upstream backend {
  server 127.0.0.1:3000;
}

server {
  listen 80;
  server_name your-domain.com;

  # Proxy to backend
  location /api/ {
    proxy_pass http://backend;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
  }

  # WebSocket support
  location /ws {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  # Static files (frontend)
  location / {
    root /path/to/fe-bot-trading/dist;
    try_files $uri $uri/ /index.html;
  }
}
```

---

## Phase 7: Monitoring & Alerts

### What to Monitor
- [ ] Backend uptime
- [ ] Database connection
- [ ] WebSocket connection reliability
- [ ] Telegram notification delivery
- [ ] Bot execution logs
- [ ] Trade execution times

### Recommended Tools
- **Error Tracking**: Sentry (optional)
- **Logs**: Docker logs / PM2 logs
- **Uptime**: Healthchecks.io (optional)
- **Alerts**: Telegram bot notifications

---

## Known Limitations

1. **SQLite in Development Only**
   - Production MUST use PostgreSQL
   - SQLite doesn't support concurrent writes well

2. **Exchange API Rate Limits**
   - Bitget: 10 requests/second
   - Bot respects these limits automatically

3. **Backtesting Limitations**
   - Historical data limited to available candles
   - May need to implement data fetching from exchange

---

## Troubleshooting

### Logs Disappearing
- ✅ **Fixed**: Now persisted to localStorage
- Logs survive page reload, browser close, re-login

### Telegram Not Sending
1. Check token/chat ID in `.env`
2. Test manually: `curl "https://api.telegram.org/bot{TOKEN}/sendMessage?chat_id={CHAT_ID}&text=test"`
3. Check backend logs for errors

### Rate Limit 429 Errors
1. Verify `TRUST_PROXY_HOPS=1`
2. Check polling intervals (should be 15s+)
3. Restart backend after config changes

### Trade Data Missing
1. Check if exchange is configured in Settings
2. Verify bot is running (status should be AKTIF)
3. Check PostgreSQL connection and migrations

---

## Next Steps

1. [ ] **Telegram Setup**: Follow Phase 3 above
2. [ ] **Test Telegram**: Start a bot and verify notifications arrive
3. [ ] **Verify Trade Data**: Run queries from Phase 4
4. [ ] **Deploy to VPS**: Follow Phase 6
5. [ ] **Monitor Production**: Set up alerts and logs

---

**Last Updated**: 2026-06-05  
**Status**: Ready for Live Trading ✅ (pending Telegram setup)
