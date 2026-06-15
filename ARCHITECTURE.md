# Quantara Backend — Architecture Notes

> Living doc. Sections are added as subsystems are formalized. This file currently
> documents the **market / exchange** layer (Tasks A & C, Binance integration).

---

## 3. API Surface

### 3.4 Market Endpoints

All routes are mounted under `/api/v1/market` behind `authMiddleware` (Bearer JWT
→ `req.userId`). Source: `src/server/routes/market.js`.

| Method | Path | Auth | User-scoped? | Data source | Notes |
|--------|------|------|--------------|-------------|-------|
| GET | `/market/symbols` | ✅ | ✅ by `req.userId` | Per-exchange public CCXT `loadMarkets` | **New (Task A).** Returns the user's connected exchange's USDT-M linear perpetual pairs. 5-min cache + stale fallback. Rate-limited 10/min/user. |
| GET | `/market/tickers` | ✅ | ➖ public data | `sharedClient` (env keys) | Public last-price/24h. No user data. |
| GET | `/market/positions` | ✅ | ⚠️ shared account | `sharedClient` (env keys) | See audit finding **SEC-MKT-1**. |
| GET | `/market/candles` | ✅ | partial (`getBot` for interval) | `sharedClient` + cache | Public OHLCV. |
| GET | `/market/candles/backtest` | ✅ | ➖ public data | `sharedClient` + cache | Public OHLCV (paginated). |

#### `GET /api/v1/market/symbols`

Returns live perpetual pairs from the **exchange the requesting user has connected**.

- **Auth:** required (Bearer).
- **Rate limit:** 10 req/min/user (`SYMBOLS_RATE_LIMITED` 429 on excess).
- **Resolution:** `ExchangeService.getConnectedExchange(userId)` reads the user's
  own active `UserExchange` record (or legacy `User.exchangeType`).
- **Listing:** keyless public CCXT instance for that exchange → `loadMarkets` →
  filter to `swap && linear && quote === "USDT" && active` → normalize.

**Response 200:**
```json
{
  "ok": true,
  "exchange": "binance",
  "cached": false,
  "stale": false,
  "symbols": [
    { "symbol": "BTCUSDT", "baseAsset": "BTC", "quoteAsset": "USDT", "minQty": 0.001 }
  ]
}
```

**Caching (AC-4/AC-5):** in-memory, keyed **per exchange** (the list is public and
identical for all users on that exchange — no user data flows through the cache).
TTL 5 min. On exchange API failure with a warm cache → returns last list with
`"stale": true`. With a cold cache → `503 EXCHANGE_UNAVAILABLE` (never empty, never 500).

**Error states:**
| HTTP | code | when |
|------|------|------|
| 400 | `NO_EXCHANGE_CONNECTED` | user has no connected exchange |
| 400 | `EXCHANGE_NOT_SUPPORTED` | connected exchange not in {bitget, okx, binance} |
| 429 | `SYMBOLS_RATE_LIMITED` | >10 req/min |
| 503 | `EXCHANGE_UNAVAILABLE` | exchange down + no cache |

### 3.5 Supported Exchanges

| Exchange | Trading | Symbols listing | Key onboarding validation |
|----------|---------|-----------------|---------------------------|
| Bitget | ✅ full (`BitgetClient`) | ✅ | balance-reachability check |
| OKX | (client removed) | ✅ (public CCXT) | trusted as-is |
| Binance | market-data + onboarding only (`BinanceClient`) | ✅ | **permission validation** (futures-only, reject withdrawal) |

> `exchangeType` is a free-form `String` in Prisma (`schema.prisma`), **not** a DB
> enum. Adding Binance therefore needs **no migration** — `"binance"` is already a
> structurally valid value. Gating is enforced at the application layer via
> `cfg.allowedExchanges` and `POST /account/keys`.

---

## Appendix A — IDOR Audit: Market & Symbol Endpoints (Task C)

Audited 2026-06-16. Scope: the 5 endpoints in §3.4. Goal: confirm every endpoint
that returns user-specific data scopes its query to `req.userId` (from the verified
JWT), never to a spoofable param/body.

| Endpoint | Returns user-specific data? | userId source | Verdict |
|----------|----------------------------|---------------|---------|
| `GET /market/symbols` | No (public list; exchange *type* derived from user's own record) | `req.userId` (JWT) | ✅ **IDOR-safe** (AC-5) |
| `GET /market/tickers` | No — public prices | n/a | ✅ no user data |
| `GET /market/candles` | No — public OHLCV (`getBot(req.userId,…)` only for interval default) | `req.userId` (JWT) | ✅ no leak |
| `GET /market/candles/backtest` | No — public OHLCV | n/a | ✅ no user data |
| `GET /market/positions` | **Operator's shared account** positions | n/a (env keys) | ⚠️ **SEC-MKT-1** |

**Conclusion (AC-6):** No cross-user IDOR found. `req.userId` always comes from the
verified JWT payload (`authMiddleware`), never from request params/body. The new
`/market/symbols` endpoint cannot return another user's data — it only ever reads
the caller's own `UserExchange` record to pick which *public* list to serve.

### Finding SEC-MKT-1 (pre-existing, not introduced by this work)

`GET /market/positions` calls `sharedClient.getPositions(sym)`, where `sharedClient`
is built from **operator ENV keys** — so any authenticated user receives the
operator account's open positions. This is **not** cross-user IDOR (no per-user
private data leaks between users), but it is an information-disclosure smell:
per-user position data should come from the user's own exchange credentials.

- **Severity:** P3 (no per-user data leak; exposes shared operator account only).
- **Recommendation:** scope to the user's own creds (like `/account/exchange-balance`)
  or remove the endpoint if the FE relies on per-bot WS state instead.
- **Status:** filed as a separate follow-up task; **not a Binance go-live blocker.**

### Encryption verification (AC-8)

Binance keys reuse the existing `crypto.js` AES-256-GCM path (`encrypt`/`decrypt`,
12-byte IV, auth tag, `iv:authTag:ciphertext` format) via `userExchange.upsertExchange`
— identical to Bitget/OKX. No Binance-specific storage path exists, so there is no
divergent encryption surface to verify beyond the shared mechanism.
