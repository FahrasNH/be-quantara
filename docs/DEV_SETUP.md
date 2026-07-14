# Development environment — `dev.quantara.software`

Isolated dev stack on the same VPS as production/staging (`187.77.135.156`).

| Item | Value |
|------|--------|
| Domain | `dev.quantara.software` |
| Git branch | `development` |
| FE path | `/var/www/quantara-dev/fe` |
| BE path | `/opt/quantara-dev/be` |
| PM2 app | `be-quantara-dev` |
| BE port | **3002** |
| Database | `bot_trading_development` |

## RAM note

Prod + staging already consume ~6 GB / 7.8 GB VPS RAM. Dev should stay **dry-run / backtest-only** (`dryRun=true` on bots). If OOM occurs during heavy backtests, stop staging live bots temporarily.

Dev PM2 `max_memory_restart` is **1536M** (lower than prod/staging 3072M).

---

## One-time VPS setup (manual / panel)

### 1. Git branch

Ensure `development` exists on GitHub (create from `staging` if missing):

```bash
git checkout staging && git pull
git checkout -b development && git push -u origin development
```

### 2. DNS (Cloudflare)

- Record: `dev` → `187.77.135.156` (proxied orange cloud)

### 3. TLS

```bash
certbot certonly --nginx -d dev.quantara.software
```

### 4. PostgreSQL

```sql
CREATE USER quantara_dev WITH PASSWORD 'YOUR_STRONG_PASSWORD';
CREATE DATABASE bot_trading_development OWNER quantara_dev;
GRANT ALL PRIVILEGES ON DATABASE bot_trading_development TO quantara_dev;
```

### 5. Clone backend

```bash
mkdir -p /opt/quantara-dev
git clone git@github.com:YOUR_ORG/be-quantara.git /opt/quantara-dev/be
cd /opt/quantara-dev/be
git checkout development
cp .env.development.example .env
# Edit .env — DATABASE_URL, JWT_*, ENCRYPTION_KEY, CORS_ORIGINS
npm ci --legacy-peer-deps
npx prisma migrate deploy
pm2 start ecosystem.config.js --only be-quantara-dev
pm2 save
```

### 6. Frontend + nginx

```bash
mkdir -p /var/www/quantara-dev/fe
# From local machine:
cd fe-bot-trading && ./deploy-development.sh --fe-only
```

Or copy `fe-bot-trading/nginx-dev.conf` to `/etc/nginx/sites-available/quantara-dev`, enable, `nginx -t && systemctl reload nginx`.

### 7. Smoke test

```bash
curl -sf http://127.0.0.1:3002/api/v1/health
curl -sf https://dev.quantara.software/api/v1/health
```

Login page should load at `https://dev.quantara.software`.

### Migration P3009 / P3018 (fresh DB)

If bootstrap fails on `20260610140000_add_trade_export_fields` (`relation "trades" does not exist`):

```bash
cd /opt/quantara-dev/be
git pull origin development
bash scripts/prisma-migrate-deploy.sh
```

Or re-run bootstrap after pull: `./deploy-development.sh --bootstrap-be --be-only` (requires `git pull` on VPS first).

### pgvector extension (42501 permission denied)

`quantara_dev` cannot `CREATE EXTENSION vector` — must run as Postgres superuser **once per database**:

```bash
sudo -u postgres psql -d bot_trading_development -c "CREATE EXTENSION IF NOT EXISTS vector;"
cd /opt/quantara-dev/be && bash scripts/prisma-migrate-deploy.sh
```

If `postgresql-*-pgvector` is not installed on Ubuntu:

```bash
apt install postgresql-16-pgvector   # match your Postgres major version
```

---

## Deploy from local machine

**First time (no `/opt/quantara-dev/be/.env` yet)?** Bootstrap once:

```bash
cd fe-bot-trading
./deploy-development.sh --bootstrap-be
```

This uploads `scripts/setup-development-vps.sh`, creates Postgres DB/user, clones `development`, generates `.env`, runs migrations, and starts PM2 `be-quantara-dev`.

**Routine deploy:**

```bash
cd fe-bot-trading
git pull origin development
chmod +x deploy-development.sh
./deploy-development.sh          # FE + BE
./deploy-development.sh --fe-only
./deploy-development.sh --be-only
```

Environment overrides: `DEV_VPS_SSH_HOST`, `DEV_VPS_HOST`, `REMOTE_FE`, `REMOTE_BE`.

---

## Repo files (Track B)

| File | Purpose |
|------|---------|
| `fe-bot-trading/deploy-development.sh` | Local deploy script |
| `fe-bot-trading/nginx-dev.conf` | nginx site (proxy → :3002) |
| `fe-bot-trading/.env.development` | Vite build env (same-origin) |
| `be-bot-trading/ecosystem.config.js` | PM2 app `be-quantara-dev` |
| `be-bot-trading/.env.development.example` | BE env template |
| `be-bot-trading/scripts/setup-development-vps.sh` | One-time VPS bootstrap (DB + clone + .env) |
| `be-bot-trading/scripts/deploy-development-vps.sh` | BE-only deploy on VPS |
