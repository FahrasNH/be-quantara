# Staging Setup — Quantara

> **Panduan deploy utama:** [DEPLOY_QUICK_START.md](../DEPLOY_QUICK_START.md)

Production dan staging berjalan berdampingan di VPS `staging.quantara.software`:

| Lingkungan | URL | BE port | PM2 | BE path | FE path |
|------------|-----|---------|-----|---------|---------|
| Production | `https://quantara.software` | 3000 | `quantara` | `/opt/quantara/be` | `/var/www/quantara/fe` |
| Staging | `http://staging.quantara.software:8080` | 3001 | `quantara-staging` | `/opt/quantara-staging/be` | `/var/www/quantara-staging/fe` |

## First-time setup (sekali saja)

```bash
cd be-bot-trading
scp scripts/setup-staging-vps.sh root@staging.quantara.software:/tmp/
ssh root@staging.quantara.software 'bash /tmp/setup-staging-vps.sh'
```

Salin `.env.staging.example` → `.env` di VPS (`/opt/quantara-staging/be/.env`).

## Deploy staging

Dari mesin lokal (disarankan):

```bash
cd fe-bot-trading
git pull origin staging
export STAGING_VPS_HOST="staging.quantara.software"
./deploy-staging.sh              # FE + BE
./deploy-staging.sh --fe-only    # hanya frontend
./deploy-staging.sh --be-only    # hanya backend
```

Atau langsung di VPS:

```bash
cd /opt/quantara-staging/be
./scripts/deploy-staging-vps.sh
```

## Skrip terkait

| File | Peran |
|------|-------|
| [`fe-bot-trading/deploy-staging.sh`](../fe-bot-trading/deploy-staging.sh) | Deploy FE + BE dari lokal |
| [`scripts/deploy-staging-vps.sh`](scripts/deploy-staging-vps.sh) | Deploy BE di VPS |
| [`fe-bot-trading/nginx-staging.conf`](../fe-bot-trading/nginx-staging.conf) | Config nginx port 8080 |
