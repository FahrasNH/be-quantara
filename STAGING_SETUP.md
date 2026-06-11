# Staging Setup — Quantara

> **Panduan deploy utama:** [DEPLOY_QUICK_START.md](../DEPLOY_QUICK_START.md)

Production dan staging berjalan berdampingan di VPS `187.77.135.156`:

| Lingkungan | URL | BE port | PM2 | BE path | FE path |
|------------|-----|---------|-----|---------|---------|
| Production | `https://quantara.software` | 3000 | `quantara` | `/opt/quantara/be` | `/var/www/quantara/fe` |
| Staging | `http://187.77.135.156:8080` | 3001 | `quantara-staging` | `/opt/quantara-staging/be` | `/var/www/quantara-staging/fe` |

## First-time setup (sekali saja)

```bash
cd be-bot-trading
scp scripts/setup-staging-vps.sh root@187.77.135.156:/tmp/
ssh root@187.77.135.156 'bash /tmp/setup-staging-vps.sh'
```

Salin `.env.staging.example` → `.env` di VPS (`/opt/quantara-staging/be/.env`).

## Deploy staging

Dari mesin lokal (disarankan):

```bash
cd fe-bot-trading
git pull origin staging
export STAGING_VPS_HOST="187.77.135.156"
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
