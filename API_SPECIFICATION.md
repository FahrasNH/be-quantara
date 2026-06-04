# Quantara API Specification

**Version:** 2.0.0  
**Last Updated:** 2026-06-04  
**Status:** Production Ready

---

## Table of Contents

1. [Overview](#overview)
2. [REST API](#rest-api)
3. [WebSocket API](#websocket-api)
4. [Error Handling](#error-handling)
5. [Authentication](#authentication)
6. [Rate Limiting](#rate-limiting)

---

## Overview

Quantara is an automated trading bot API that provides:
- **Multi-bot trading** (up to 3 symbols simultaneously)
- **Real-time market data** via REST and WebSocket
- **Trading history** and analytics
- **Strategy management** and parameter tuning
- **Risk management** with daily loss limits and position controls

### Base URL
- **HTTP:** `http://localhost:3000` (or your VPS IP)
- **WebSocket:** `ws://localhost:3000`

### Version
All endpoints use `/api/v1/` prefix (prepare for future versioning).

---

## REST API

### Health Check

**GET** `/health`

Returns system health status and running bots.

**Response (200 OK):**
```json
{
  "ok": true,
  "timestamp": "2026-06-04T10:30:00.000Z",
  "version": "2.0.0",
  "symbols": ["BTCUSDT", "ETHUSDT"],
  "runningBots": ["BTCUSDT"],
  "uptime_seconds": 3600,
  "database": "connected",
  "totalTrades": 42,
  "totalPnL": 1234.56
}
```

---

### Strategies Management

#### List Available Strategies

**GET** `/api/v1/strategies`

Returns all available trading strategies with their parameters.

**Response (200 OK):**
```json
{
  "strategies": [
    {
      "id": "A",
      "name": "Aggressive Scalping",
      "label": "Aggressive Scalping (1m - 15m)",
      "description": "High-frequency trading with tight stops",
      "interval": "1m",
      "higherTf": "15m",
      "emaFast": 9,
      "emaSlow": 21,
      "emaTrend": 0,
      "rsiPeriod": 7,
      "rsiLongMin": 50,
      "rsiLongMax": 70,
      "atrMultiplier": 0.5,
      "riskReward": 2,
      "leverage": 3,
      "maxTradesPerDay": 20,
      "maxDailyLossPct": 0.03,
      "riskPerTrade": 0.01,
      "volatilityProfile": "high",
      "recommended_capital": 500
    },
    {
      "id": "B",
      "name": "Day Trading",
      "label": "Day Trading (15m - 1h) [RECOMMENDED]",
      "description": "Balanced approach for daily trades",
      "interval": "15m",
      "higherTf": "1h",
      "emaFast": 9,
      "emaSlow": 21,
      "emaTrend": 50,
      "rsiPeriod": 14,
      "rsiLongMin": 50,
      "rsiLongMax": 70,
      "atrMultiplier": 1.0,
      "riskReward": 2,
      "leverage": 5,
      "maxTradesPerDay": 8,
      "maxDailyLossPct": 0.04,
      "riskPerTrade": 0.015,
      "volatilityProfile": "medium",
      "recommended_capital": 1000
    },
    {
      "id": "C",
      "name": "Swing Trading",
      "label": "Swing Trading (4h - 1d)",
      "description": "Longer-term swing positions",
      "interval": "4h",
      "higherTf": "1d",
      "emaFast": 21,
      "emaSlow": 50,
      "emaTrend": 200,
      "rsiPeriod": 14,
      "rsiLongMin": 40,
      "rsiLongMax": 60,
      "atrMultiplier": 1.5,
      "riskReward": 3,
      "leverage": 3,
      "maxTradesPerDay": 3,
      "maxDailyLossPct": 0.05,
      "riskPerTrade": 0.015,
      "volatilityProfile": "low",
      "recommended_capital": 2000
    }
  ]
}
```

---

### Bot Management

#### Get All Bots Status

**GET** `/api/v1/bots`

Returns status of all running bots.

**Response (200 OK):**
```json
{
  "bots": [
    {
      "symbol": "BTCUSDT",
      "running": true,
      "capital": 500,
      "startCapital": 500,
      "currentBalance": 523.45,
      "equity": 523.45,
      "roi_percent": 4.69,
      "openPositions": 1,
      "totalTrades": 42,
      "wins": 28,
      "losses": 14,
      "winRate": 66.67,
      "lastSignal": {
        "type": "LONG",
        "timestamp": "2026-06-04T10:25:00.000Z",
        "price": 62450.00
      },
      "strategy": {
        "id": "B",
        "name": "Day Trading",
        "interval": "15m"
      },
      "riskMetrics": {
        "dailyLoss": 100.00,
        "dailyLossPercent": 20.0,
        "dailyMaxLossPercent": 40.0,
        "dailyTradeCount": 3,
        "maxDailyTrades": 8,
        "consecLoss": 1,
        "maxConsecLoss": 3,
        "cooldownUntil": null
      },
      "lastTick": "2026-06-04T10:29:00.000Z",
      "lastPrice": 62480.50,
      "errors": 0,
      "checkCount": 180
    }
  ]
}
```

#### Get Single Bot Status

**GET** `/api/v1/bots/:symbol`

Get detailed status of a specific bot.

**Parameters:**
- `symbol` (path) — e.g., `BTCUSDT`

**Response (200 OK):**
Same as single bot object from above.

**Error Responses:**
- `404 Not Found` — Bot symbol not found

---

#### Start Bot

**POST** `/api/v1/bots/:symbol/start`

Start the trading bot for a symbol.

**Request Body:**
```json
{
  "capital": 500,          // optional, override default
  "strategy": "B"          // optional, override default
}
```

**Response (200 OK):**
```json
{
  "ok": true,
  "message": "Bot started successfully",
  "symbol": "BTCUSDT",
  "timestamp": "2026-06-04T10:30:00.000Z"
}
```

**Error Responses:**
- `400 Bad Request` — Invalid parameters or already running
- `500 Internal Server Error` — Exchange connection failed

---

#### Stop Bot

**POST** `/api/v1/bots/:symbol/stop`

Stop the trading bot. Closes all open positions before stopping.

**Response (200 OK):**
```json
{
  "ok": true,
  "message": "Bot stopped successfully",
  "symbol": "BTCUSDT",
  "closedPositions": [
    {
      "side": "LONG",
      "entry": 62400.00,
      "exit": 62480.50,
      "pnl": 80.50,
      "closedAt": "2026-06-04T10:30:00.000Z"
    }
  ],
  "timestamp": "2026-06-04T10:30:00.000Z"
}
```

**Error Responses:**
- `400 Bad Request` — Bot not running
- `500 Internal Server Error` — Failed to close positions

---

#### Emergency Stop

**POST** `/api/v1/bots/:symbol/emergency-stop`

Immediately stop bot and close all positions without graceful shutdown. Use only in critical situations.

**Response (200 OK):**
```json
{
  "ok": true,
  "message": "Emergency stop executed",
  "symbol": "BTCUSDT",
  "forceClosed": 1,
  "timestamp": "2026-06-04T10:30:00.000Z"
}
```

---

#### Update Bot Strategy

**PATCH** `/api/v1/bots/:symbol/strategy`

Change trading strategy without restarting bot.

**Request Body:**
```json
{
  "strategyId": "C"
}
```

**Response (200 OK):**
```json
{
  "ok": true,
  "message": "Strategy updated",
  "symbol": "BTCUSDT",
  "previousStrategy": "B",
  "newStrategy": "C",
  "timestamp": "2026-06-04T10:30:00.000Z"
}
```

---

### Trading History

#### Get Trade History

**GET** `/api/v1/history/trades`

Returns all closed trades with pagination.

**Query Parameters:**
- `symbol` — Filter by symbol (optional)
- `limit` — Max results per page (default: 50, max: 500)
- `offset` — Pagination offset (default: 0)
- `status` — Filter: `all`, `wins`, `losses` (default: all)

**Response (200 OK):**
```json
{
  "trades": [
    {
      "id": "t_123456",
      "symbol": "BTCUSDT",
      "side": "LONG",
      "entry": 62400.00,
      "entryTime": "2026-06-04T10:00:00.000Z",
      "exit": 62480.50,
      "exitTime": "2026-06-04T10:15:00.000Z",
      "sl": 62280.00,
      "tp": 62720.00,
      "size": 0.01,
      "pnl": 80.50,
      "pnl_percent": 0.128,
      "status": "closed",
      "reason": "TP_HIT",
      "duration_minutes": 15,
      "strategy": "B"
    }
  ],
  "pagination": {
    "total": 42,
    "offset": 0,
    "limit": 50,
    "hasMore": false
  }
}
```

---

#### Get Trade Statistics

**GET** `/api/v1/history/stats`

Get aggregated trading statistics.

**Query Parameters:**
- `symbol` — Filter by symbol (optional)
- `period` — Time period: `1h`, `1d`, `1w`, `1m`, `all` (default: all)

**Response (200 OK):**
```json
{
  "period": "all",
  "symbol": "BTCUSDT",
  "stats": {
    "totalTrades": 42,
    "wins": 28,
    "losses": 14,
    "winRate": 66.67,
    "avgWin": 120.50,
    "avgLoss": 85.25,
    "profitFactor": 3.84,
    "expectancy": 98.32,
    "grossProfit": 3374.00,
    "grossLoss": 878.50,
    "netPnL": 2495.50,
    "roi_percent": 499.1,
    "maxConsecWins": 7,
    "maxConsecLosses": 2,
    "maxDrawdown": 0.18,
    "sharpeRatio": 2.45,
    "recoveryFactor": 13.87
  },
  "equity": {
    "startCapital": 500.00,
    "currentCapital": 2995.50,
    "highestEquity": 3100.00,
    "timestamp": "2026-06-04T10:30:00.000Z"
  }
}
```

---

#### Get Equity Curve

**GET** `/api/v1/history/equity`

Returns equity curve over time for charting.

**Query Parameters:**
- `symbol` — Filter by symbol (required)
- `interval` — Data point interval: `1h`, `1d`, `1w` (default: 1d)

**Response (200 OK):**
```json
{
  "symbol": "BTCUSDT",
  "data": [
    {
      "timestamp": "2026-06-01T00:00:00.000Z",
      "equity": 500.00,
      "trades": 0,
      "roi_percent": 0.0
    },
    {
      "timestamp": "2026-06-02T00:00:00.000Z",
      "equity": 625.00,
      "trades": 5,
      "roi_percent": 25.0
    }
  ]
}
```

---

### Market Data

#### Get Current Price

**GET** `/api/v1/market/:symbol/price`

Get latest price for a symbol.

**Response (200 OK):**
```json
{
  "symbol": "BTCUSDT",
  "price": 62480.50,
  "timestamp": "2026-06-04T10:29:30.000Z",
  "24hHigh": 63500.00,
  "24hLow": 61200.00,
  "24hChange": 1280.50,
  "24hChangePercent": 2.09
}
```

---

#### Get OHLCV Candles

**GET** `/api/v1/market/:symbol/candles`

Get OHLCV candles for technical analysis.

**Query Parameters:**
- `interval` — Candle interval: `1m`, `5m`, `15m`, `1h`, `4h`, `1d` (default: 1h)
- `limit` — Number of candles (default: 100, max: 1000)

**Response (200 OK):**
```json
{
  "symbol": "BTCUSDT",
  "interval": "1h",
  "candles": [
    {
      "timestamp": "2026-06-04T09:00:00.000Z",
      "open": 62300.00,
      "high": 62550.00,
      "low": 62250.00,
      "close": 62480.00,
      "volume": 25.34
    }
  ]
}
```

---

## WebSocket API

### Connection

**Endpoint:** `ws://localhost:3000`

### Message Format

All messages are JSON strings:
```typescript
interface WSMessage {
  type: "log" | "status" | "trade" | "error" | "position" | "ping" | "pong";
  symbol: string;
  timestamp: string;
  data: any;
}
```

---

### Server Messages (Sent to Client)

#### 1. Log Stream

**Type:** `log`

Sent whenever bot performs an action or logs something.

```json
{
  "type": "log",
  "symbol": "BTCUSDT",
  "timestamp": "2026-06-04T10:30:00.000Z",
  "data": {
    "level": "info|warn|error|trade|price",
    "message": "EMA crossover detected (9 > 21)"
  }
}
```

#### 2. Bot Status Update

**Type:** `status`

Sent on bot state change (running, stopped, signal detected, position opened/closed).

```json
{
  "type": "status",
  "symbol": "BTCUSDT",
  "timestamp": "2026-06-04T10:30:00.000Z",
  "data": {
    "running": true,
    "openPositions": 1,
    "capital": 523.45,
    "roi_percent": 4.69,
    "lastSignal": "LONG",
    "lastPrice": 62480.50,
    "dailyPnL": -50.00
  }
}
```

#### 3. Trade Executed

**Type:** `trade`

Sent when bot opens or closes a trade.

```json
{
  "type": "trade",
  "symbol": "BTCUSDT",
  "timestamp": "2026-06-04T10:30:00.000Z",
  "data": {
    "action": "open|close",
    "side": "LONG",
    "entry": 62400.00,
    "exit": 62480.00,
    "size": 0.01,
    "sl": 62280.00,
    "tp": 62720.00,
    "pnl": 80.00,
    "reason": "SIGNAL|TP_HIT|SL_HIT|MANUAL"
  }
}
```

#### 4. Error Alert

**Type:** `error`

Sent when bot encounters critical errors.

```json
{
  "type": "error",
  "symbol": "BTCUSDT",
  "timestamp": "2026-06-04T10:30:00.000Z",
  "data": {
    "severity": "warning|critical",
    "message": "Failed to fetch OHLCV data",
    "code": "API_ERROR",
    "action": "Retrying in 10 seconds..."
  }
}
```

#### 5. Heartbeat

**Type:** `ping` / `pong`

Sent by server every 25 seconds; client must respond with `pong`.

```json
{
  "type": "ping",
  "timestamp": "2026-06-04T10:30:00.000Z"
}
```

---

### Client Messages (Send to Server)

#### Subscribe to Symbol Logs

```json
{
  "action": "subscribe",
  "symbol": "BTCUSDT"
}
```

#### Unsubscribe

```json
{
  "action": "unsubscribe",
  "symbol": "BTCUSDT"
}
```

#### Heartbeat Response

```json
{
  "type": "pong"
}
```

---

## Error Handling

### Error Response Format

**All error responses follow this structure:**

```json
{
  "ok": false,
  "statusCode": 400,
  "error": "Validation Error",
  "message": "Invalid symbol format",
  "timestamp": "2026-06-04T10:30:00.000Z",
  "requestId": "req_abc123"
}
```

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad Request (validation error) |
| 401 | Unauthorized (missing/invalid token) |
| 403 | Forbidden (no permission) |
| 404 | Not Found |
| 409 | Conflict (e.g., bot already running) |
| 429 | Rate Limited |
| 500 | Internal Server Error |
| 503 | Service Unavailable |

### Common Error Codes

| Code | Meaning | Recovery |
|------|---------|----------|
| `SYMBOL_NOT_FOUND` | Unknown symbol | Check available symbols |
| `BOT_ALREADY_RUNNING` | Bot is running | Stop first or use update endpoint |
| `BOT_NOT_RUNNING` | Bot is stopped | Start the bot |
| `INSUFFICIENT_BALANCE` | Not enough capital | Deposit or reduce risk |
| `API_ERROR` | Exchange API failed | Retry, check internet connection |
| `POSITION_CLOSED_EXTERNALLY` | Position closed outside bot | Sync state with exchange |
| `UNKNOWN_ERROR` | Unexpected error | Check logs, contact support |

---

## Authentication

### Current Status

**No authentication is currently implemented.** The API is designed for:
- **Development/Testing:** Local usage only
- **Production:** Should be behind a proxy with authentication

### Recommended Implementation (Future)

1. **API Key-based:** (for programmatic access)
   - Header: `Authorization: Bearer <api_key>`
   - Store API keys hashed in database

2. **Session-based:** (for web dashboard)
   - Cookie-based JWT token
   - Refresh token rotation
   - CSRF protection

### Security Notes

- ✅ API currently assumes **trusted network** (same machine or VPN)
- ⚠️ **DO NOT expose to internet** without authentication
- 🔒 All sensitive endpoints should require auth in production

---

## Rate Limiting

### Current Status

**No rate limiting is currently implemented.**

### Recommended Implementation (Future)

- **Public endpoints:** 100 requests/minute per IP
- **Bot control endpoints:** 10 requests/minute per symbol
- **Trading endpoints:** 5 requests/minute per symbol

### Headers

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1717500600
```

---

## Examples

### Example 1: Start Bot and Monitor Trades

```javascript
// HTTP: Start bot
const response = await fetch('http://localhost:3000/api/v1/bots/BTCUSDT/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ capital: 500, strategy: 'B' })
});

// WebSocket: Stream logs and trades
const ws = new WebSocket('ws://localhost:3000');
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'trade') {
    console.log(`Trade closed: ${msg.data.pnl > 0 ? 'WIN' : 'LOSS'}`);
  }
};
```

### Example 2: Get Trading Statistics

```javascript
// Get stats for last 24 hours
const response = await fetch('http://localhost:3000/api/v1/history/stats?symbol=BTCUSDT&period=1d');
const data = await response.json();
console.log(`Win Rate: ${data.stats.winRate}%`);
console.log(`Profit Factor: ${data.stats.profitFactor}`);
```

---

## Changelog

### v2.0.0 (2026-06-04)
- ✅ Initial specification
- ✅ Multi-bot support documented
- ✅ WebSocket streaming added
- ✅ Trading history endpoints added
- ✅ Strategy management endpoints added
- ✅ Emergency stop endpoint added
- ✅ Comprehensive error handling documented
- 🟡 Authentication (planned for v2.1.0)
- 🟡 Rate limiting (planned for v2.1.0)

---

## Support

For API issues or questions:
1. Check `/health` endpoint first
2. Review logs via WebSocket connection
3. Refer to bot logs in database
4. Enable debug mode in `.env`
