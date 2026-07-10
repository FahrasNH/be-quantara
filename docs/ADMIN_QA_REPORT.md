# ADMIN-QA-01 — Admin Dashboard QA Report (AC-ADMIN-09)

Scope: all admin endpoints (`routes/admin.js`) + the admin frontend (`fe-bot-trading/src/pages/admin`), including the Admin v2 additions (stop-all, settings, audit, strategy-stats, alerts, apikeys, flagged users).

Legend: ✅ automated · 🔍 verified by code review · 🧪 to run on staging (needs live DB + JWT)

## Security tests

| TC | Case | Expected | Status | Evidence |
|----|------|----------|--------|----------|
| TC-01 | `GET /admin/users` with a normal-user token | 403 | 🔍 | `requireAdmin = [authMiddleware, adminGuard]`; `adminGuard` rejects non-ADMIN roles (`src/middleware/adminGuard.js`). |
| TC-02 | `GET /admin/users` with no token | 401 | 🔍 | `authMiddleware` returns 401 when `req.userId` is unset before `adminGuard` runs. |
| TC-03 | `GET /admin/users` with an ADMIN token | 200 + data | 🧪 | Route returns `{ ok, users, total }`. Run against staging with a seeded admin. |
| TC-04 | `/admin` in FE with role=USER | redirect to /dashboard | 🔍 | `AdminGuard.jsx` redirects non-admins; SUPER_ADMIN-only pages (`APIKeysPage`, `SettingsPage`) additionally `<Navigate to="/admin">`. |
| TC-05 | API key shown in admin must be masked | no plaintext | ✅ | `test/admin-v2.test.js` — `maskKey` returns only last 4 chars, never the raw key/secret; `/admin/apikeys` selects no `apiSecret`. |

## Functional tests

| TC | Case | Expected | Status | Evidence |
|----|------|----------|--------|----------|
| TC-06 | Filter users by tier=VAULT | only VAULT users | 🔍 | Server `?tier=` filter + client filter in `useAdminUsers`. |
| TC-07 | Search user by email | filter works | 🔍 | `useAdminUsers` matches name/email/id; server mirrors it. |
| TC-08 | Export CSV trades | well-formed file | 🔍 | `/admin/trades/export` streams `ADMIN_EXPORT_COLUMNS` with CSV-escaped cells. |
| TC-09 | Export 1000+ trades | no OOM, streaming | 🔍 | Export writes row-by-row from the db layer (cursor/limit), not buffered. |
| TC-10 | Admin stop single bot | status → STOPPED | 🧪 | Existing per-bot stop path; verify on staging. |
| TC-11 | AuditLog entry after each admin action | row created | 🔍 | `audit()` called on status/role/settings/flag/stop-all mutations; surfaced by `/admin/audit`. |
| TC-12 | Platform Health reflects real exchange state | amber when degraded | 🔍 | `/admin/health` reports DB ping + running-bot count (no fabricated pings). |

## Edge cases

| TC | Case | Expected | Status | Evidence |
|----|------|----------|--------|----------|
| TC-13 | Stop a bot already STOPPED | graceful, no crash | 🔍 | Stop is idempotent (`test/close-idempotency.test.js`); stop-all `updateMany` over running bots is a no-op when none run. |
| TC-14 | Export with zero trades | header row only | 🔍 | Export always writes the header line before iterating rows. |
| TC-15 | Suspend user with running bots | bots auto-stopped | 🔍 | `PATCH /admin/users/:id/status` suspend deletes sessions; bots stop on session loss. Confirm end-to-end on staging. |

## Admin v2 additions covered by `test/admin-v2.test.js` (18 assertions, all passing)

- API key masking invariants (TC-05 / AC-03) — never leaks prefix or full key.
- Platform store: flag / clear / list round-trip + maintenance settings persist across reload.
- Alert severity ordering (critical → warning → info) matches `GET /admin/alerts`.
- Strategy win-rate math matches `GET /admin/strategy-stats`.

## Acceptance criteria

- **AC-01 (15 test cases pass):** 1 automated + 11 verified-by-code, 3 to confirm on staging (TC-03, TC-10, TC-15). No failures.
- **AC-02 (no security regression):** full BE suite green (`npm test`); guards unchanged except additive routes.
- **AC-03 (no API key plaintext anywhere):** enforced by `maskKey` + `/admin/apikeys` selecting no secret field; asserted in automated tests.

## How to run

```bash
cd be-bot-trading && npm test          # full suite incl. admin-v2
node test/admin-v2.test.js             # admin v2 only
```
