# Payment & Voucher System (Sprint 5) — Staging Deploy Runbook

Backend for PAY-01 … PAY-07 is implemented on branch
`feature/pay-sprint5-payment-voucher` (based on `staging`). This runbook covers
the **human-only** steps to make it usable on staging so QA (PAY-11) and Security
(PAY-12) can test.

## 0. Prereqs (human blockers)
- [ ] **Midtrans SANDBOX account** created → copy **Server Key** + **Client Key**
      (Dashboard → Settings → Access Keys).
- [ ] Decide the public backend URL for webhooks, e.g. `https://staging.quantara.software`.

## 1. Merge to staging
This branch is based on `staging`. Merge it into `staging` (and keep `main`
in sync per the deploy branch-mismatch rule):
```
git checkout staging && git merge --no-ff feature/pay-sprint5-payment-voucher
git checkout main    && git merge --no-ff staging        # keep main == staging
git push origin staging main
```
> `deploy-staging.sh` resets BE to `origin/staging`, so the work MUST be on
> `origin/staging` or it silently vanishes.

## 2. VPS `.env` additions
```
MIDTRANS_SERVER_KEY=SB-Mid-server-xxxxxxxx
MIDTRANS_CLIENT_KEY=SB-Mid-client-xxxxxxxx
MIDTRANS_IS_PRODUCTION=false
API_PUBLIC_URL=https://staging.quantara.software
# Allow paid tiers to be PURCHASED on staging (otherwise checkout is blocked):
ALLOWED_TIERS=          # empty = all tiers (or e.g. FOUNDRY,FORGE,MINT,VAULT)
```
> If `ALLOWED_TIERS=FOUNDRY` (closed-beta flag) is set, FORGE/MINT/VAULT purchases
> return 403 and the E2E flow cannot complete. Relax it on staging.

## 3. Apply migration + seed (on VPS, in be-bot-trading)
`prisma migrate dev` is broken in this repo (shadow-DB). Use the migration that
ships in `prisma/migrations/20260625120000_add_payment_voucher_system/`:
```
npx prisma migrate deploy     # applies the additive migration (6 tables)
npx prisma generate
npm run seed:payment          # 4 tiers + 2 sample vouchers (WELCOME10, LAUNCH50K)
```
Migration is **purely additive** (6 CREATE TABLE + indexes + FKs, no DROP).

## 4. Register webhook in Midtrans dashboard
Settings → Configuration → **Payment Notification URL**:
```
https://staging.quantara.software/api/v1/payments/webhook
```
(Finish/Unfinish/Error redirect URLs → the FE checkout result page once PAY-09 ships.)

## 5. Restart backend
```
pm2 startOrReload ecosystem.config.js --only <app>   # NOT plain `pm2 restart`
```

## 6. Smoke test (curl, with a user JWT)
```
# Snap config
curl -H "Authorization: Bearer $JWT" .../api/v1/payments/config
# Voucher preview (server-side discount)
curl -XPOST .../api/v1/payments/voucher/preview -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"tier":"FORGE","voucherCode":"WELCOME10"}'
# Initiate → returns snapToken
curl -XPOST .../api/v1/payments/initiate -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"tier":"FORGE","billingCycle":"MONTHLY","voucherCode":"WELCOME10"}'
```
Then pay with a Midtrans sandbox card; the webhook should flip the payment to
PAID and create an ACTIVE Subscription (verify `GET /api/v1/subscription`).

## API surface delivered
| Method | Path | Auth | Task |
|---|---|---|---|
| GET  | `/api/v1/payments/config` | user | PAY-05 |
| POST | `/api/v1/payments/voucher/preview` | user | PAY-03/09 |
| POST | `/api/v1/payments/initiate` | user (rate-limited) | PAY-03/05 |
| GET  | `/api/v1/payments/history` | user | PAY-05 |
| GET  | `/api/v1/payments/:orderId/status` | user | PAY-05 |
| POST | `/api/v1/payments/webhook` | **signature** | PAY-04 |
| POST/GET/PATCH/DELETE | `/api/v1/admin/vouchers[...]` | admin | PAY-06 |

## Security notes for PAY-12 review
- Webhook verifies SHA512 `sha512(order_id+status_code+gross_amount+serverKey)`
  before trusting anything (`infrastructure/payment/midtrans.verifySignature`).
- Idempotency: `Payment.orderId` unique; duplicate PAID webhooks are no-ops;
  `Subscription` granted once per payment.
- Voucher fraud: slot **reserved** at initiate via atomic
  `UPDATE ... WHERE currentUses < maxUses`; released on FAILED/EXPIRED;
  `VoucherUsage.paymentId` unique + per-user cap.
- Amounts are **server-computed** (`domain/pricing.js`); client cannot send a price.
- No card data is logged (`redactNotification` strips `signature_key`; Snap never
  exposes PAN).
- **Open item:** the global `/api/v1/` IP rate-limiter also covers `/payments/webhook`.
  Midtrans retries are idempotent so this is safe, but consider exempting the
  webhook path so a burst of legit notifications isn't throttled.
